import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Board } from "../src/board.js";
import { uid } from "../src/workflow-schema.js";

function config() {
  return { schema_version: 1, workspace: ".", objective: "Deliver a validated change", sources: [], requirements: [{ id: "REQ-1", text: "Combined output works", scenarios: [{ id: "SC-1", text: "Changes work together" }] }],
    tasks: Object.fromEntries(["backend", "ui", "integration"].map((id) => [id, { requirements: ["REQ-1"], criteria: [{ id: `AC-${id}`, text: `${id} works` }], depends_on: id === "integration" ? ["backend", "ui"] : [], integration_of: id === "integration" ? ["backend", "ui"] : [], scope: [id === "integration" ? "app" : `app/${id}.txt`], checks: [`CHECK-${id}`], outputs: ["patch"] }])),
    checks: Object.fromEntries(["backend", "ui", "integration"].map((id) => [`CHECK-${id}`, { method: "manual", required: true, criteria: [`AC-${id}`] }])) };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-workflow-"));
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app/backend.txt"), "backend"); fs.writeFileSync(path.join(dir, "app/ui.txt"), "ui");
  const file = path.join(dir, "PLAN.md");
  fs.writeFileSync(file, "# Workflow {#plan}\n\n- [ ] Backend {#backend}\n- [ ] UI {#ui}\n- [ ] Integration {#integration}\n");
  let board = new Board(file); board.refresh();
  t.after(async () => { await board.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (family, action, data = {}) => board.workflow.mutate(family, action, { idempotency_key: uid("request"), ...data });
  call("spec", "configure", { config: config() });
  assert.deepEqual(board.workflow.state.specs.issues, []);
  const worker = (label = "worker", host = "codex") => call("worker", "register", { host, label, workspace: dir });
  const coordinator = worker("coordinator");
  const lease = call("worker", "coordinator", { worker: coordinator.id, worker_token: coordinator.worker_token });
  const owner = { worker: coordinator.id, token: lease.token };
  return { dir, file, call, worker, owner, get board() { return board; }, restart: async () => { await board.close(); board = new Board(file); board.refresh(); } };
}
function assignment(f, task, worker) {
  const run = f.call("run", "create", { task, ...f.owner });
  const claim = f.call("worker", "claim", { run: run.id, worker: worker.id, worker_token: worker.worker_token });
  return { run, claim };
}
function submit(f, claim) { return f.call("run", "submit", { attempt: claim.id, token: claim.token, summary: "Candidate" }); }
function check(f, job, worker, outcome = "passed") {
  const started = f.call("validate", "start", { job: job.id, worker: worker.id, worker_token: worker.worker_token });
  return f.call("validate", "result", { job: job.id, token: started.token, outcome, evidence: [{ name: "check.txt", text: `Observed ${outcome}` }], criteria: [{ id: `AC-${job.task}`, outcome, reference: "check.txt" }] });
}

test("two workers, failed integration, repair, restart, and stale result rejection", async (t) => {
  const f = fixture(t); const one = f.worker("backend", "claude"); const two = f.worker("ui", "cursor"); const reviewer = f.worker("reviewer", "opencode");
  const a = assignment(f, "backend", one); const b = assignment(f, "ui", two);
  const early = f.call("run", "create", { task: "integration", ...f.owner });
  assert.throws(() => f.call("worker", "claim", { run: early.id, worker: one.id, worker_token: one.worker_token }), /Waiting for validated/);
  const ar = submit(f, a.claim); const br = submit(f, b.claim);
  assert.equal(check(f, ar.jobs[0], reviewer).gate.acceptance, "accepted");
  assert.equal(check(f, br.jobs[0], reviewer).gate.acceptance, "accepted");
  const combined = f.call("run", "integrate", { task: "integration", artifacts: [ar.artifact.id, br.artifact.id], ...f.owner });
  const failed = check(f, combined.jobs[0], reviewer, "failed");
  assert.equal(failed.gate.acceptance, "pending");
  f.call("run", "cancel", { run: early.id, ...f.owner });
  const repair = f.call("run", "create", { task: "integration", repair_of: failed.result.id, ...f.owner });
  const claim = f.call("worker", "claim", { run: repair.id, worker: one.id, worker_token: one.worker_token });
  const repaired = f.call("run", "submit", { attempt: claim.id, token: claim.token, integrated: [ar.artifact.id, br.artifact.id] });
  assert.equal(check(f, repaired.jobs[0], reviewer).gate.acceptance, "accepted");
  await f.restart();
  const brief = f.board.workflow.resume();
  assert.equal(brief.validated.length, 3);
  assert.equal(brief.incomplete.length, 0);
  assert.ok(f.board.workflow.history().events.some((e) => e.type === "runtime.restarted"));
  assert.throws(() => submit(f, claim), /expired or superseded/);
  fs.writeFileSync(path.join(f.dir, "app/backend.txt"), "edited after validation");
  const changed = f.board.workflow.publicState();
  assert.equal(changed.tasks.find((x) => x.id === "backend").acceptance, "stale");
  assert.equal(changed.tasks.find((x) => x.id === "integration").acceptance, "stale");
});

test("deduplicates instructions, claims, conflicting scopes and fences released/restarted workers", async (t) => {
  const f = fixture(t); const worker = f.worker();
  const note = f.board.addNote({ text: "Implement backend", anchor: { type: "item", item: "backend" } }); f.board.send([note.id]);
  const run = f.call("run", "create", { task: "backend", instruction: note.id, ...f.owner });
  assert.equal(f.call("run", "create", { task: "backend", instruction: note.id, ...f.owner }).id, run.id);
  const payload = { run: run.id, worker: worker.id, worker_token: worker.worker_token, idempotency_key: "claim-once" };
  const claim = f.call("worker", "claim", payload);
  assert.equal(f.call("worker", "claim", payload).id, claim.id);
  assert.throws(() => f.call("worker", "claim", { ...payload, idempotency_key: "claim-twice" }), /Run is running/);
  await f.restart();
  assert.throws(() => submit(f, claim), /Renew the attempt/);
  f.call("worker", "heartbeat", { attempt: claim.id, token: claim.token });
  f.call("worker", "release", { attempt: claim.id, token: claim.token });
  const replacement = f.call("worker", "claim", { ...payload, idempotency_key: "replacement" });
  assert.equal(replacement.number, 2);
  assert.throws(() => submit(f, claim), /expired or superseded/);
  const publicState = JSON.stringify(f.board.workflow.publicState());
  assert.ok(!publicState.includes(replacement.token));
  assert.ok(!JSON.stringify(f.board.workflow.history()).includes(worker.worker_token));
  assert.ok(f.board.workflow.compare(0).changes.length > 0);
});

test("strict gate, per-criterion manual evidence, and requirement invalidation", (t) => {
  const f = fixture(t); const worker = f.worker(); const reviewer = f.worker("review");
  const { claim } = assignment(f, "backend", worker); const candidate = submit(f, claim);
  f.board.setStatus("backend", "done");
  assert.equal(f.board.workflow.publicState().tasks[0].acceptance, "pending");
  const started = f.call("validate", "start", { job: candidate.jobs[0].id, worker: reviewer.id, worker_token: reviewer.worker_token });
  assert.throws(() => f.call("validate", "result", { job: started.job.id, token: started.token, outcome: "passed" }), /supporting evidence/);
  const result = f.call("validate", "result", { job: started.job.id, token: started.token, outcome: "passed", evidence: [{ name: "review.txt", text: "verified" }], criteria: [{ id: "AC-backend", outcome: "passed" }] });
  assert.equal(result.gate.acceptance, "accepted");
  const next = config(); next.requirements[0].text = "Changed requirement";
  f.call("spec", "configure", { config: next });
  assert.equal(f.board.workflow.publicState().tasks[0].acceptance, "stale");
  const ev = f.board.workflow.evidence(result.result.evidence[0].id);
  assert.equal(fs.readFileSync(ev.path, "utf8"), "verified");
  assert.throws(() => f.board.workflow.evidence("../outside"), /Invalid evidence/);
});

test("expired leases and coordinator takeover prevent obsolete writes", (t) => {
  const f = fixture(t); const worker = f.worker(); const { claim } = assignment(f, "backend", worker);
  f.board.workflow.store.transaction({ type: "test.clock" }, (s) => { s.attempts[claim.id].expires_at = new Date(0).toISOString(); });
  f.board.workflow.reconcile();
  assert.equal(f.board.workflow.state.attempts[claim.id].phase, "interrupted");
  assert.throws(() => submit(f, claim), /expired or superseded/);
  const other = f.worker("next coordinator");
  assert.throws(() => f.call("worker", "coordinator", { worker: other.id, worker_token: other.worker_token }), /Another coordinator/);
  f.call("worker", "coordinator", { worker: other.id, worker_token: other.worker_token, takeover: true });
  assert.throws(() => f.call("run", "create", { task: "ui", ...f.owner }), /confirmed coordinator/);
});
