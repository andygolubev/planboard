import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../src/cli.js";
import { executeCheck, keepalive, workflowBody, workflowCommand, workflowMarkdown } from "../src/workflow-cli.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-cli-workflow-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function harness(responses) {
  const calls = [], output = [];
  return { calls, output, dependencies: {
    ctx: { host: "127.0.0.1", port: 4747 },
    ensureBoard: async (plan, ctx) => { calls.push({ board: plan, ctx }); return { api: "http://localhost/boards/example/api" }; },
    request: async (method, url, body) => {
      calls.push({ method, url, body });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected ${method} ${url}`);
      return next.status ? next : { status: 200, json: next };
    },
    printJson: (value) => output.push(value), out: (value) => output.push(value),
  } };
}
function runningJob(id, worker, overrides = {}) {
  return { id, worker, artifact: "candidate", check: "check-1", phase: "running", confirmed: true, expires_at: new Date(Date.now() + 300000).toISOString(), ...overrides };
}

test("workflow bodies preserve JSON data and require caller-owned retry keys", (t) => {
  const dir = fixture(t), file = path.join(dir, "result.json");
  fs.writeFileSync(file, JSON.stringify({ job: "job_1", evidence: [{ name: "review", text: "reviewed" }] }));
  const body = workflowBody({ file, key: "review-1", "expected-revision": "4", "worker-token": "private", criteria: '[{"id":"AC-1","outcome":"passed"}]' });
  assert.equal(body.job, "job_1");
  assert.equal(body.idempotency_key, "review-1");
  assert.equal(body.expected_revision, 4);
  assert.equal(body.worker_token, "private");
  assert.deepEqual(body.evidence, [{ name: "review", text: "reviewed" }]);
  assert.deepEqual(body.criteria, [{ id: "AC-1", outcome: "passed" }]);
  assert.throws(() => workflowBody({}), /require --key/);
  assert.throws(() => workflowBody({ key: "a", "expected-revision": "1.5" }), /integer/);
  assert.throws(() => workflowBody({ key: "a", criteria: "bad" }), /valid JSON/);
});

test("flag parser keeps boolean workflow options from eating the plan or action", () => {
  assert.deepEqual(parseArgs(["worker", "PLAN.md", "keepalive", "--coordinator", "--worker", "w", "--key", "k"]), {
    flags: { coordinator: true, worker: "w", key: "k" }, positional: ["worker", "PLAN.md", "keepalive"],
  });
});

test("spec init configures through the server; unkeyed writes fail before opening a board", async () => {
  const h = harness([{ enabled: true }]);
  await assert.rejects(workflowCommand("spec", "PLAN.md", {}, ["init"], h.dependencies), /require --key/);
  assert.equal(h.calls.length, 0);
  await workflowCommand("spec", "PLAN.md", { key: "setup-1" }, ["init"], h.dependencies);
  assert.equal(h.calls[1].url, "http://localhost/boards/example/api/workflow/spec/configure");
  assert.deepEqual(h.calls[1].body.config, { schema_version: 1, workspace: ".", sources: [], tasks: {}, checks: {} });
  assert.equal(h.calls[1].body.idempotency_key, "setup-1");
});

test("registration forwards host identity without executing anything locally", async () => {
  const h = harness([{ id: "worker-1", worker_token: "credential" }]);
  await workflowCommand("worker", "PLAN.md", { host: "codex", label: "Implementer", workspace: "/tmp/project", capabilities: "implement,validate", key: "register-1" }, ["register"], h.dependencies);
  assert.equal(h.calls[1].body.host, "codex");
  assert.deepEqual(h.calls[1].body.capabilities, ["implement", "validate"]);
  assert.equal(h.output[0].id, "worker-1");
});

test("read commands filter state and encode recovery/history filters", async () => {
  const h = harness([{ enabled: true, revision: 7, workers: { w: { id: "w" } }, tasks: [], results: {} }, { events: [], next_cursor: 8 }]);
  await workflowCommand("worker", "PLAN.md", {}, [], h.dependencies);
  assert.deepEqual(h.output[0], { enabled: true, revision: 7, workers: { w: { id: "w" } } });
  await workflowCommand("history", "PLAN.md", { task: "auth & profile", cursor: "4", limit: "10", format: "markdown" }, [], h.dependencies);
  const url = new URL(h.calls[3].url);
  assert.equal(url.searchParams.get("task"), "auth & profile");
  assert.equal(url.searchParams.get("cursor"), "4");
  assert.match(h.output[1], /Next cursor: 8/);
  assert.ok(h.calls.filter((call) => call.method).every((call) => call.method === "GET"));
});

test("server conflicts are visible and never retried silently", async () => {
  const h = harness([{ status: 409, json: { error: "Lease expired", code: "LEASE_EXPIRED" } }]);
  await assert.rejects(workflowCommand("run", "PLAN.md", { key: "submit", attempt: "a", token: "secret" }, ["submit"], h.dependencies), (error) => {
    assert.equal(error.exitCode, 3); assert.equal(error.code, "LEASE_EXPIRED");
    assert.doesNotMatch(error.message, /secret/); return true;
  });
  assert.equal(h.calls.length, 2);
});

test("runner passes arguments literally without a shell and captures evidence", async (t) => {
  const workspace = fixture(t), marker = path.join(workspace, "should-not-exist");
  const literal = `$(touch ${marker}); echo bad`;
  const result = await executeCheck({ command: { executable: process.execPath, args: ["-e", "process.stdout.write(process.argv[1]);process.stderr.write('diagnostic')", literal], cwd: ".", timeout_ms: 10000 } }, { workspace });
  assert.equal(result.outcome, "passed");
  assert.equal(result.stdout, literal);
  assert.equal(result.stderr, "diagnostic");
  assert.equal(fs.existsSync(marker), false);
});

test("runner distinguishes assertion failures, environment failures and timeouts", async (t) => {
  const workspace = fixture(t);
  const command = (executable, args, timeout_ms = 10000) => ({ command: { executable, args, timeout_ms } });
  const failure = await executeCheck(command(process.execPath, ["-e", "process.exit(2)"]), { workspace });
  assert.equal(failure.outcome, "failed"); assert.equal(failure.exit_code, 2);
  const missing = await executeCheck(command(path.join(workspace, "missing-binary"), []), { workspace });
  assert.equal(missing.outcome, "error"); assert.equal(missing.error, "ENOENT");
  const timeout = await executeCheck(command(process.execPath, ["-e", "setInterval(()=>{},1000)"], 20), { workspace });
  assert.equal(timeout.outcome, "error"); assert.equal(timeout.error, "timeout");
  const budgetTimeout = await executeCheck({ ...command(process.execPath, ["-e", "setInterval(()=>{},1000)"]), evaluation: { budget: { timeout_ms: 20 } } }, { workspace });
  assert.equal(budgetTimeout.error, "timeout");
});

test("runner bounds both output streams and refuses workspace escapes", async (t) => {
  const workspace = fixture(t);
  const result = await executeCheck({ command: { executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(10000));process.stderr.write('y'.repeat(10000))"] } }, { workspace, outputLimit: 1024 });
  assert.equal(result.stdout.length, 1024); assert.equal(result.stderr.length, 1024);
  assert.deepEqual(result.truncated, { stdout: true, stderr: true });
  assert.throws(() => executeCheck({ command: { executable: process.execPath, args: [], cwd: ".." } }, { workspace }), /inside/);
  fs.symlinkSync(path.dirname(workspace), path.join(workspace, "outside"));
  assert.throws(() => executeCheck({ command: { executable: process.execPath, args: [], cwd: "outside" } }, { workspace }), /outside/);
});

test("named job runner starts and submits bound command evidence", async (t) => {
  const workspace = fixture(t);
  const job = runningJob("j1", "w1");
  const h = harness([
    { results: {}, jobs: { j1: { id: "j1", phase: "queued" } } },
    { job: { ...job, token: "job-secret" }, check: { method: "command", criteria: ["AC-1"], command: { executable: process.execPath, args: ["-e", "console.log('verified')"] } }, workspace },
    { jobs: { j1: job } },
    job,
    { id: "result-1", outcome: "passed" },
  ]);
  await workflowCommand("validate", "PLAN.md", { key: "runner-1", job: "j1", worker: "w1", "worker-token": "worker-secret" }, ["run"], h.dependencies);
  const mutations = h.calls.filter((call) => call.method === "POST");
  assert.equal(mutations[0].body.idempotency_key, "runner-1:start");
  assert.ok(mutations[0].body.execution_id);
  assert.match(mutations[1].body.idempotency_key, /^runner-1:execute:/);
  assert.equal(mutations[1].body.token, "job-secret");
  assert.equal(mutations[2].body.idempotency_key, "runner-1:result");
  assert.equal(mutations[2].body.outcome, "passed");
  assert.deepEqual(mutations[2].body.criteria, [{ id: "AC-1", outcome: "passed", reference: "stdout.txt" }]);
  assert.match(mutations[2].body.evidence[0].text, /verified/);
  assert.equal(h.output[0].id, "result-1");
});

test("evaluation JSON is preserved, and invalid stdout cannot become a pass", async (t) => {
  const workspace = fixture(t);
  for (const valid of [true, false]) {
    const report = { trials: [{ scenario: "holdout-1", trial: 1, retry: 0, outcome: "passed" }], calibration: [{ id: "example-1", outcome: "passed" }] };
    const job = runningJob("j", "w");
    const h = harness([
      { results: {}, jobs: { j: { id: "j", phase: "queued" } } },
      { job: { ...job, token: "private" }, workspace, check: { method: "evaluation", criteria: ["AC-1"], command: { executable: process.execPath, args: ["-e", `console.log(${JSON.stringify(valid ? JSON.stringify(report) : "unstructured success")})`] } } },
      { jobs: { j: job } },
      job,
      { outcome: valid ? "passed" : "error" },
    ]);
    await workflowCommand("eval", "PLAN.md", { key: "eval-1", job: "j", worker: "w", "worker-token": "private" }, ["run"], h.dependencies);
    const submitted = h.calls.at(-1).body;
    assert.equal(submitted.outcome, valid ? "passed" : "error");
    assert.deepEqual(submitted.trials, valid ? report.trials : []);
    assert.deepEqual(submitted.calibration, valid ? report.calibration : []);
  }
});

test("runner refuses unknown prior execution, expired/reassigned leases and stale start tokens before spawning", async (t) => {
  const workspace = fixture(t), marker = path.join(workspace, "execution-marker");
  const job = runningJob("j", "w");
  const started = { job: { ...job, token: "old-token" }, workspace, check: { method: "command", command: { executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`] } } };
  const flags = { key: "check-retry", job: "j", worker: "w", "worker-token": "worker-token" };
  const unknown = harness([{ results: {}, jobs: { j: job } }]);
  await assert.rejects(workflowCommand("validate", "PLAN.md", flags, ["run"], unknown.dependencies), /prior execution/);
  assert.equal(unknown.calls.filter((call) => call.method === "POST").length, 0);
  for (const changed of [{ worker: "someone-else" }, { confirmed: false }, { expires_at: "2000-01-01T00:00:00.000Z" }, { phase: "interrupted" }]) {
    const h = harness([{ results: {}, jobs: { j: { id: "j", phase: "queued" } } }, started, { jobs: { j: { ...job, ...changed } } }]);
    await assert.rejects(workflowCommand("validate", "PLAN.md", flags, ["run"], h.dependencies), /lease changed/);
  }
  const fenced = harness([
    { results: {}, jobs: { j: { id: "j", phase: "queued" } } }, started, { jobs: { j: job } },
    { status: 409, json: { error: "Validation lease is expired or superseded", code: "STALE_CHECK" } },
  ]);
  await assert.rejects(workflowCommand("validate", "PLAN.md", flags, ["run"], fenced.dependencies), /superseded/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fenced.calls.at(-1).url.endsWith("/heartbeat"), true);
});

