// Workflow commands use the server as the only writer. Runners execute an
// explicitly configured argv locally; the board never runs a command itself.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const WORKFLOW_COMMANDS = new Set(["spec", "worker", "run", "validate", "eval", "history", "resume", "compare"]);
const ACTIONS = {
  spec: ["init", "configure", "refresh", "accept", "reconcile", "reconciled"],
  worker: ["register", "claim", "heartbeat", "release", "coordinator", "coordinator-heartbeat", "coordinator-release", "keepalive"],
  run: ["create", "cancel", "dispatch", "submit", "integrate"],
  validate: ["enqueue", "start", "heartbeat", "result", "run"],
  eval: ["enqueue", "start", "heartbeat", "result", "run"],
};
const READ_FIELDS = {
  spec: ["config", "specs", "accepted_changes"], worker: ["workers", "coordinator", "attempts"],
  run: ["runs", "attempts", "artifacts", "tasks"], validate: ["jobs", "results", "tasks"], eval: ["jobs", "results", "evaluations", "tasks"],
};
const STRINGS = ["worker", "worker-token", "attempt", "token", "run", "task", "instruction", "label", "workspace", "session-id", "host-session-id", "reason", "summary", "change", "repair-of", "phase", "artifact", "check", "job", "outcome", "handoff"];
const JSON_FLAGS = ["reconciliation", "issues", "evidence", "criteria", "trials", "calibration"];
const LIST_FLAGS = ["capabilities", "artifacts", "integrated"];

function invalid(message) { throw Object.assign(new Error(message), { exitCode: 1 }); }
function conflict(message, code) { throw Object.assign(new Error(message), { exitCode: 3, code }); }
function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (typeof value === "boolean" || !Number.isSafeInteger(number) || number < min || number > max) invalid(`${name} must be an integer between ${min} and ${max}`);
  return number;
}
function json(value, name) {
  try { return JSON.parse(value); } catch { invalid(`${name} must contain valid JSON`); }
}
function input(flags) {
  if (!flags.file) return {};
  const object = json(fs.readFileSync(flags.file === "-" ? 0 : String(flags.file), "utf8"), "--file");
  if (!object || typeof object !== "object" || Array.isArray(object)) invalid("--file must contain a JSON object");
  return object;
}

export function workflowBody(flags, { source = input(flags), config = false } = {}) {
  const body = config ? { config: source.config ?? source } : { ...source };
  for (const name of STRINGS) if (flags[name] !== undefined) body[name.replaceAll("-", "_")] = String(flags[name]);
  for (const name of JSON_FLAGS) if (flags[name] !== undefined) body[name] = json(String(flags[name]), `--${name}`);
  for (const name of LIST_FLAGS) if (flags[name] !== undefined) body[name] = String(flags[name]).startsWith("[") ? json(String(flags[name]), `--${name}`) : String(flags[name]).split(",").map((x) => x.trim()).filter(Boolean);
  if (flags.takeover) body.takeover = true;
  if (flags["expected-revision"] !== undefined) body.expected_revision = integer(flags["expected-revision"], "--expected-revision");
  const key = flags.key ?? body.idempotency_key;
  if (typeof key !== "string" || !key.trim()) invalid("workflow mutations require --key <stable-id> (reuse it only when retrying the same request)");
  body.idempotency_key = key;
  return body;
}

export function workflowMarkdown(value, title = "Workflow") {
  const lines = [`# ${title}`, ""];
  if (value.enabled === false) lines.push(value.error ? `Workflow error: ${value.error}` : "Advanced workflow is not enabled.", "");
  if (value.revision !== undefined) lines.push(`Revision: ${value.revision}`, "");
  if (Array.isArray(value.events)) {
    for (const event of value.events) lines.push(`- ${event.at || ""} · ${event.type || "event"} · ${[event.task, event.worker, event.run, event.outcome].filter(Boolean).join(" · ")} (revision ${event.sequence})`);
    if (value.next_cursor != null) lines.push("", `Next cursor: ${value.next_cursor}`);
  } else {
    // Include the entire deterministic brief, rather than silently losing fields
    // when its server-side format gains a new piece of recovery information.
    lines.push("```json", JSON.stringify(value, null, 2), "```");
  }
  return lines.join("\n") + "\n";
}

