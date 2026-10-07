import fs from "node:fs";
import path from "node:path";
import { WorkflowStore } from "./workflow-store.js";
import { digest, fail, uid, requireString, HOSTS, LEASE_MS, OUTCOMES } from "./workflow-schema.js";
import { indexSpecifications, loadWorkflowConfig, workflowConfigPath } from "./workflow-specs.js";
import { snapshotArtifact, artifactFresh, safeWorkspacePath } from "./workflow-artifacts.js";
import { evaluateTrials } from "./workflow-evals.js";
import { ensureDir, writeJsonAtomic } from "./paths.js";

const values = (map) => Object.values(map || {});
const list = (value) => Array.isArray(value) ? value : [];
const isoAfter = (at, ms = LEASE_MS) => new Date(Date.parse(at) + ms).toISOString();
const active = (a) => ["claimed", "running"].includes(a.phase);
const expired = (a, now = Date.now()) => !a.expires_at || Date.parse(a.expires_at) <= now;
function publicCopy(value) {
  if (Array.isArray(value)) return value.map(publicCopy);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !["token", "worker_token", "pending_config"].includes(k)).map(([k, v]) => [k, publicCopy(v)]));
}
function entity(map, id, name) {
  const item = Object.hasOwn(map || {}, id || "") ? map[id] : null;
  if (!item) fail(`Unknown ${name}: ${id}`, "NOT_FOUND", 404);
  return item;
}
function lookupTask(s, id) { return entity(s.config?.tasks, id, "managed task"); }
function binding(s, taskId) {
  const task = lookupTask(s, taskId);
  const requirements = Object.fromEntries((task.requirements || []).map((id) => [id, s.specs.requirements[id]?.revision || null]));
  const decisions = Object.fromEntries((task.decisions || []).map((id) => [id, s.specs.decisions[id]?.revision || null]));
  const components = Object.fromEntries((task.components || []).map((id) => [id, s.specs.components[id]?.revision || null]));
  const checks = Object.fromEntries((task.checks || []).map((id) => [id, s.config.checks[id]]));
  const dependencies = Object.fromEntries(list(task.depends_on).map((id) => [id, taskArtifact(s, id)?.id || null]));
  return { requirements, decisions, components, checks, dependency_artifacts: dependencies, contract_revision: digest({ task, requirements, decisions, components, checks, dependencies }) };
}
function taskArtifact(s, task) {
  return values(s.artifacts).filter((a) => a.task === task).sort((a, b) => b.sequence - a.sequence)[0] || null;
}
function staleArtifacts(s) {
  const stale = new Set(values(s.artifacts).filter((a) => a.stale || !s.config?.tasks?.[a.task] || binding(s, a.task).contract_revision !== a.contract_revision || !artifactFresh(a.manifest)).map((a) => a.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of values(s.artifacts)) if (!stale.has(a.id) && (a.integrated || []).some((id) => {
      const input = s.artifacts[id];
      return !input || stale.has(id) || taskArtifact(s, input.task)?.id !== id || acceptance(s, input.task).acceptance !== "accepted";
    })) { stale.add(a.id); grew = true; }
  }
  return [...stale].filter((id) => !s.artifacts[id].stale);
}
function acceptance(s, taskId) {
  const artifact = taskArtifact(s, taskId);
  if (!artifact) return { acceptance: "not_validated", checks_passed: 0, checks_total: list(s.config?.tasks?.[taskId]?.checks).filter((id) => s.config?.checks?.[id]?.required !== false).length };
  const checks = Object.entries(artifact.checks).filter(([, check]) => check.required !== false);
  const results = checks.map(([check]) => values(s.results).filter((r) => r.artifact === artifact.id && r.check === check).sort((a, b) => b.sequence - a.sequence)[0]);
  const passed = results.filter((r) => r?.outcome === "passed" && r.fresh !== false).length;
  const invalid = (s.specs.issues || []).some((i) => i.level === "error" && (!i.task || i.task === taskId));
  const newerRun = values(s.runs).some((r) => r.task === taskId && r.sequence > artifact.sequence && r.phase !== "cancelled");
  const complete = checks.length > 0 && passed === checks.length && !invalid && !newerRun;
  return { artifact: artifact.id, acceptance: artifact.stale ? "stale" : complete ? "accepted" : "pending", checks_passed: passed, checks_total: checks.length };
}
function blockers(s, taskId) {
  const t = lookupTask(s, taskId);
  const out = list(t.depends_on).filter((id) => acceptance(s, id).acceptance !== "accepted").map((id) => `Waiting for validated ${id}`);
  for (const issue of s.specs.issues || []) if (issue.level === "error" && (!issue.task || issue.task === taskId)) out.push(issue.message);
  return out;
}
function view(s, model, events = []) {
  const tasks = (model?.items || []).filter((i) => i.status).map((i) => {
    const managed = Boolean(s.config?.tasks?.[i.id]);
    const run = values(s.runs).filter((r) => r.task === i.id).sort((a, b) => b.sequence - a.sequence)[0];
    const attempt = values(s.attempts).filter((a) => a.run === run?.id).sort((a, b) => b.sequence - a.sequence)[0];
    return { id: i.id, text: i.text, status: i.status, managed, ...acceptance(s, i.id), phase: run?.phase || attempt?.phase || "idle", worker: attempt?.worker || null, attempt: attempt?.number || 0, started_at: attempt?.started_at || null, confirmed: attempt?.confirmed ?? false, blockers: managed ? blockers(s, i.id) : [] };
  });
  const copied = publicCopy(s);
  for (const result of values(copied.results)) result.fresh = result.fresh !== false && !copied.artifacts[result.artifact]?.stale;
  return { ...copied, enabled: Boolean(s.config), tasks, events: publicCopy(events.slice(-100)), history_coverage: "Full revisions from workflow activation; earlier file history may be incomplete" };
}