test("concurrent runner invocations cannot use identical start receipts", async () => {
  const identities = [];
  for (let i = 0; i < 2; i++) {
    const h = harness([{ results: {}, jobs: { j: { id: "j", phase: "queued" } } }, { status: 409, json: { error: "Idempotency conflict", code: "IDEMPOTENCY_CONFLICT" } }]);
    await assert.rejects(workflowCommand("validate", "PLAN.md", { key: "same", job: "j", worker: "w", "worker-token": "token" }, ["run"], h.dependencies), /Idempotency conflict/);
    identities.push(h.calls.at(-1).body.execution_id);
  }
  assert.notEqual(identities[0], identities[1]);
});

test("already recorded jobs do not execute a command again", async () => {
  const result = { id: "r", job: "j", outcome: "passed" };
  const h = harness([{ results: { r: result } }]);
  await workflowCommand("validate", "PLAN.md", { key: "repeat", job: "j", worker: "w", "worker-token": "private" }, ["run"], h.dependencies);
  assert.deepEqual(h.output[0], { result, already_recorded: true });
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 0);
});

test("keepalive is bounded by parent lifetime, explicit deadline and invalid leases", async () => {
  let current = 0, calls = 0;
  const args = { parentPid: 10, intervalMs: 10, maxDurationMs: 25, now: () => current, sleep: async (ms) => { current += ms; }, heartbeat: async () => { calls++; }, isAlive: () => true };
  assert.deepEqual(await keepalive(args), { stopped: "max_duration", renewals: 3 });
  assert.equal(calls, 3);
  calls = 0; current = 0;
  assert.deepEqual(await keepalive({ ...args, isAlive: () => calls < 1 }), { stopped: "parent_exited", renewals: 1 });
  await assert.rejects(keepalive({ ...args, heartbeat: async () => { throw new Error("lease expired"); } }), /lease expired/);
  await assert.rejects(keepalive({ ...args, parentPid: undefined }), /parent-pid/);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await keepalive({ ...args, signal: controller.signal }), { stopped: "signal", renewals: 0 });
});