export function parentAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

export async function keepalive({ heartbeat, parentPid, maxDurationMs = 300000, intervalMs = 30000, signal,
  isAlive = parentAlive, now = Date.now, sleep = wait }) {
  integer(parentPid, "--parent-pid", { min: 2 });
  integer(maxDurationMs, "--max-duration", { min: 1, max: 86400000 });
  integer(intervalMs, "heartbeat interval", { min: 1, max: 30000 });
  const started = now();
  let renewals = 0;
  while (!signal?.aborted && now() - started < maxDurationMs) {
    if (!isAlive(parentPid)) return { stopped: "parent_exited", renewals };
    await heartbeat(renewals++);
    const remaining = maxDurationMs - (now() - started);
    if (remaining > 0 && !signal?.aborted) {
      let abort;
      await Promise.race([
        sleep(Math.min(intervalMs, remaining), signal),
        new Promise((resolve) => {
          abort = resolve;
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) resolve();
        }),
      ]);
      signal?.removeEventListener("abort", abort);
    }
  }
  return { stopped: signal?.aborted ? "signal" : "max_duration", renewals };
}

/** Run only a configured executable with literal arguments, bounded output and
 * duration. A missing binary, timeout, signal or cwd failure is an error, never
 * a failed assertion and never a pass. Child process groups are stopped too. */
