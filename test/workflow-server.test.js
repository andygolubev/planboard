// HTTP protocol coverage for every supported host identity. These are simulated
// clients, not assertions that the native host applications are installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { serve } from "../src/server.js";

const HOSTS = ["codex", "claude", "cursor", "opencode"];
const requestKey = () => randomUUID();
function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => { const port = socket.address().port; socket.close(() => resolve(port)); });
  });
}
function configuration() {
  return { schema_version: 1, workspace: ".", sources: [],
    requirements: HOSTS.map((host) => ({ id: `REQ-${host}`, text: `Validate ${host} protocol` })),
    tasks: Object.fromEntries(HOSTS.map((host) => [host, { requirements: [`REQ-${host}`], criteria: [{ id: `AC-${host}`, text: `${host} output is verified` }], scope: [`app/${host}.txt`], outputs: ["Verified output"], checks: [`CHECK-${host}`], profile: "backend" }])),
    checks: Object.fromEntries(HOSTS.map((host) => [`CHECK-${host}`, { method: "review", required: true, criteria: [`AC-${host}`] }])) };
}
async function fixture(t, { configured = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "planboard-workflow-http-")));
  const priorHome = process.env.PLANBOARD_HOME;
  const priorState = process.env.PLANBOARD_STATE_DIR;
  process.env.PLANBOARD_HOME = path.join(dir, "home");
  delete process.env.PLANBOARD_STATE_DIR;
  const plan = path.join(dir, "PLAN.md");
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(plan, `# Workflow HTTP\n${HOSTS.map((host) => `- [ ] ${host} {#${host}}`).join("\n")}\n`);
  for (const host of HOSTS) fs.writeFileSync(path.join(dir, "app", `${host}.txt`), host);
  let server, base, key;
  const start = async () => { const port = await freePort(); server = await serve({ host: "127.0.0.1", port }); base = `http://127.0.0.1:${port}`; };
  t.after(async () => {
    await server?.close();
    if (priorHome === undefined) delete process.env.PLANBOARD_HOME; else process.env.PLANBOARD_HOME = priorHome;
    if (priorState === undefined) delete process.env.PLANBOARD_STATE_DIR; else process.env.PLANBOARD_STATE_DIR = priorState;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  const api = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, headers: response.headers };
  };
  const registered = await api("POST", "/api/boards", { path: plan });
  assert.equal(registered.status, 200); key = registered.json.key;
  const route = `/boards/${key}/api`;
  const post = (family, action, data = {}) => api("POST", `${route}/workflow/${family}/${action}`, { idempotency_key: requestKey(), ...data });
  const call = async (family, action, data = {}) => {
    const response = await post(family, action, data);
    assert.equal(response.status, 200, `${family}/${action}: ${response.text}`);
    return response.json;
  };
  if (configured) {
    const config = await call("spec", "configure", { config: configuration() });
    assert.deepEqual(config.issues, []);
  }
  return { dir, plan, key, route, api, post, call,
    register: (host) => call("worker", "register", { host, label: `Simulated ${host} client`, workspace: dir }),
    restart: async () => { await server.close(); await start(); },
    get base() { return base; } };
}
function assertPublic(value, credentials) {
  const serialized = JSON.stringify(value);
  for (const credential of credentials) assert.equal(serialized.includes(credential), false, "read response must redact credentials");
  const visit = (entry) => {
    if (!entry || typeof entry !== "object") return;
    for (const [name, child] of Object.entries(entry)) {
      assert.ok(!["token", "worker_token"].includes(name), `Unexpected credential field ${name}`);
      visit(child);
    }
  };
  visit(value);
}
async function assigned(f, host = "codex") {
  const worker = await f.register(host);
  const lease = await f.call("worker", "coordinator", { worker: worker.id, worker_token: worker.worker_token });
  const run = await f.call("run", "create", { task: host, worker: worker.id, token: lease.token });
  const claim = await f.call("worker", "claim", { run: run.id, worker: worker.id, worker_token: worker.worker_token });
  return { worker, lease, run, claim };
}

test("workflow HTTP simulates all four hosts through poll, candidate, validation, history, and restart", async (t) => {
  const f = await fixture(t);
  const workers = {};
  const secrets = [];
  for (const host of HOSTS) { workers[host] = await f.register(host); secrets.push(workers[host].worker_token); }
  let owner;
  for (const [index, host] of HOSTS.entries()) {
    const worker = workers[host];
    const lease = await f.call("worker", "coordinator", { worker: worker.id, worker_token: worker.worker_token, takeover: index > 0 });
    secrets.push(lease.token); owner = { worker: worker.id, token: lease.token };
    const note = await f.api("POST", `${f.route}/notes`, { anchor: { type: "item", item: host }, text: `Please verify ${host}` });
    assert.equal(note.status, 200);
    assert.equal((await f.api("POST", `${f.route}/send`, { ids: [note.json.note.id] })).status, 200);
    const denied = await f.api("GET", `${f.route}/poll?timeout=0.01`);
    assert.equal(denied.status, 409); assert.equal(denied.json.code, "COORDINATOR_REQUIRED");
    const poll = await f.api("GET", `${f.route}/poll?${new URLSearchParams({ worker: owner.worker, token: owner.token, timeout: "0.1" })}`);
    assert.equal(poll.status, 200); assert.equal(poll.json.status, "feedback");
    assert.equal(poll.json.notes[0].id, note.json.note.id);
    const run = await f.call("run", "create", { task: host, instruction: note.json.note.id, ...owner });
    const claim = await f.call("worker", "claim", { run: run.id, worker: worker.id, worker_token: worker.worker_token });
    secrets.push(claim.token);
    const candidate = await f.call("run", "submit", { attempt: claim.id, token: claim.token, summary: `${host} candidate` });
    assert.equal(candidate.jobs.length, 1);
    const reviewer = workers[HOSTS[(index + 1) % HOSTS.length]];
    const started = await f.call("validate", "start", { job: candidate.jobs[0].id, worker: reviewer.id, worker_token: reviewer.worker_token });
    secrets.push(started.token);
    const checked = await f.call("validate", "result", { job: started.job.id, token: started.token, outcome: "passed", evidence: [{ name: `${host}.txt`, text: `Reviewed ${host}` }], criteria: [{ id: `AC-${host}`, outcome: "passed" }] });
    assert.equal(checked.gate.acceptance, "accepted");
    const evidence = await f.api("GET", `${f.route}/workflow/evidence/${checked.result.evidence[0].id}`);
    assert.equal(evidence.status, 200); assert.equal(evidence.text, `Reviewed ${host}`);
    assert.equal(evidence.headers.get("x-content-type-options"), "nosniff");
    assert.match(evidence.headers.get("content-security-policy"), /sandbox/);
    assert.match(evidence.headers.get("content-disposition"), /attachment/);
  }
  const history = await f.api("GET", `${f.route}/workflow/history?limit=2`);
  assert.equal(history.json.events.length, 2); assert.ok(history.json.next_cursor);
  const next = await f.api("GET", `${f.route}/workflow/history?limit=2&cursor=${history.json.next_cursor}`);
  assert.ok(next.json.events.every((event) => event.sequence < history.json.next_cursor));
  const byTask = await f.api("GET", `${f.route}/workflow/history?task=claude`);
  assert.ok(byTask.json.events.length >= 4);
  assert.ok(byTask.json.events.every((event) => event.task === "claude" || event.detail?.task === "claude" || event.detail?.result?.task === "claude"));
  const byRequirement = await f.api("GET", `${f.route}/workflow/history?requirement=REQ-claude`);
  assert.ok(byRequirement.json.events.length >= 4, "requirement filter follows task requirement links");
  assert.ok(byRequirement.json.events.every((event) => event.requirements?.includes("REQ-claude") || event.requirement === "REQ-claude"));
  assert.equal((await f.api("GET", `${f.route}/workflow/history?requirement=REQ-absent`)).json.events.length, 0);
  for (const endpoint of ["/state", "/workflow", "/workflow/history", "/workflow/resume", "/workflow/compare?from=0"]) {
    const read = await f.api("GET", `${f.route}${endpoint}`); assert.equal(read.status, 200); assertPublic(read.json, secrets);
  }
  const exported = await f.api("GET", `${f.route}/export?format=json&download`);
  assert.equal(exported.status, 200); assertPublic(exported.json, secrets);
  assert.equal(exported.json.plan.source, fs.readFileSync(f.plan, "utf8"));
  assert.ok(exported.json.workflow.events.length > 25);
  assert.equal(exported.json.workflow.events[0].sequence, 1);
  assert.match(exported.headers.get("content-disposition"), /\.json/);
  const markdown = await f.api("GET", `${f.route}/export`);
  assert.equal(markdown.status, 200);
  for (const credential of secrets) assert.equal(markdown.text.includes(credential), false);
  assert.ok(markdown.text.includes(exported.json.workflow.events[0].type));
  const pendingRun = await f.call("run", "create", { task: "codex", ...owner });
  const pending = await f.call("worker", "claim", { run: pendingRun.id, worker: workers.codex.id, worker_token: workers.codex.worker_token });
  await f.restart();
  const resume = await f.api("GET", `${f.route}/workflow/resume`);
  assert.equal(resume.status, 200); assert.equal(resume.json.validated.length, 3);
  assert.ok(resume.json.incomplete.some((entry) => entry.id === "codex"));
  assert.ok(resume.json.freshness.unconfirmed_attempts.includes(pending.id));
  assert.equal((await f.post("run", "submit", { attempt: pending.id, token: pending.token })).json.code, "UNCONFIRMED");
  assert.equal((await f.api("GET", `${f.route}/poll?${new URLSearchParams({ ...owner, timeout: "0.01" })}`)).json.code, "COORDINATOR_REQUIRED");
  await f.call("worker", "coordinator-heartbeat", owner);
  await f.call("worker", "heartbeat", { attempt: pending.id, token: pending.token });
  const resumed = await f.call("run", "submit", { attempt: pending.id, token: pending.token });
  assert.equal(resumed.artifact.task, "codex");
  assert.ok((await f.api("GET", `${f.route}/workflow/history?limit=200`)).json.events.some((event) => event.type === "runtime.restarted"));
});

test("workflow HTTP atomically resolves competing claims and exposes actionable conflict codes", async (t) => {
  const f = await fixture(t, { configured: false });
  assert.equal((await f.post("worker", "register", { host: "codex", label: "Before configuration" })).json.code, "NOT_CONFIGURED");
  await f.call("spec", "configure", { config: configuration() });
  const first = await f.register("codex"), second = await f.register("claude");
  const lease = await f.call("worker", "coordinator", { worker: first.id, worker_token: first.worker_token });
  const run = await f.call("run", "create", { task: "codex", worker: first.id, token: lease.token });
  const competing = await Promise.all([first, second].map((worker) => f.post("worker", "claim", { run: run.id, worker: worker.id, worker_token: worker.worker_token })));
  assert.deepEqual(competing.map((response) => response.status).sort(), [200, 409]);
  assert.equal(competing.find((response) => response.status === 409).json.code, "RUN_UNAVAILABLE");
  const winner = competing.find((response) => response.status === 200).json;
  const wrongCredential = await f.post("worker", "coordinator", { worker: second.id, worker_token: "wrong" });
  assert.equal(wrongCredential.status, 409); assert.equal(wrongCredential.json.code, "WORKER_TOKEN");
  const stale = await f.post("run", "submit", { attempt: winner.id, token: "wrong" });
  assert.equal(stale.status, 409); assert.equal(stale.json.code, "STALE_ATTEMPT");
  const revision = await f.post("spec", "refresh", { expected_revision: 0 });
  assert.equal(revision.status, 409); assert.equal(revision.json.code, "REVISION_CONFLICT");
  const request = { idempotency_key: requestKey(), host: "cursor", label: "One request", workspace: f.dir };
  const once = await f.call("worker", "register", request);
  assert.equal((await f.call("worker", "register", request)).id, once.id);
  const duplicate = await f.post("worker", "register", { ...request, label: "Changed request" });
  assert.equal(duplicate.status, 409); assert.equal(duplicate.json.code, "IDEMPOTENCY_CONFLICT");
  const unknown = await f.post("unknown", "action");
  assert.equal(unknown.status, 404); assert.equal(unknown.json.code, "NOT_FOUND");
  const missingKey = await f.api("POST", `${f.route}/workflow/worker/register`, { host: "codex", label: "Missing key" });
  assert.equal(missingKey.status, 400); assert.equal(missingKey.json.code, "INVALID");
});

test("workflow HTTP evidence and generic assets cannot expose journals or symlink aliases", async (t) => {
  const f = await fixture(t);
  const { claim } = await assigned(f);
  const candidate = await f.call("run", "submit", { attempt: claim.id, token: claim.token, evidence: [{ name: 'unsafe\r\n"/name.txt', text: "Candidate evidence" }] });
  const evidenceId = candidate.artifact.evidence[0].id;
  const unknown = await f.api("GET", `${f.route}/workflow/evidence/${"0".repeat(64)}`);
  assert.equal(unknown.status, 404); assert.equal(unknown.json.code, "NOT_FOUND");
  const invalid = await f.api("GET", `${f.route}/workflow/evidence/..%2Fjournal.jsonl`);
  assert.equal(invalid.status, 400); assert.equal(invalid.json.code, "INVALID");
  const journal = path.join(f.dir, "PLAN.board/workflow/journal.jsonl");
  for (const [alias, target] of [["journal-alias.txt", journal], ["state-alias", path.dirname(journal)]]) fs.symlinkSync(target, path.join(f.dir, alias));
  for (const asset of ["PLAN.board/workflow/journal.jsonl", "journal-alias.txt", "state-alias/journal.jsonl"]) {
    const denied = await f.api("GET", `/boards/${f.key}/asset/${asset}`);
    assert.equal(denied.status, 403); assert.equal(denied.text.includes(claim.token), false);
  }
  const evidence = await f.api("GET", `${f.route}/workflow/evidence/${evidenceId}`);
  assert.equal(evidence.status, 200); assert.equal(evidence.text, "Candidate evidence");
  assert.doesNotMatch(evidence.headers.get("content-disposition"), /\r|\n/);
  const evidencePath = path.join(f.dir, "PLAN.board/workflow/evidence", evidenceId);
  fs.unlinkSync(evidencePath);
  const missing = await f.api("GET", `${f.route}/workflow/evidence/${evidenceId}`);
  assert.equal(missing.status, 404, "missing recorded evidence is a missing resource");
  fs.symlinkSync(journal, evidencePath);
  const escaping = await f.api("GET", `${f.route}/workflow/evidence/${evidenceId}`);
  assert.notEqual(escaping.status, 200); assert.equal(escaping.text.includes(claim.token), false);
});