test("new keepalive invocations use fresh receipt keys and reject expired heartbeat responses", async () => {
  const keys = [];
  for (let i = 0; i < 2; i++) {
    const h = harness([{ expires_at: "2000-01-01T00:00:00.000Z" }]);
    await assert.rejects(workflowCommand("worker", "PLAN.md", { key: "alive", "parent-pid": String(process.pid), attempt: "a", token: "private" }, ["keepalive"], h.dependencies), /current lease/);
    keys.push(h.calls.at(-1).body.idempotency_key);
    assert.equal(h.output.length, 0);
  }
  assert.notEqual(keys[0], keys[1]);
});

test("explicit OpenSpec reconciliation claims an execution before literal native archive and retains evidence", async (t) => {
  const workspace = fixture(t), execution = [];
  const h = harness([
    { config: { openspec: "docs/openspec" }, specs: { workspace }, accepted_changes: { "add-widget": { phase: "ready_to_reconcile" } } },
    { change: "add-widget", phase: "reconciling", token: "reconcile-token" },
    { revision: 12 },
    { change: "add-widget", phase: "reconciled" },
  ]);
  h.dependencies.execute = async (check, options) => {
    assert.equal(h.calls.at(-1).url.endsWith("/spec/reconciliation-start"), true);
    execution.push({ check, workspace: options.workspace });
    return { outcome: "passed", exit_code: 0, duration_ms: 18, stdout: "Specs updated; change archived", stderr: "" };
  };
  await workflowCommand("spec", "PLAN.md", { change: "add-widget", key: "archive-1" }, ["reconcile"], h.dependencies);
  assert.deepEqual(execution, [{ check: { command: { executable: "openspec", args: ["archive", "add-widget", "--yes"], cwd: "docs", timeout_ms: 300000 } }, workspace }]);
  assert.equal(h.calls[2].body.idempotency_key, "archive-1:start");
  assert.ok(h.calls[2].body.execution_id);
  const final = h.calls.at(-1);
  assert.equal(final.url.endsWith("/spec/reconciled"), true);
  assert.equal(final.body.token, "reconcile-token");
  assert.equal(final.body.operation_key, "archive-1");
  assert.equal(final.body.outcome, "passed");
  assert.match(final.body.evidence[0].text, /change archived/);
  assert.deepEqual(h.output, [{ change: "add-widget", phase: "reconciled" }]);
});