export function executeCheck(check, { workspace, outputLimit = 65536, signal } = {}) {
  const command = check.command;
  if (!command || typeof command.executable !== "string" || !command.executable || !Array.isArray(command.args) || command.args.some((x) => typeof x !== "string")) invalid("check.command requires executable and a string args array");
  let timeoutMs = integer(command.timeout_ms ?? 300000, "command timeout_ms", { min: 1, max: 86400000 });
  if (check.evaluation?.budget?.timeout_ms !== undefined) timeoutMs = Math.min(timeoutMs,
    integer(check.evaluation.budget.timeout_ms, "evaluation timeout_ms", { min: 1, max: 86400000 }));
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) invalid("runner workspace must be an absolute path supplied by the job");
  const cwd = path.resolve(workspace, command.cwd || ".");
  const relative = path.relative(workspace, cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) invalid("command cwd must stay inside the job workspace");
  if (fs.existsSync(cwd) && fs.existsSync(workspace)) {
    const physical = path.relative(fs.realpathSync(workspace), fs.realpathSync(cwd));
    if (physical === ".." || physical.startsWith(`..${path.sep}`) || path.isAbsolute(physical)) invalid("command cwd resolves outside the job workspace");
  }
  outputLimit = integer(outputLimit, "output limit", { min: 1, max: 1048576 });
  return new Promise((resolve) => {
    const started = Date.now();
    const buffers = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    let child, timeout, forceKill, launchError, reason;
    const stop = (why) => {
      reason ||= why;
      if (!child?.pid) return;
      const kill = (sig) => {
        try { if (process.platform !== "win32") process.kill(-child.pid, sig); else child.kill(sig); } catch { /* already exited */ }
      };
      kill("SIGTERM");
      forceKill = setTimeout(() => kill("SIGKILL"), 250);
      forceKill.unref();
    };
    const onAbort = () => stop("interrupted");
    const finish = (code, childSignal) => {
      clearTimeout(timeout); clearTimeout(forceKill);
      signal?.removeEventListener("abort", onAbort);
      const result = { outcome: reason || launchError || childSignal ? "error" : code === 0 ? "passed" : "failed", exit_code: code,
        signal: childSignal || null, duration_ms: Date.now() - started,
        error: launchError?.code || reason || (childSignal ? "terminated" : null), truncated,
        stdout: Buffer.concat(buffers.stdout).toString("utf8"), stderr: Buffer.concat(buffers.stderr).toString("utf8") };
      resolve(result);
    };
    try {
      child = spawn(command.executable, command.args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { launchError = error; finish(null, null); return; }
    for (const stream of ["stdout", "stderr"]) child[stream].on("data", (chunk) => {
      const remaining = outputLimit - sizes[stream];
      if (chunk.length > remaining) truncated[stream] = true;
      if (remaining > 0) { const bounded = chunk.subarray(0, remaining); buffers[stream].push(bounded); sizes[stream] += bounded.length; }
    });
    child.once("error", (error) => { launchError = error; });
    child.once("close", finish);
    timeout = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function signalScope() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return { signal: controller.signal, abort: stop, close() { process.off("SIGTERM", stop); process.off("SIGINT", stop); } };
}

export async function workflowCommand(family, planArg, flags, positional, { ensureBoard, request, printJson, out, ctx, execute = executeCheck }) {
  const action = positional[0];
  if (positional.length > 1) invalid(`unexpected arguments after ${family} action; use named flags or --file`);
  if (action && !["show", "list", "status", ...(ACTIONS[family] || [])].includes(action)) invalid(`unknown ${family} action "${action}"`);
  if (flags.format && !["json", "markdown"].includes(flags.format)) invalid("--format must be json or markdown");
  const write = (value) => flags.format === "markdown" ? out(workflowMarkdown(value, `Planboard ${family}`)) : printJson(value);
  const readOnly = ["history", "resume", "compare"].includes(family) || !action || ["show", "list", "status"].includes(action);
  let body;
  if (!readOnly) {
    body = workflowBody(flags, { ...(family === "spec" && ["init", "configure"].includes(action) ? { config: true,
      source: flags.file ? input(flags) : { schema_version: 1, workspace: ".", sources: [], tasks: {}, checks: {} } } : {}) });
    if (family === "worker" && action === "register" && flags.host) body.host = String(flags.host);
    if (family === "worker" && action === "keepalive" && !flags["parent-pid"]) invalid("keepalive requires --parent-pid for the active host process and stops after --max-duration seconds (default 300)");
  }
  const { api } = await ensureBoard(planArg, { ...ctx, quiet: true });
  const call = async (method, endpoint, data) => {
    const response = await request(method, `${api}/workflow${endpoint}`, data, { timeoutMs: 30000 });
    if (response.status < 200 || response.status >= 300) {
      const error = Object.assign(new Error(`${family}: ${response.json?.error || `HTTP ${response.status}`}`), { exitCode: response.status === 409 ? 3 : 1, code: response.json?.code });
      throw error;
    }
    return response.json;
  };
  if (readOnly) {
    const query = new URLSearchParams();
    for (const key of ["cursor", "limit", "from", "to", "task", "requirement", "worker", "run", "outcome", "since"]) if (flags[key] !== undefined) query.set(key, String(flags[key]));
    if (["history", "resume", "compare"].includes(family)) return write(await call("GET", `/${family}${query.size ? `?${query}` : ""}`));
    const state = await call("GET", "");
    return write(Object.fromEntries(["enabled", "error", "schema_version", "revision", ...READ_FIELDS[family]].filter((key) => state[key] !== undefined).map((key) => [key, state[key]])));
  }
  if (family === "worker" && action === "keepalive") {
    const scope = signalScope();
    const executionId = randomUUID();
    try {
      const result = await keepalive({ parentPid: integer(flags["parent-pid"], "--parent-pid", { min: 2 }),
        maxDurationMs: integer(flags["max-duration"] ?? 300, "--max-duration", { min: 1, max: 86400 }) * 1000,
        signal: scope.signal, heartbeat: async (count) => {
          const renewed = await call("POST", `/worker/${flags.coordinator ? "coordinator-heartbeat" : "heartbeat"}`, {
            ...body, ...(count ? { expected_revision: undefined } : {}), idempotency_key: `${body.idempotency_key}:${executionId}:${count}`,
          });
          if (!(Date.parse(renewed.expires_at) > Date.now())) conflict("Heartbeat did not confirm a current lease", "STALE_LEASE");
          return renewed;
        } });
      return write(result);
    } finally { scope.close(); }
  }
  if (family === "spec" && action === "reconcile") {
    if (!body.change) invalid("spec reconcile requires --change <change-id>");
    const state = await call("GET", "");
    const accepted = state.accepted_changes?.[body.change];
    if (accepted?.phase === "reconciled") return write({ change: accepted, already_reconciled: true });
    if (state.error || accepted?.phase !== "ready_to_reconcile") conflict("Change must be accepted and ready_to_reconcile before source reconciliation", "GATE_BLOCKED");
    if (body.expected_revision !== undefined && body.expected_revision !== state.revision) conflict("Workflow revision changed; refresh before reconciliation", "REVISION_CONFLICT");
    if (accepted.attempts?.some((attempt) => attempt.operation_key === body.idempotency_key)) conflict("This reconciliation operation already ran; inspect its evidence and use a new --key only for an explicit retry", "EXECUTION_UNCERTAIN");
    const workspace = state.specs?.workspace || path.resolve(path.dirname(planArg), state.config?.workspace || ".");
    const openspec = state.config?.openspec;
    if (!openspec || path.basename(path.normalize(openspec)) !== "openspec") {
      return write({ change: body.change, phase: "ready_to_reconcile", automatic: false,
        next_step: `${openspec ? "The native CLI cannot safely target this custom OpenSpec directory. " : ""}Reconcile the proposed changes into their canonical source files manually, then run planboard spec ${planArg} refresh --key <new-key> followed by planboard spec ${planArg} reconciled --change ${body.change} --outcome passed --file <evidence.json> --key <new-key>.` });
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(body.change)) invalid("OpenSpec change must be a single change directory name beginning with a letter or digit");
    const started = await call("POST", "/spec/reconciliation-start", {
      change: body.change, operation_key: body.idempotency_key, execution_id: randomUUID(),
      idempotency_key: `${body.idempotency_key}:start`, expected_revision: body.expected_revision,
    });
    if (!started.token) conflict("Source reconciliation did not acquire its execution token", "EXECUTION_UNCERTAIN");
    const scope = signalScope();
    let execution;
    try {
      execution = await execute({ command: { executable: "openspec", args: ["archive", body.change, "--yes"], cwd: path.dirname(openspec), timeout_ms: 300000 } }, { workspace, signal: scope.signal });
    } catch (error) {
      execution = { outcome: "error", error: "runner_configuration", summary: error.message, stdout: "", stderr: "" };
    } finally { scope.close(); }
    const { stdout, stderr, ...runner } = execution;
    const evidence = [
      { name: "openspec-stdout.txt", text: stdout || "", mime: "text/plain" },
      { name: "openspec-stderr.txt", text: stderr || "", mime: "text/plain" },
      { name: "openspec-execution.json", text: JSON.stringify(runner), mime: "application/json" },
    ];
    let refreshError;
    try { await call("POST", "/spec/refresh", { idempotency_key: `${body.idempotency_key}:refresh` }); }
    catch (error) { refreshError = error; }
    // Record failed archives as durable attempts too. A refresh error must not
    // silently discard the native process's diagnostics.
    const result = await call("POST", "/spec/reconciled", {
      change: body.change, idempotency_key: `${body.idempotency_key}:reconciled`, operation_key: body.idempotency_key,
      token: started.token,
      outcome: execution.outcome, evidence, runner,
      summary: execution.summary || `OpenSpec archive: ${execution.outcome}${execution.error ? ` (${execution.error})` : ""}${refreshError ? `; refresh: ${refreshError.message}` : ""}`,
    });
    write(result);
    if (execution.outcome !== "passed") invalid(`OpenSpec reconciliation ${execution.outcome}; command evidence was recorded. Inspect history before retrying with a new --key.`);
    return;
  }
  if (["validate", "eval"].includes(family) && action === "run") {
    if (!body.job || !body.worker || !body.worker_token) invalid(`${family} run requires --job, --worker and --worker-token`);
    const state = await call("GET", "");
    const existing = Object.values(state.results || {}).find((result) => result.job === body.job);
    if (existing) return write({ result: existing, already_recorded: true });
    const initialJob = state.jobs?.[body.job];
    if (!initialJob || initialJob.phase !== "queued") conflict("Job is not queued; a prior execution may already have run. Inspect history and explicitly recover or enqueue a new job before using a new --key.", "EXECUTION_UNCERTAIN");
    // A fresh execution identity makes simultaneous invocations with the same
    // stable key conflict instead of sharing an old /start receipt and spawning
    // the same external command twice. Completed results are returned above.
    const executionId = randomUUID();
    const started = await call("POST", `/${family}/start`, { ...body, execution_id: executionId, idempotency_key: `${body.idempotency_key}:start` });
    const job = started.job || started;
    const current = await call("GET", "");
    const authoritative = current.jobs?.[body.job];
    if (job.id !== body.job || authoritative?.id !== body.job || authoritative.phase !== "running" || authoritative.worker !== body.worker
      || !authoritative.confirmed || !(Date.parse(authoritative.expires_at) > Date.now())
      || authoritative.artifact !== job.artifact || authoritative.check !== job.check) {
      conflict("Job lease changed or its prior execution is uncertain; inspect history before an explicit retry.", "EXECUTION_UNCERTAIN");
    }
    // Public state omits the token. A non-replayed heartbeat proves the token
    // still fences this exact live claim immediately before executing effects.
    await call("POST", `/${family}/heartbeat`, {
      job: body.job, token: started.token || job.token, idempotency_key: `${body.idempotency_key}:execute:${executionId}`,
    });
    const check = started.check || started.config || job.config || (typeof job.check === "object" ? job.check : null);
    const scope = signalScope();
    let heartbeatError, heartbeatPromise, heartbeats = 0;
    const timer = setInterval(() => {
      if (heartbeatPromise) return;
      heartbeatPromise = call("POST", `/${family}/heartbeat`, {
        job: job.id || body.job, token: started.token || job.token,
        idempotency_key: `${body.idempotency_key}:heartbeat:${executionId}:${heartbeats++}`,
      }).catch((error) => { heartbeatError = error; scope.abort(); }).finally(() => { heartbeatPromise = null; });
    }, 30000);
    let result;
    try {
      result = await execute(check || {}, { workspace: started.workspace || job.workspace || state.artifacts?.[job.artifact]?.workspace,
        signal: scope.signal });
    } catch (error) {
      result = { outcome: "error", error: "runner_configuration", summary: error.message, stdout: "", stderr: "" };
    } finally {
      clearInterval(timer);
      if (heartbeatPromise) await heartbeatPromise;
      scope.close();
    }
    if (heartbeatError) throw heartbeatError;
    const evaluation = family === "eval" || check?.method === "evaluation";
    let report = {};
    if (evaluation && result.outcome === "passed") {
      try {
        report = JSON.parse(result.stdout);
        if (result.truncated?.stdout || !Array.isArray(report.trials) || !Array.isArray(report.calibration)) throw new Error("invalid report");
      } catch {
        result.outcome = "error"; result.error = "invalid_evaluation_output";
        result.summary = "Evaluation stdout must be one JSON object containing trials and calibration arrays within the output limit.";
        report = {};
      }
    }
    const { stdout, stderr, ...execution } = result;
    const response = await call("POST", `/${evaluation ? "eval" : family}/result`, {
      job: job.id || body.job, token: started.token || job.token, idempotency_key: `${body.idempotency_key}:result`, outcome: result.outcome,
      summary: result.summary || `${evaluation ? "Evaluation runner" : "Command"}: ${result.outcome}${result.error ? ` (${result.error})` : ""}`,
      evidence: [{ name: "stdout.txt", text: stdout, mime: "text/plain" }, { name: "stderr.txt", text: stderr, mime: "text/plain" }, { name: "execution.json", text: JSON.stringify(execution), mime: "application/json" }],
      runner: execution,
      criteria: (check?.criteria || []).map((id) => ({ id: typeof id === "string" ? id : id.id, outcome: evaluation ? "inconclusive" : result.outcome, reference: "stdout.txt" })),
      ...(evaluation ? { trials: report.trials || [], calibration: report.calibration || [] } : {}),
    });
    return write(response);
  }
  return write(await call("POST", `/${family}/${family === "spec" && action === "init" ? "configure" : action}`, body));
}