function canonicalReconciliation(record, specs) {
  const matches = {}, problems = [];
  const clean = (text) => String(text || "").replace(/\s*\{#[^}]+\}/g, "").replace(/\r\n/g, "\n").trim().replace(/^Requirement:\s*/i, "");
  const canonical = values(specs.requirements).filter((r) => r.status === "canonical");
  for (const req of values(record.intent?.requirements)) {
    const candidates = canonical.filter((r) => (!req.capability || r.capability === req.capability) && (r.id === req.canonical_id || r.id === req.id || r.title === req.title));
    if (req.operation === "removed") {
      if (candidates.length) problems.push(`${req.id} is still present in canonical requirements`);
      else matches[req.id] = null;
      continue;
    }
    let match = candidates.find((r) => r.title === req.title) || (candidates.length === 1 ? candidates[0] : null);
    if (!match) { problems.push(`Canonical requirement for ${req.id} is missing or ambiguous`); continue; }
    let expected = req.text;
    if (req.operation === "renamed") {
      const old = record.originals?.[req.canonical_id];
      expected = old?.text?.replace(/^[^\n]*/, req.title);
      if (!expected) { problems.push(`Original requirement for rename ${req.id} was not recorded`); continue; }
    }
    if (clean(match.text) !== clean(expected)) { problems.push(`Canonical content does not match the validated proposal ${req.id}`); continue; }
    matches[req.id] = match;
  }
  if (!values(record.intent?.requirements).length) problems.push("Change has no recorded requirement delta to reconcile");
  return { ok: !problems.length, matches, problems };
}

function retainAcceptedRequirements(specs, state) {
  for (const record of values(state.accepted_changes)) {
    const reconciled = canonicalReconciliation(record, specs);
    if (!reconciled.ok) continue;
    for (const req of values(record.intent?.requirements)) {
      if (specs.requirements[req.id]) continue;
      const target = reconciled.matches[req.id];
      specs.requirements[req.id] = { ...req, status: "delivered", canonical_id: target?.id || req.canonical_id || null, canonical_revision: target?.revision || null, source: target?.source || req.source, anchor: target?.anchor || req.anchor, removed: !target };
    }
  }
  specs.issues = specs.issues.filter((i) => !(i.code === "UNKNOWN_REQUIREMENT" && specs.requirements[i.requirement]?.status === "delivered"));
  return specs;
}

export function readWorkflow(planPath, boardDir, model, { fullHistory = false } = {}) {
  const store = new WorkflowStore(boardDir, { readonly: true });
  const state = structuredClone(store.state);
  let error = null;
  try {
    const loaded = loadWorkflowConfig(planPath);
    if (loaded) { state.config = loaded.config; state.specs = retainAcceptedRequirements(indexSpecifications({ planPath, config: state.config, model, previous: state.specs }), state); }
    else if (state.config) fail("Workflow companion file is missing");
    if (state.config) for (const id of staleArtifacts(state)) state.artifacts[id].stale = true;
  } catch (err) { error = err.message; for (const a of values(state.artifacts)) a.stale = true; }
  const result = view(state, model, store.events);
  if (fullHistory) result.events = publicCopy(store.events);
  return { ...result, ...(error ? { error } : {}) };
}

export class Workflow {
  constructor(board) {
    this.board = board;
    this.store = new WorkflowStore(board.dir);
    this.error = null;
    this.reconciling = false;
    if (this.store.state.activated_at) {
      this.store.transaction({ type: "runtime.restarted" }, (s) => {
        if (s.coordinator) s.coordinator.confirmed = false;
        for (const a of values(s.attempts)) if (active(a)) a.confirmed = false;
        for (const j of values(s.jobs)) if (j.phase === "running") j.confirmed = false;
        return { message: "Reconcile files and renew leases before continuing" };
      });
    }
  }

  close() { this.store.close(); }
  get state() { return this.store.state; }
  workspace() { return fs.realpathSync(path.resolve(path.dirname(this.board.path), this.state.config?.workspace || ".")); }
  notify() {
    if (this.board.poll && this.state.config) {
      try { this.coordinator(this.state, { worker: this.board.poll.worker, token: this.board.poll.coordinatorToken }); }
      catch { this.board.poll.resolve({ status: "replaced" }); }
    }
    this.board.broadcast({ type: "workflow", revision: this.state.revision, event_id: this.store.events.at(-1)?.id });
  }

  finishConfiguration() {
    const pending = this.state.pending_config;
    if (!pending) return;
    const target = workflowConfigPath(this.board.path);
    const existing = fs.existsSync(target) ? digest(fs.readFileSync(target)) : null;
    const desired = JSON.stringify(pending.config, null, 2) + "\n";
    if (existing !== pending.before && existing !== digest(desired)) fail("Configuration changed during save; resolve the pending configuration before retrying", "REVISION_CONFLICT", 409);
    if (existing !== digest(desired)) writeJsonAtomic(target, pending.config);
    this.store.transaction({ type: "configuration.saved" }, (s) => { delete s.pending_config; return { path: target }; });
  }

  reconcile(observation = {}) {
    if (this.reconciling) return;
    this.reconciling = true;
    const before = this.state.revision;
    try {
      this.finishConfiguration();
      const loaded = loadWorkflowConfig(this.board.path);
      if (loaded) {
        const specs = retainAcceptedRequirements(indexSpecifications({ planPath: this.board.path, config: loaded.config, model: this.board.model, previous: this.state.specs }), this.state);
        const configRevision = digest(loaded.config);
        const planRevision = digest(this.board.source || "");
        const sourceRevision = digest({ configRevision, specs, planRevision });
        if (sourceRevision !== this.state.source_revision) {
          const changedRequirements = [...new Set([...Object.keys(this.state.specs.requirements), ...Object.keys(specs.requirements)])].filter((id) => this.state.specs.requirements[id]?.revision !== specs.requirements[id]?.revision);
          this.store.transaction({ type: observation.type || (this.state.activated_at ? "sources.observed" : "workflow.activated"), actor: observation.actor || "external-file-observer", links: { ...(observation.task ? { task: observation.task } : {}), requirements: changedRequirements } }, (s, at) => {
            s.activated_at ||= at;
            s.config = loaded.config;
            s.config_revision = configRevision;
            s.specs = specs;
            s.source_revision = sourceRevision;
            s.revisions[s.revision + 1] = { id: s.revision + 1, at, source_revision: sourceRevision, plan: this.board.source, documents: specs.documents, config: loaded.config, statuses: Object.fromEntries((this.board.model?.items || []).map((i) => [i.id, i.status])) };
            return { revision: s.revision + 1, observation: observation.type ? "Explicit Planboard action" : "Current file contents observed; intermediate edits and their times are unknown", ...observation, requirements: changedRequirements, issues: specs.issues };
          });
        }
      } else if (this.state.config) {
        fail("Workflow companion file is missing; restore it to continue", "CONFIG_MISSING", 409);
      }
      if (this.state.config) {
        const stale = staleArtifacts(this.state);
        const attempts = values(this.state.attempts).filter((a) => active(a) && expired(a)).map((a) => a.id);
        const jobs = values(this.state.jobs).filter((j) => j.phase === "running" && expired(j)).map((j) => j.id);
        const coordinator = this.state.coordinator && expired(this.state.coordinator);
        if (stale.length || attempts.length || jobs.length || coordinator) this.store.transaction({ type: "workflow.reconciled" }, (s, at) => {
          for (const id of stale) { s.artifacts[id].stale = true; s.artifacts[id].stale_at = at; }
          for (const id of attempts) {
            const a = s.attempts[id]; a.phase = "interrupted"; a.ended_at = at; a.reason = "Lease expired";
            s.runs[a.run].phase = "interrupted";
          }
          for (const id of jobs) { s.jobs[id].phase = "queued"; s.jobs[id].interrupted_at = at; delete s.jobs[id].token; }
          if (coordinator) s.coordinator = null;
          return { stale_artifacts: stale, interrupted_attempts: attempts, interrupted_checks: jobs, coordinator_expired: Boolean(coordinator) };
        });
      }
      this.error = null;
    } catch (err) { this.error = err.message; }
    finally { this.reconciling = false; if (this.state.revision !== before) this.notify(); }
  }

  publicState() {
    this.reconcile();
    const result = view(this.state, this.board.model, this.store.events);
    if (this.error) {
      result.error = this.error;
      for (const artifact of values(result.artifacts)) artifact.stale = true;
      for (const evidence of values(result.results)) evidence.fresh = false;
      for (const task of result.tasks) if (task.managed) { task.blockers.push(this.error); if (task.artifact) task.acceptance = "stale"; }
    }
    return result;
  }

  exportState() { return { ...this.publicState(), events: publicCopy(this.store.events) }; }

  observeInstructions(notes) {
    if (!this.state.config) return;
    for (const note of notes) {
      if (this.state.instructions[note.id]) continue;
      this.store.transaction({ key: `instruction:${note.id}`, request: { id: note.id }, type: "instruction.sent", actor: "user" }, (s) => {
        s.instructions[note.id] = { id: note.id, text: note.text, anchor: note.anchor, at: note.at };
        return { instruction: note.id };
      });
    }
    this.notify();
  }

  worker(s, id, token) {
    const w = entity(s.workers, id, "worker");
    if (!token || w.worker_token !== token) fail("Invalid worker credentials", "WORKER_TOKEN", 409);
    return w;
  }
  coordinator(s, data) {
    const c = s.coordinator;
    if (!c || c.worker !== data.worker || !data.token || c.token !== data.token || expired(c) || !c.confirmed) fail("A confirmed coordinator lease is required", "COORDINATOR_REQUIRED", 409);
    return entity(s.workers, c.worker, "coordinator");
  }
  attempt(s, data) {
    const a = entity(s.attempts, data.attempt, "attempt");
    if (!data.token || a.token !== data.token || !active(a) || expired(a)) fail("Attempt is expired or superseded", "STALE_ATTEMPT", 409);
    return a;
  }
  job(s, data) {
    const j = entity(s.jobs, data.job, "validation job");
    if (!data.token || j.token !== data.token || j.phase !== "running" || expired(j)) fail("Validation lease is expired or superseded", "STALE_CHECK", 409);
    return j;
  }

  mutate(family, action, data = {}) {
    this.reconcile();
    requireString(data.idempotency_key, "idempotency_key");
    if (this.error && !(family === "spec" && ["configure", "reconciled"].includes(action))) fail(this.error, "WORKFLOW_ERROR", 409);
    if (!this.state.config && !(family === "spec" && ["configure", "refresh"].includes(action))) fail("Configure a workflow first", "NOT_CONFIGURED", 409);
    const type = `${family}.${action}`;
    const links = Object.fromEntries(["task", "run", "worker", "requirement", "outcome"].filter((k) => data[k]).map((k) => [k, data[k]]));
    const result = this.store.transaction({ key: data.idempotency_key, request: { family, action, ...data }, expected_revision: data.expected_revision, type, actor: data.worker || "user", links }, (s, at) => {
      let result;
      if (family === "spec") result = this.specAction(action, data, s, at);
      else if (family === "worker") result = this.workerAction(action, data, s, at);
      else if (family === "run") result = this.runAction(action, data, s, at);
      else if (family === "validate" || family === "eval") result = this.validationAction(action, data, s, at, family);
      else fail(`Unknown workflow action ${type}`, "NOT_FOUND", 404);
      const detail = result.artifact || result.result || result.job || result;
      const taskId = data.task || detail.task || s.runs[data.run]?.task || s.attempts[data.attempt]?.task;
      if (taskId) { links.task = taskId; links.requirements = s.config.tasks[taskId]?.requirements || []; }
      if (!links.run && detail.run) links.run = detail.run;
      if (!links.worker && detail.worker) links.worker = detail.worker;
      if (!links.outcome && detail.outcome) links.outcome = detail.outcome;
      return result;
    });
    if (family === "spec" && action === "configure") this.finishConfiguration();
    this.reconcile();
    this.notify();
    return result;
  }

  specAction(action, data, s, at) {
    if (action === "configure") {
      if (data.config?.schema_version !== 1 || !data.config.tasks || !data.config.checks) fail("Config requires schema_version: 1, tasks and checks objects");
      const specs = indexSpecifications({ planPath: this.board.path, config: data.config, model: this.board.model, previous: s.specs });
      const target = workflowConfigPath(this.board.path);
      s.pending_config = { config: data.config, before: fs.existsSync(target) ? digest(fs.readFileSync(target)) : null };
      return { configured: true, path: target, issues: specs.issues };
    }
    if (action === "refresh") return { revision: s.revision, issues: s.specs.issues };
    if (action === "accept") {
      const existing = s.accepted_changes[data.change];
      if (existing?.phase === "reconciling") fail("Native reconciliation is already running; complete or recover that operation first", "RECONCILIATION_ACTIVE", 409);
      if (existing?.phase === "reconciled") return existing;
      const change = entity(s.specs.changes, data.change, "change");
      const tasks = Object.entries(s.config.tasks).filter(([, t]) => t.change === data.change || (t.requirements || []).some((id) => s.specs.requirements[id]?.change === data.change)).map(([id]) => id);
      if (!tasks.length || tasks.some((id) => acceptance(s, id).acceptance !== "accepted")) fail("All change tasks must have current passing validation", "GATE_BLOCKED", 409);
      const artifacts = tasks.map((id) => taskArtifact(s, id).id);
      if (existing && existing.revision === digest(change) && digest(existing.artifacts) === digest(artifacts)) return existing;
      s.accepted_changes[data.change] = { id: data.change, at, revision: digest(change), tasks, intent: structuredClone(change), originals: Object.fromEntries(values(change.requirements).filter((r) => r.canonical_id).map((r) => [r.canonical_id, s.specs.requirements[r.canonical_id]])), artifacts, phase: "ready_to_reconcile", attempts: existing?.attempts || [], reconciliation: data.reconciliation || "Use the native specification workflow to reconcile source files, then refresh" };
      return s.accepted_changes[data.change];
    }
    if (action === "reconciliation-start") {
      const record = entity(s.accepted_changes, data.change, "accepted change");
      if (record.phase !== "ready_to_reconcile") fail(`Change is ${record.phase}; reconcile the previous operation before retrying`, "RECONCILIATION_ACTIVE", 409);
      if (record.tasks.some((id) => acceptance(s, id).acceptance !== "accepted")) fail("Change validation is no longer current", "GATE_BLOCKED", 409);
      record.phase = "reconciling";
      record.operation = { token: uid("reconcile"), operation_key: data.operation_key, execution_id: data.execution_id, at };
      return { change: data.change, phase: record.phase, token: record.operation.token };
    }
    if (action === "reconciled") {
      const record = entity(s.accepted_changes, data.change, "accepted change");
      if (record.phase === "reconciled") return record;
      const manualRecovery = typeof data.reason === "string" && data.reason.trim() && data.expected_revision === s.revision;
      if (record.phase === "reconciling" && !manualRecovery && (data.token !== record.operation?.token || data.operation_key !== record.operation?.operation_key)) fail("Native reconciliation ownership does not match; explicit manual recovery requires the current expected_revision and a reason after checking the native process", "STALE_RECONCILIATION", 409);
      const outcome = data.outcome || "passed";
      if (!OUTCOMES.includes(outcome)) fail("Invalid reconciliation outcome");
      const evidence = this.saveEvidence(data.evidence || []);
      const verified = canonicalReconciliation(record, s.specs);
      const fresh = !this.error && !(s.specs.issues || []).some((issue) => issue.level === "error") && record.artifacts.every((id) => {
        const artifact = s.artifacts[id];
        return artifact && !artifact.stale && taskArtifact(s, artifact.task)?.id === id && artifactFresh(artifact.manifest) && binding(s, artifact.task).contract_revision === artifact.contract_revision && acceptance(s, artifact.task).acceptance === "accepted";
      });
      const passed = outcome === "passed" && !this.error && verified.ok && fresh && evidence.length > 0;
      record.attempts.push({ at, operation_key: data.operation_key || data.idempotency_key, outcome: passed ? "passed" : outcome === "passed" ? "inconclusive" : outcome, evidence, summary: data.summary || "", ...(manualRecovery ? { recovery_reason: data.reason } : {}), problems: [...verified.problems, ...(this.error ? [this.error] : []), ...(!fresh ? ["Validated artifact changed during reconciliation"] : []), ...(!evidence.length ? ["Reconciliation evidence is required"] : [])] });
      record.phase = passed ? "reconciled" : "ready_to_reconcile";
      delete record.operation;
      if (passed) { record.reconciled_at = at; record.canonical_requirements = Object.fromEntries(Object.entries(verified.matches).map(([id, match]) => [id, match?.id || null])); }
      return record;
    }
    fail(`Unknown spec action ${action}`);
  }

  workerAction(action, data, s, at) {
    if (action === "register") {
      if (!HOSTS.includes(data.host)) fail(`host must be ${HOSTS.join(", ")}`);
      requireString(data.label, "label");
      const workspace = fs.realpathSync(path.resolve(data.workspace || this.workspace()));
      if (!fs.statSync(workspace).isDirectory()) fail("workspace must be a directory");
      const w = { id: uid("worker"), host: data.host, label: data.label, workspace, session_id: data.session_id || null, capabilities: Array.isArray(data.capabilities) ? data.capabilities.map(String) : [], worker_token: uid("credential"), registered_at: at };
      s.workers[w.id] = w; return w;
    }
    if (action === "coordinator") {
      this.worker(s, data.worker, data.worker_token);
      if (s.coordinator && !expired(s.coordinator) && s.coordinator.worker !== data.worker && !data.takeover) fail("Another coordinator owns this board", "COORDINATOR_ACTIVE", 409);
      if (s.coordinator?.worker === data.worker && !expired(s.coordinator)) { s.coordinator.confirmed = true; s.coordinator.expires_at = isoAfter(at); return s.coordinator; }
      s.coordinator = { worker: data.worker, token: uid("coordinator"), expires_at: isoAfter(at), confirmed: true, at };
      return s.coordinator;
    }
    if (action === "coordinator-heartbeat" || action === "coordinator-release") {
      const c = s.coordinator;
      if (!c || c.worker !== data.worker || !data.token || c.token !== data.token || expired(c)) fail("Coordinator lease expired or superseded", "STALE_COORDINATOR", 409);
      if (action === "coordinator-release") { s.coordinator = null; return { released: true }; }
      c.expires_at = isoAfter(at); c.confirmed = true; return c;
    }
    if (action === "claim") {
      const w = this.worker(s, data.worker, data.worker_token);
      const r = entity(s.runs, data.run, "run");
      if (!["queued", "dispatched", "interrupted"].includes(r.phase)) fail(`Run is ${r.phase}`, "RUN_UNAVAILABLE", 409);
      const task = lookupTask(s, r.task);
      const waits = blockers(s, r.task);
      if (waits.length) fail(waits.join("; "), "DEPENDENCY_BLOCKED", 409);
      const scope = task.scope?.length ? task.scope : ["."];
      const physicalScope = (workspace, relative) => {
        let target = safeWorkspacePath(workspace, relative, { mustExist: false });
        const tail = [];
        while (!fs.existsSync(target)) { tail.unshift(path.basename(target)); target = path.dirname(target); }
        return path.join(fs.realpathSync(target), ...tail);
      };
      const overlaps = (x, otherRoot, y) => { const a = physicalScope(w.workspace, x); const b = physicalScope(otherRoot, y); return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep); };
      for (const a of values(s.attempts)) if (active(a) && !expired(a)) {
        const other = s.workers[a.worker];
        if (scope.some((x) => a.packet.scope.some((y) => overlaps(x, other.workspace, y)))) fail(`Workspace scope overlaps active ${a.task}`, "SCOPE_CONFLICT", 409);
      }
      const bindings = binding(s, r.task);
      const manifest = snapshotArtifact(w.workspace, scope, { exclude: [this.board.path, workflowConfigPath(this.board.path), this.board.dir] });
      const number = values(s.attempts).filter((a) => a.run === r.id).length + 1;
      const a = { id: uid("attempt"), worker: w.id, run: r.id, task: r.task, number, token: uid("fence"), expires_at: isoAfter(at), confirmed: true, phase: "running", started_at: at, sequence: s.revision + 1,
        packet: { id: r.task, task: r.task, run_id: r.id, attempt: number, objective: task.objective || r.objective, requirements: bindings.requirements, criteria: task.criteria, decisions: bindings.decisions, components: bindings.components, dependencies: task.depends_on || [], scope, outputs: task.outputs || [], checks: Object.fromEntries(Object.entries(bindings.checks).map(([id, check]) => [id, check.evaluation ? { ...check, evaluation: { ...check.evaluation, held_out: check.evaluation.held_out.map((scenario) => ({ id: scenario.id })) } } : check])), input_revision: manifest.hash, contract_revision: bindings.contract_revision, profile: task.profile || "custom" } };
      s.attempts[a.id] = a; r.phase = "running"; r.attempt = a.id; return a;
    }
    if (action === "heartbeat" || action === "release") {
      const a = this.attempt(s, data);
      if (action === "release") { a.phase = "interrupted"; a.reason = data.reason || "Released by worker"; a.ended_at = at; s.runs[a.run].phase = "interrupted"; return { released: true, attempt: a.id }; }
      a.confirmed = true; a.expires_at = isoAfter(at); return a;
    }
    fail(`Unknown worker action ${action}`);
  }

  runAction(action, data, s, at) {
    if (action === "create") {
      this.coordinator(s, data);
      const task = lookupTask(s, data.task);
      const item = this.board.model.items.find((i) => i.id === data.task && !i.autoId && i.status);
      if (!item) fail("Managed task must have an explicit Markdown checkbox anchor");
      const instruction = data.instruction || `manual:${data.idempotency_key}`;
      if (data.instruction) entity(s.instructions, instruction, "instruction");
      const duplicate = values(s.runs).find((r) => r.instruction === instruction && r.task === data.task && (r.repair_of || null) === (data.repair_of || null));
      if (duplicate) return duplicate;
      const running = values(s.runs).find((r) => r.task === data.task && !["cancelled", "candidate"].includes(r.phase));
      if (running) fail("Task already has an unfinished run; reconcile or cancel it", "RUN_ACTIVE", 409);
      if (data.repair_of) entity(s.results, data.repair_of, "repair result");
      const r = { id: uid("run"), task: data.task, objective: task.objective || item.text, instruction, repair_of: data.repair_of || null, phase: "queued", at, sequence: s.revision + 1 };
      s.runs[r.id] = r; return r;
    }
    if (action === "cancel" || action === "dispatch") {
      this.coordinator(s, data);
      const r = entity(s.runs, data.run, "run");
      if (action === "cancel") {
        r.phase = "cancelled"; r.reason = data.reason || "Cancelled by coordinator";
        for (const a of values(s.attempts)) if (a.run === r.id && active(a)) { a.phase = "cancelled"; a.ended_at = at; }
      } else {
        if (!["queued", "dispatched", "uncertain", "interrupted"].includes(r.phase)) fail("Cannot dispatch an active or completed run", "RUN_UNAVAILABLE", 409);
        if (!["dispatched", "uncertain", "failed"].includes(data.phase)) fail("dispatch phase must be dispatched, uncertain, or failed");
        r.phase = data.phase === "failed" ? "interrupted" : data.phase;
        r.host_session_id = data.host_session_id || null; r.reason = data.reason || null;
      }
      return r;
    }
    if (action === "submit") {
      const a = this.attempt(s, data);
      if (!a.confirmed) fail("Renew the attempt after restart before submission", "UNCONFIRMED", 409);
      if (a.packet.contract_revision !== binding(s, a.task).contract_revision) fail("Requirements or validation contract changed; release and reclaim the assignment", "STALE_INPUT", 409);
      const artifact = this.createArtifact(s, at, a.task, s.workers[a.worker].workspace, data, a);
      a.phase = "candidate"; a.ended_at = at; a.artifact = artifact.id; s.runs[a.run].phase = "candidate";
      return { artifact, jobs: values(s.jobs).filter((j) => j.artifact === artifact.id) };
    }
    if (action === "integrate") {
      const worker = this.coordinator(s, data);
      if (data.workspace && fs.realpathSync(data.workspace) !== worker.workspace) fail("Integration must use the coordinator's registered workspace");
      const task = lookupTask(s, data.task);
      const required = task.integration_of || [];
      if (!required.length) fail("Integration task must declare integration_of tasks");
      if (values(s.attempts).some((a) => a.task === data.task && active(a))) fail("Integration task already has an active writer", "RUN_ACTIVE", 409);
      const artifacts = (data.artifacts || []).map((id) => entity(s.artifacts, id, "artifact"));
      if (required.some((id) => !artifacts.some((a) => a.task === id && !a.stale && acceptance(s, id).acceptance === "accepted" && taskArtifact(s, id).id === a.id))) fail("Integration requires current accepted artifacts for every integration_of task", "GATE_BLOCKED", 409);
      const artifact = this.createArtifact(s, at, data.task, worker.workspace, { ...data, producer_worker: worker.id, integrated: artifacts.map((a) => a.id) });
      const run = values(s.runs).find((r) => r.task === data.task && ["queued", "dispatched", "interrupted"].includes(r.phase)) || { id: uid("run"), task: data.task, objective: task.objective || "Integrate validated outputs", instruction: `integration:${data.idempotency_key}`, at, sequence: s.revision + 1 };
      run.phase = "candidate"; run.artifact = artifact.id; s.runs[run.id] = run; artifact.run = run.id;
      return { artifact, jobs: values(s.jobs).filter((j) => j.artifact === artifact.id) };
    }
    fail(`Unknown run action ${action}`);
  }

  createArtifact(s, at, taskId, workspace, data, attempt = null) {
    const task = lookupTask(s, taskId);
    const bindings = binding(s, taskId);
    const integrated = data.integrated || [];
    if ((task.integration_of || []).some((id) => !integrated.some((aid) => s.artifacts[aid]?.task === id && !s.artifacts[aid].stale && acceptance(s, id).acceptance === "accepted"))) fail("Integration candidate is missing validated inputs", "GATE_BLOCKED", 409);
    const manifest = snapshotArtifact(workspace, task.artifact_scope || task.scope || ["."], { exclude: [this.board.path, workflowConfigPath(this.board.path), this.board.dir] });
    const artifact = { id: uid("artifact"), task: taskId, run: attempt?.run || null, attempt: attempt?.id || null, producer_worker: attempt?.worker || data.producer_worker || null, at, sequence: s.revision + 1, manifest, ...bindings, summary: String(data.summary || ""), issues: Array.isArray(data.issues) ? data.issues : [], handoff: String(data.handoff || ""), integrated, stale: false, evidence: this.saveEvidence(data.evidence || []) };
    s.artifacts[artifact.id] = artifact;
    for (const check of task.checks || []) this.enqueue(s, at, artifact.id, check);
    return artifact;
  }

  enqueue(s, at, artifactId, checkId) {
    const artifact = entity(s.artifacts, artifactId, "artifact");
    const check = entity(artifact.checks, checkId, "artifact check");
    if (artifact.stale) fail("Cannot validate a stale artifact", "STALE_ARTIFACT", 409);
    const existing = values(s.jobs).find((j) => j.artifact === artifactId && j.check === checkId && ["queued", "running"].includes(j.phase));
    if (existing) return existing;
    const j = { id: uid("check"), artifact: artifactId, task: artifact.task, check: checkId, method: check.method, phase: "queued", at, configuration_revision: digest(check) };
    s.jobs[j.id] = j; return j;
  }

  validationAction(action, data, s, at, family) {
    if (action === "enqueue") {
      const artifact = entity(s.artifacts, data.artifact, "artifact");
      return { jobs: (data.check ? [data.check] : Object.keys(artifact.checks)).map((id) => this.enqueue(s, at, artifact.id, id)) };
    }
    if (action === "start") {
      const w = this.worker(s, data.worker, data.worker_token);
      const j = entity(s.jobs, data.job, "validation job");
      const a = entity(s.artifacts, j.artifact, "artifact");
      const check = a.checks[j.check];
      if (j.phase !== "queued") fail("Validation job already claimed or completed", "CHECK_ACTIVE", 409);
      if (a.stale || !artifactFresh(a.manifest)) fail("Artifact changed before validation", "STALE_ARTIFACT", 409);
      const producer = s.workers[a.producer_worker || (a.attempt && s.attempts[a.attempt]?.worker)];
      if (check.method === "review" && producer && (producer.id === w.id || (producer.session_id && producer.session_id === w.session_id && producer.host === w.host))) fail("Review requires an independent worker session", "INDEPENDENT_REVIEW_REQUIRED", 409);
      j.phase = "running"; j.worker = w.id; j.token = uid("check-fence"); j.expires_at = isoAfter(at); j.confirmed = true; j.started_at = at; j.input_hash = a.manifest.hash;
      return { job: j, token: j.token, check, workspace: a.manifest.workspace };
    }
    if (action === "heartbeat") {
      const j = this.job(s, data); j.expires_at = isoAfter(at); j.confirmed = true; return j;
    }
    if (action === "result") {
      const j = this.job(s, data);
      if (!j.confirmed) fail("Renew the check after restart before submission", "UNCONFIRMED", 409);
      const a = entity(s.artifacts, j.artifact, "artifact");
      const check = a.checks[j.check];
      let outcome = data.outcome;
      let evaluation = null;
      if (check.method === "evaluation") {
        if (family !== "eval") fail("Use eval/result for evaluation trials");
        evaluation = evaluateTrials(check.evaluation, data.trials || [], data.calibration || []);
        outcome = data.outcome === "error" ? "error" : evaluation.outcome;
      }
      if (!OUTCOMES.includes(outcome)) fail(`outcome must be ${OUTCOMES.join(", ")}`);
      const fresh = !a.stale && a.contract_revision === binding(s, a.task).contract_revision && artifactFresh(a.manifest);
      const evidence = this.saveEvidence(data.evidence || []);
      if (outcome === "passed" && check.evidence_required !== false && !evidence.length && !(data.criteria || []).some((c) => c.reference)) fail("Passing checks require supporting evidence");
      let criteria = Array.isArray(data.criteria) ? data.criteria : [];
      if (check.method === "command" || check.method === "evaluation") criteria = (check.criteria || []).map((id) => ({ id, outcome, reference: evidence[0]?.id || null }));
      if (["review", "manual"].includes(check.method) && outcome === "passed") {
        for (const id of check.criteria || []) if (!criteria.some((c) => c.id === id && c.outcome === "passed" && (c.reference || evidence.length))) fail(`Passing evidence is required for criterion ${id}`);
      }
      if (check.method === "evaluation" && data.runner?.duration_ms > check.evaluation.budget.timeout_ms) outcome = "error";
      const r = { id: uid("result"), job: j.id, task: a.task, artifact: a.id, check: j.check, worker: j.worker, outcome, fresh, at, sequence: s.revision + 1, evidence, criteria, summary: String(data.summary || ""), ...(data.runner ? { runner: data.runner } : {}), contract_revision: a.contract_revision, configuration_revision: j.configuration_revision, artifact_hash: a.manifest.hash };
      if (evaluation) { r.evaluation = { ...evaluation, trials: data.trials || [], calibration: data.calibration || [] }; s.evaluations[r.id] = r.evaluation; }
      s.results[r.id] = r; j.phase = "completed"; j.ended_at = at; j.result = r.id;
      if (!fresh) { a.stale = true; a.stale_at = at; }
      return { result: r, gate: acceptance(s, a.task), repair: outcome === "failed" ? { task: a.task, repair_of: r.id } : null };
    }
    fail(`Unknown validation action ${action}`);
  }

  saveEvidence(entries) {
    if (!Array.isArray(entries) || entries.length > 32) fail("Evidence must be an array with at most 32 files");
    const dir = ensureDir(path.join(this.store.dir, "evidence"));
    return entries.map((e) => {
      if (!e || typeof e !== "object" || (!Object.hasOwn(e, "text") && !Object.hasOwn(e, "data"))) fail("Evidence requires name and text or base64 data");
      const bytes = Object.hasOwn(e, "text") ? Buffer.from(String(e.text)) : Buffer.from(String(e.data), "base64");
      if (bytes.length > 12 * 1024 * 1024) fail("Evidence file exceeds 12 MiB");
      const hash = digest(bytes);
      const name = String(e.name || "evidence.txt").replace(/[\x00-\x1f\x7f"/\\]/g, "_").slice(0, 150);
      const file = path.join(dir, hash);
      if (!fs.existsSync(file)) { const fd = fs.openSync(file, "wx", 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      return { id: hash, name, bytes: bytes.length, mime: String(e.mime || "text/plain"), hash };
    });
  }

  evidence(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) fail("Invalid evidence identifier");
    const record = [...values(this.state.results), ...values(this.state.artifacts), ...values(this.state.accepted_changes).flatMap((c) => c.attempts || [])].flatMap((r) => r.evidence || []).find((e) => e.id === id);
    if (!record) fail("Evidence not found", "NOT_FOUND", 404);
    let file;
    try { file = safeWorkspacePath(path.join(this.store.dir, "evidence"), id); }
    catch (err) { if (["MISSING_PATH", "ENOENT"].includes(err.code)) fail("Evidence file not found", "NOT_FOUND", 404); throw err; }
    return { ...record, path: file };
  }

  history(filters = {}) {
    this.reconcile();
    const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
    const cursor = Number(filters.cursor) || Number.MAX_SAFE_INTEGER;
    const events = this.store.events.filter((e) => e.sequence < cursor && (!filters.from || e.at >= filters.from) && (!filters.to || e.at <= filters.to) && ["task", "requirement", "worker", "run", "outcome"].every((k) => !filters[k] || e[k] === filters[k] || (k === "requirement" && (e.requirements || e.detail?.requirements || []).includes(filters[k])) || e.detail?.[k] === filters[k] || e.detail?.result?.[k] === filters[k])).reverse();
    const page = events.slice(0, limit);
    return { events: publicCopy(page), next_cursor: events.length > limit ? page.at(-1).sequence : null };
  }

  compare(from, to = this.state.revision) {
    const ids = [Number(from), Number(to)];
    if (ids.some((n) => !Number.isInteger(n) || n < 0 || n > this.state.revision)) fail("Comparison revisions must be recorded event sequence numbers");
    const records = fs.existsSync(this.store.file) ? fs.readFileSync(this.store.file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const states = ids.map((id) => id === 0 ? {} : records.find((r) => r.sequence === id)?.state || {});
    const changes = [];
    for (const group of ["specs", "config", "runs", "attempts", "artifacts", "results", "accepted_changes"]) {
      const [a, b] = states.map((s) => publicCopy(s[group] || {}));
      for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) if (digest(a[id] ?? null) !== digest(b[id] ?? null)) changes.push({ group, id, before: a[id] ?? null, after: b[id] ?? null });
    }
    const revisionAt = (s) => values(s.revisions).at(-1) || null;
    return { from: ids[0], to: ids[1], changes, documents: { before: revisionAt(states[0]), after: revisionAt(states[1]) } };
  }

  resume(since) {
    const current = this.publicState();
    const eventFor = (task) => this.store.events.findLast((e) => e.task === task || e.detail?.result?.task === task || e.detail?.artifact?.task === task)?.id || null;
    const tasks = current.tasks.map((t) => ({ ...t, event: eventFor(t.id), href: `#${t.id}` }));
    return { title: this.board.model?.title || "Plan", objective: this.state.config?.objective || this.board.model?.title || "", scope: values(this.state.config?.tasks).flatMap((t) => t.scope || []), revision: this.state.revision, as_of: new Date().toISOString(), error: this.error, history_coverage: current.history_coverage,
      decisions: values(this.state.specs.decisions).filter((d) => d.status !== "proposed"), validated: tasks.filter((t) => t.acceptance === "accepted"), incomplete: tasks.filter((t) => t.managed && t.acceptance !== "accepted"),
      changes: this.history({ from: since || this.board.store.visitInfo().since || undefined, limit: 200 }),
      next_actions: tasks.filter((t) => t.managed && t.acceptance !== "accepted" && !t.blockers.length && !["running", "claimed"].includes(t.phase)).map((t) => ({ task: t.id, action: t.acceptance === "pending" ? "Complete required validation" : t.acceptance === "stale" ? "Submit and validate a fresh candidate" : "Claim assignment", href: t.href, event: t.event })),
      freshness: { stale_artifacts: values(this.state.artifacts).filter((a) => a.stale).map((a) => a.id), unconfirmed_attempts: values(this.state.attempts).filter((a) => active(a) && !a.confirmed).map((a) => a.id), coordinator: publicCopy(this.state.coordinator) } };
  }
}