test("failed native reconciliation records diagnostics, including a failed refresh", async (t) => {
  const workspace = fixture(t);
  const h = harness([
    { config: { openspec: "openspec" }, specs: { workspace }, accepted_changes: { x: { phase: "ready_to_reconcile" } } },
    { token: "reconcile-token" },
    { status: 409, json: { error: "Invalid new sources", code: "WORKFLOW_ERROR" } },
    { phase: "ready_to_reconcile", attempts: [{ outcome: "error" }] },
  ]);
  h.dependencies.execute = async () => ({ outcome: "error", error: "ENOENT", stdout: "", stderr: "OpenSpec is not installed" });
  await assert.rejects(workflowCommand("spec", "PLAN.md", { change: "x", key: "archive-failed" }, ["reconcile"], h.dependencies), /command evidence was recorded/);
  const final = h.calls.at(-1).body;
  assert.equal(final.outcome, "error");
  assert.match(final.evidence[1].text, /not installed/);
  assert.match(final.summary, /Invalid new sources/);
  assert.equal(h.output[0].phase, "ready_to_reconcile");
});

test("manual and custom-directory reconciliation never guesses a native command target", async () => {
  for (const openspec of [undefined, "custom-spec-root"]) {
    const h = harness([{ config: { openspec }, accepted_changes: { x: { phase: "ready_to_reconcile" } } }]);
    h.dependencies.execute = async () => { throw new Error("must not execute"); };
    await workflowCommand("spec", "PLAN.md", { change: "x", key: "manual" }, ["reconcile"], h.dependencies);
    assert.equal(h.output[0].automatic, false);
    assert.match(h.output[0].next_step, /manually/);
    assert.match(h.output[0].next_step, /reconciled --change x/);
    assert.equal(h.calls.filter((call) => call.method === "POST").length, 0);
  }
});

test("unaccepted, repeated and concurrent native reconciliations do not execute", async () => {
  for (const accepted of [undefined, { phase: "reconciling" }, { phase: "ready_to_reconcile", attempts: [{ operation_key: "archive" }] }]) {
    const h = harness([{ config: { openspec: "openspec" }, accepted_changes: { x: accepted } }]);
    h.dependencies.execute = async () => { throw new Error("must not execute"); };
    await assert.rejects(workflowCommand("spec", "PLAN.md", { change: "x", key: "archive" }, ["reconcile"], h.dependencies), /ready_to_reconcile|already ran/);
    assert.equal(h.calls.filter((call) => call.method === "POST").length, 0);
  }
  const h = harness([
    { config: { openspec: "openspec" }, accepted_changes: { x: { phase: "ready_to_reconcile" } } },
    { status: 409, json: { error: "Already reconciling", code: "RECONCILIATION_ACTIVE" } },
  ]);
  h.dependencies.execute = async () => { throw new Error("must not execute"); };
  await assert.rejects(workflowCommand("spec", "PLAN.md", { change: "x", key: "archive" }, ["reconcile"], h.dependencies), /Already reconciling/);
});

test("Markdown recovery output retains all brief fields", () => {
  const brief = { revision: 10, blockers: ["missing upstream acceptance"], repair: { task: "auth" } };
  const rendered = workflowMarkdown(brief, "Resume");
  assert.match(rendered, /# Resume/);
  assert.match(rendered, /missing upstream acceptance/);
  assert.match(rendered, /"task": "auth"/);
});
