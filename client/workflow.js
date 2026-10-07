// Workflow views use only the public projection. Credentials stay in the CLI.
import { esc, clock, fileSize } from "./util.js";

const values = (map) => Object.values(map || {});
const list = (items) => Array.isArray(items) ? items : [];
const ordered = (map) => values(map).sort((a, b) => (b.sequence || 0) - (a.sequence || 0));
const short = (hash) => String(hash || "").slice(0, 12);
const json = (value) => `<pre class="wf-source">${esc(JSON.stringify(value, null, 2))}</pre>`;
const empty = (message) => `<p class="wf-empty">${esc(message)}</p>`;
const taskLink = (id, label = id) => `<a href="#${encodeURIComponent(id)}" class="wf-task-link">${esc(label)}</a>`;
const details = (title, content, open = false) => `<details class="wf-details"${open ? " open" : ""}><summary>${esc(title)}</summary>${content}</details>`;
const fact = (label, value) => `<div><dt>${esc(label)}</dt><dd>${esc(value || "—")}</dd></div>`;
const workerLabel = (w, id) => w.workers?.[id] ? `${w.workers[id].label} · ${w.workers[id].host}` : id || "Unassigned";
const stamp = (at) => at ? `<time datetime="${esc(at)}" title="${esc(at)}">${esc(clock(at))}</time>` : "";
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export const WORKFLOW_TABS = ["requirements", "execution", "validation", "resume"];

export function acceptanceBadge(task = {}) {
  const value = task.acceptance || "not_validated";
  const labels = { accepted: "Validated", pending: "Validation pending", stale: "Stale", not_validated: "Not validated" };
  return `<span class="wf-badge wf-${esc(value)}" title="Task status and validated acceptance are tracked separately">${esc(labels[value] || value)}</span>`;
}

function intro(w, title, description) {
  return `<div class="wf-heading"><h2>${esc(title)}</h2><span class="wf-revision">Revision ${Number(w.revision || 0)}</span></div><p class="wf-lead">${esc(description)}</p>${w.error ? `<p class="wf-warning" role="alert">${esc(w.error)}</p>` : ""}${!w.enabled ? `<div class="wf-notice"><strong>Workflow is not configured</strong><p>The plan and discussion remain available. Configure requirements, assignments, and checks with the CLI to enable validation.</p><code>planboard spec PLAN.md init --key setup-1</code></div>` : ""}`;
}

function evidenceHtml(evidence, base) {
  return list(evidence).map((e) => `<a class="wf-evidence" href="${esc(base)}/workflow/evidence/${encodeURIComponent(e.id)}" download>${esc(e.name)} <small>${esc(fileSize(e.bytes || 0))} · download</small></a>`).join("");
}

function sourceRecord(record) {
  return `<dl class="wf-facts">${fact("Source", record.source || "Workflow configuration")}${fact("Revision", record.revision)}${record.operation ? fact("Change", record.operation) : ""}${record.canonical_id ? fact("Canonical requirement", record.canonical_id) : ""}</dl><pre class="wf-source">${esc(record.text || record.title || "")}</pre>`;
}

export function renderRequirements(w, selected, base = "") {
  const requirements = values(w.specs?.requirements);
  const current = requirements.find((r) => r.id === selected);
  const issues = list(w.specs?.issues);
  let html = intro(w, "Requirements", "Trace the specification to assignments, acceptance criteria, and revision-bound evidence.");
  if (w.enabled) html += `<button type="button" class="btn ghost" data-wf-action="refresh">Refresh specifications</button>`;
  if (issues.length) html += `<div class="wf-warning"><strong>${issues.length} specification issue${issues.length === 1 ? "" : "s"}</strong><ul>${issues.map((i) => `<li>${esc(i.message)}${i.task ? ` · ${taskLink(i.task)}` : ""}</li>`).join("")}</ul></div>`;
  if (!requirements.length) return html + empty("No requirements have been indexed.");
  html += `<label class="wf-field">Requirement<select name="requirement" aria-label="Requirement" data-wf-select="requirement"><option value="">Choose a requirement</option>${requirements.map((r) => `<option value="${esc(r.id)}"${current?.id === r.id ? " selected" : ""}>${esc(r.id)} · ${esc(r.title || r.text?.split("\n")[0] || "")} (${esc(r.status || "canonical")})</option>`).join("")}</select></label>`;
  if (!current) return html + `<div class="wf-list">${requirements.map((r) => `<button type="button" class="wf-card wf-choice" data-wf-requirement="${esc(r.id)}"><span class="wf-badge">${esc(r.status || "canonical")}</span><strong>${esc(r.title || r.id)}</strong><span>${esc(r.id)}</span></button>`).join("")}</div>`;
  const tasks = list(w.tasks).filter((t) => list(w.config?.tasks?.[t.id]?.requirements).includes(current.id));
  html += `<article class="wf-card"><div class="wf-row"><span class="wf-badge">${esc(current.status || "canonical")}</span>${current.change ? `<span>${esc(current.change)}</span>` : ""}</div><h3>${esc(current.title || current.id)}</h3>${sourceRecord(current)}${list(current.scenarios).length ? details("Scenarios", list(current.scenarios).map((s) => `<h4>${esc(s.id)}</h4><pre class="wf-source">${esc(s.text)}</pre>`).join(""), true) : ""}</article><h3>Assignments & evidence</h3>`;
  if (!tasks.length) html += empty("No tasks are linked to this requirement.");
  for (const t of tasks) {
    const config = w.config.tasks[t.id];
    const artifact = w.artifacts?.[t.artifact];
    const results = ordered(w.results).filter((r) => r.artifact === artifact?.id);
    html += `<article class="wf-card"><div class="wf-row">${taskLink(t.id, t.text)}${acceptanceBadge(t)}</div><p>${t.checks_passed || 0}/${t.checks_total || 0} required checks passed${artifact?.stale ? " · evidence is stale" : ""}</p>${list(config.criteria).map((c) => `<p><strong>${esc(c.id)}</strong> ${esc(c.text)}</p>`).join("")}<ul>${list(config.checks).map((id) => `<li>${esc(id)} · ${esc(w.config.checks?.[id]?.method || "unknown check")}</li>`).join("")}</ul>${results.map((r) => `<div class="wf-result"><strong>${esc(r.check)}</strong> · ${esc(r.outcome)}${artifact.stale || r.fresh === false ? " · Stale" : ""}${evidenceHtml(r.evidence, base)}</div>`).join("")}${["decisions", "components"].map((group) => list(config[group]).map((id) => w.specs?.[group]?.[id] ? details(`${group === "decisions" ? "Decision" : "Component"}: ${id}`, sourceRecord(w.specs[group][id])) : `<p class="wf-warning">Missing ${esc(group)}: ${esc(id)}</p>`).join("")).join("")}</article>`;
  }
  return html;
}

export function renderExecution(w) {
  let html = intro(w, "Execution", "Follow assignments, worker ownership, and handoffs independently of validation.");
  const coordinator = w.coordinator;
  html += `<div class="wf-notice"><strong>Coordinator</strong><p>${esc(coordinator ? workerLabel(w, coordinator.worker) : "No active coordinator")}${coordinator?.confirmed === false ? " · confirmation required after restart" : ""}</p>${coordinator ? `<small>Lease expires ${esc(coordinator.expires_at)}</small>` : ""}</div>`;
  for (const t of list(w.tasks)) {
    const attempts = ordered(w.attempts).filter((a) => a.task === t.id);
    const runs = ordered(w.runs).filter((r) => r.task === t.id);
    html += `<article class="wf-card" data-wf-task-card="${esc(t.id)}"><div class="wf-row">${taskLink(t.id, t.text)}${acceptanceBadge(t)}</div><dl class="wf-facts">${fact("Plan status", t.status?.replaceAll("_", " "))}${fact("Execution", t.phase)}${fact("Owner", workerLabel(w, t.worker))}${fact("Attempt", t.attempt || "Not started")}</dl>${["running", "claimed"].includes(t.phase) && !t.confirmed ? '<p class="wf-warning">Ownership is unconfirmed. Renew the lease before continuing.</p>' : ""}${list(t.blockers).length ? `<ul class="wf-warning">${t.blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}${!t.managed ? '<p class="wf-empty">This task has no workflow contract.</p>' : ""}`;
    for (const run of runs) {
      html += details(`Run · ${run.phase} · ${run.id}`, `<dl class="wf-facts">${fact("Objective", run.objective)}${fact("Instruction", run.instruction)}${fact("Repair of result", run.repair_of)}${fact("Host session", run.host_session_id)}${fact("Reason", run.reason)}</dl>${w.instructions?.[run.instruction] ? `<pre class="wf-source">${esc(w.instructions[run.instruction].text)}</pre>` : ""}`);
    }
    for (const a of attempts) html += details(`Attempt ${a.number} · ${a.phase} · ${workerLabel(w, a.worker)}`, `<dl class="wf-facts">${fact("Attempt ID", a.id)}${fact("Started", a.started_at)}${fact("Ended", a.ended_at)}${fact("Lease expires", a.expires_at)}${fact("Ownership", a.confirmed ? "Confirmed" : "Unconfirmed")}${fact("Reason", a.reason)}</dl>${details("Assignment packet", json(a.packet))}`);
    html += "</article>";
  }
  if (!list(w.tasks).length) html += empty("No executable tasks in this plan.");
  if (values(w.workers).length) html += details("Registered workers", values(w.workers).map((worker) => `<div class="wf-result"><strong>${esc(worker.label)}</strong> · ${esc(worker.host)}<dl class="wf-facts">${fact("Worker", worker.id)}${fact("Workspace", worker.workspace)}${fact("Capabilities", list(worker.capabilities).join(", "))}</dl></div>`).join(""));
  return html;
}

export function renderValidation(w, base = "", plan = "PLAN.md") {
  let html = intro(w, "Validation", "Checks apply to an exact artifact and specification revision. A submitted candidate is not yet accepted.");
  const artifacts = ordered(w.artifacts);
  if (!artifacts.length) return html + empty("No candidates submitted yet. Submit an assignment through the CLI to queue its configured checks.");
  for (const artifact of artifacts) {
    const task = list(w.tasks).find((t) => t.id === artifact.task);
    const latest = task?.artifact === artifact.id;
    html += `<article class="wf-card" data-wf-artifact="${esc(artifact.id)}"><div class="wf-row">${taskLink(artifact.task)}${artifact.stale ? '<span class="wf-badge wf-stale">Stale artifact</span>' : latest ? acceptanceBadge(task) : '<span class="wf-badge">Earlier candidate</span>'}</div><h3>${esc(artifact.summary || "Candidate artifact")}</h3><dl class="wf-facts">${fact("Artifact", artifact.id)}${fact("Content hash", artifact.manifest?.hash)}${fact("Contract revision", artifact.contract_revision)}${fact("Submitted", artifact.at)}</dl>${artifact.handoff ? `<p>${esc(artifact.handoff)}</p>` : ""}${evidenceHtml(artifact.evidence, base)}${details("Files, scope & bound revisions", json({ manifest: artifact.manifest, requirements: artifact.requirements, decisions: artifact.decisions, components: artifact.components, integrated: artifact.integrated, issues: artifact.issues }))}`;
    for (const [id, check] of Object.entries(artifact.checks || {})) {
      const results = ordered(w.results).filter((r) => r.artifact === artifact.id && r.check === id);
      const jobs = values(w.jobs).filter((j) => j.artifact === artifact.id && j.check === id);
      const pending = jobs.find((j) => ["queued", "running"].includes(j.phase));
      const result = results[0];
      const outcome = pending?.phase || result?.outcome || "Not run";
      html += `<section class="wf-check"><div class="wf-row"><h4>${esc(id)}</h4><span class="wf-badge wf-${esc(outcome)}">${esc(outcome)}</span></div><p class="wf-meta">${esc(check.method)} · ${check.required === false ? "Optional" : "Required"}${artifact.stale || result?.fresh === false ? " · Stale evidence" : ""}</p>${pending ? `<p>${esc(workerLabel(w, pending.worker))}${pending.confirmed === false && pending.phase === "running" ? " · ownership unconfirmed" : ""}</p>` : ""}${list(check.criteria).length ? `<p>Criteria: ${list(check.criteria).map(esc).join(", ")}</p>` : ""}`;
      if (result) html += `<p>${esc(result.summary)}</p>${stamp(result.at)}${evidenceHtml(result.evidence, base)}${list(result.criteria).map((c) => `<p class="wf-criterion"><strong>${esc(c.id)}</strong> · ${esc(c.outcome)}${c.reference ? ` · ${esc(c.reference)}` : ""}</p>`).join("")}${result.evaluation ? details("Evaluation scores, trials & calibration", json(result.evaluation)) : ""}`;
      if (!artifact.stale && !pending) html += `<button type="button" class="btn ghost" data-wf-action="retry" data-artifact="${esc(artifact.id)}" data-check="${esc(id)}">${result ? "Retry check" : "Queue check"}</button>`;
      if (pending) {
        const command = check.method === "command" || check.method === "evaluation" ? `planboard ${check.method === "evaluation" ? "eval" : "validate"} run ${shellQuote(plan)} --job ${shellQuote(pending.id)} --worker <worker-id> --worker-token <credential> --key <unique-request-id>` : `planboard validate start ${shellQuote(plan)} --job ${shellQuote(pending.id)} --worker <reviewer-id> --worker-token <credential> --key <unique-request-id>\nplanboard validate result ${shellQuote(plan)} --file evidence-result.json --key <unique-result-id>`;
        html += details(check.method === "manual" || check.method === "review" ? "Record manual or review evidence" : "Run this check", `<p>Use a registered worker in the CLI. ${check.method === "review" ? "The reviewer must be independent of the implementing worker. " : ""}The browser queues checks; the local runner performs them.</p><pre class="wf-source">${esc(command)}</pre>${["manual", "review"].includes(check.method) ? `<p>The result file must include the job, token returned by start, outcome, supporting evidence, and an outcome for every criterion.</p>${json({ job: pending.id, token: "<token returned by start>", outcome: "passed", summary: "Describe what was verified", evidence: [{ name: "review.txt", text: "Observed evidence" }], criteria: list(check.criteria).map((criterion) => ({ id: criterion, outcome: "passed", reference: "review.txt" })) })}` : ""}`);
      }
      if (results.length > 1) html += details(`Previous results (${results.length - 1})`, results.slice(1).map((r) => `<div class="wf-result"><strong>${esc(r.outcome)}</strong> · ${stamp(r.at)}${artifact.stale || r.fresh === false ? " · Stale" : ""}<p>${esc(r.summary)}</p>${evidenceHtml(r.evidence, base)}</div>`).join(""));
      html += "</section>";
    }
    html += "</article>";
  }
  return html;
}

export function renderWorkflowEvents(events, w = {}) {
  if (!events.length) return empty("No workflow events match these filters.");
  return events.map((event) => {
    const d = event.detail || {};
    const task = event.task || d.task || d.result?.task || d.artifact?.task;
    const outcome = event.outcome || d.outcome || d.result?.outcome;
    return `<article class="wf-event" data-wf-event="${esc(event.id)}"><div class="wf-row"><strong>${esc(event.type)}</strong><span class="wf-revision">#${Number(event.sequence)}</span></div><div class="wf-meta">${stamp(event.at)}${task ? ` · ${taskLink(task)}` : ""}${outcome ? ` · ${esc(outcome)}` : ""}</div>${event.worker ? `<p>${esc(workerLabel(w, event.worker))}</p>` : ""}${details("Event details", json(event))}</article>`;
  }).join("");
}

export function renderComparison(result) {
  let html = `<p class="wf-notice">Recorded revisions ${Number(result.from)} → ${Number(result.to)}</p>`;
  const before = result.documents?.before;
  const after = result.documents?.after;
  const docs = new Set([...Object.keys(before?.documents || {}), ...Object.keys(after?.documents || {})]);
  if (before?.plan !== after?.plan) html += details("Plan source changed", `<div class="wf-diff"><section><h4>Before</h4><pre class="wf-source">${esc(before?.plan || "Not recorded")}</pre></section><section><h4>After</h4><pre class="wf-source">${esc(after?.plan || "Not recorded")}</pre></section></div>`, true);
  for (const path of docs) {
    const a = before?.documents?.[path]; const b = after?.documents?.[path];
    if (a?.revision !== b?.revision) html += details(`Source: ${path}`, `<h4>Before · ${esc(short(a?.revision))}</h4><pre class="wf-source">${esc(a?.text ?? "Not present")}</pre><h4>After · ${esc(short(b?.revision))}</h4><pre class="wf-source">${esc(b?.text ?? "Not present")}</pre>`);
  }
  if (!list(result.changes).length && before?.plan === after?.plan) html += empty("No recorded changes between these revisions.");
  for (const change of list(result.changes)) html += details(`${change.group} · ${change.id}`, `<h4>Before</h4>${json(change.before)}<h4>After</h4>${json(change.after)}`);
  return html;
}

export function resumeText(brief) {
  const lines = [`# ${brief.title}`, `Revision: ${brief.revision}`, "", brief.objective, "", `Scope: ${list(brief.scope).join(", ") || "Not specified"}`, "", "Decisions:", ...list(brief.decisions).map((d) => `- ${d.id}: ${d.text || d.title} (revision ${d.revision})`), "", "Validated:", ...list(brief.validated).map((t) => `- ${t.id}: ${t.text} (${t.href}, event ${t.event || "unavailable"})`), "", "Incomplete:", ...list(brief.incomplete).map((t) => `- ${t.id}: ${t.acceptance}, ${t.phase}${t.blockers.length ? `; ${t.blockers.join("; ")}` : ""} (${t.href}, event ${t.event || "unavailable"})`), "", "Next actions:", ...list(brief.next_actions).map((a) => `- ${a.task}: ${a.action} (${a.href}, event ${a.event || "unavailable"})`), "", `Freshness: ${JSON.stringify(brief.freshness || {})}`, `History coverage: ${brief.history_coverage || ""}`, "", "Changes:", ...list(brief.changes?.events).map((e) => `- #${e.sequence} ${e.type} (${e.id})`)];
  if (brief.error) lines.push("", `Error: ${brief.error}`);
  return lines.join("\n");
}

export function renderResume(brief, w) {
  const taskRows = (tasks) => tasks.length ? tasks.map((t) => `<div class="wf-card"><div class="wf-row">${taskLink(t.id, t.text)}${acceptanceBadge(t)}</div><p>${esc(t.phase)} · ${esc(workerLabel(w, t.worker))}</p>${list(t.blockers).length ? `<ul class="wf-warning">${t.blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}${t.event ? `<small class="wf-id">Event ${esc(t.event)}</small>` : ""}</div>`).join("") : empty("None.");
  return `<div class="wf-heading"><h2>Resume brief</h2><span class="wf-revision">Revision ${Number(brief.revision)}</span></div><p class="wf-lead">${esc(brief.objective)}</p>${brief.error ? `<p class="wf-warning">${esc(brief.error)}</p>` : ""}<div class="wf-row"><button type="button" class="btn ghost" data-wf-action="copy-resume">Copy brief</button><button type="button" class="btn ghost" data-wf-action="resume-refresh">Refresh brief</button></div><dl class="wf-facts">${fact("Scope", [...new Set(list(brief.scope))].join(", "))}${fact("As of", brief.as_of)}</dl><h3>Next actions</h3>${list(brief.next_actions).length ? brief.next_actions.map((a) => `<div class="wf-card">${taskLink(a.task)}<p>${esc(a.action)}</p>${a.event ? `<small class="wf-id">Event ${esc(a.event)}</small>` : ""}</div>`).join("") : empty("No unblocked next actions.")}<h3>Validated (${list(brief.validated).length})</h3>${taskRows(list(brief.validated))}<h3>Incomplete (${list(brief.incomplete).length})</h3>${taskRows(list(brief.incomplete))}<h3>Decisions</h3>${list(brief.decisions).map((d) => details(d.title || d.id, sourceRecord(d))).join("") || empty("No recorded decisions.")}${details("Freshness & ownership", json(brief.freshness))}<h3>Changes since your review</h3><p class="wf-meta">${esc(brief.history_coverage)}</p>${renderWorkflowEvents(list(brief.changes?.events), w)}${brief.changes?.next_cursor != null ? '<p>More events are available in Activity.</p>' : ""}`;
}

// A single controller survives panel renders. Draft filters live outside the
// DOM; request generations prevent delayed responses from replacing a new view.
export function createWorkflowHost({ api, base, getState, getSince, onRefresh, notify }) {
  let root = null, view = null, generation = 0, selected = "", brief = null;
  let filters = {}, draft = {}, history = null, comparison = null;
  let range = { from: "0", to: "" };
  let revision = null;
  const focusState = () => {
    const el = document.activeElement;
    if (!root?.contains(el)) return null;
    return { name: el.name, action: el.dataset.wfAction, start: el.selectionStart, end: el.selectionEnd };
  };
  function replace(html) {
    const focused = focusState();
    const scroll = root?.parentElement?.scrollTop;
    const open = new Set([...root.querySelectorAll("details[open]")].map((d) => d.querySelector("summary")?.textContent));
    root.innerHTML = html;
    for (const d of root.querySelectorAll("details")) if (open.has(d.querySelector("summary")?.textContent)) d.open = true;
    if (focused) {
      const el = [...root.querySelectorAll("input,select,button")].find((e) => focused.name ? e.name === focused.name : focused.action && e.dataset.wfAction === focused.action);
      el?.focus({ preventScroll: true });
      if (focused.start != null) { try { el?.setSelectionRange(focused.start, focused.end); } catch { /* numeric/date input */ } }
    }
    if (scroll != null) root.parentElement.scrollTop = scroll;
  }
  function historyForm(w) {
    const select = (name, label, options) => `<label class="wf-field">${label}<select name="${name}" aria-label="${label}"><option value="">All</option>${options.map(([id, text]) => `<option value="${esc(id)}"${draft[name] === id ? " selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;
    return `<h2>Workflow activity</h2><p class="wf-meta">${esc(w.history_coverage || "Recorded workflow history")}</p><form data-wf-form="history" class="wf-filter-form"><div class="wf-filter-grid">${["from", "to"].map((name) => `<label class="wf-field">${name === "from" ? "From time" : "To time"}<input type="datetime-local" aria-label="${name === "from" ? "From time" : "To time"}" name="${name}" value="${esc(draft[name] || "")}"></label>`).join("")}${select("task", "Task", list(w.tasks).map((t) => [t.id, t.text]))}${select("requirement", "Requirement", values(w.specs?.requirements).map((r) => [r.id, r.title || r.id]))}${select("worker", "Worker", values(w.workers).map((r) => [r.id, `${r.label} · ${r.host}`]))}${select("run", "Run", values(w.runs).map((r) => [r.id, `${r.task} · ${r.id}`]))}${select("outcome", "Outcome", ["passed", "failed", "error", "skipped", "inconclusive"].map((s) => [s, s]))}</div><div class="wf-row"><button class="btn primary" type="submit">Apply filters</button><button type="button" class="btn ghost" data-wf-action="reset-history">Reset</button></div></form><div data-wf-history-results>${history ? renderWorkflowEvents(history.events, w) + (history.next_cursor != null ? '<button type="button" class="btn ghost" data-wf-action="more">Load older events</button>' : '<p class="wf-meta">End of recorded history.</p>') : '<p role="status">Loading recorded history…</p>'}</div>`;
  }
  function draw() {
    if (!root?.isConnected) return;
    const state = getState(), w = state.workflow || {};
    if (view === "requirements") replace(renderRequirements(w, selected, base));
    else if (view === "execution") replace(renderExecution(w));
    else if (view === "validation") replace(renderValidation(w, base, state.path));
    else if (view === "activity") replace(historyForm(w));
    else if (view === "changes") replace(`<h2>Compare recorded revisions</h2><p class="wf-meta">Choose workflow event sequences. File snapshots reflect observed contents; intermediate edits may be unknown.</p><form data-wf-form="compare"><div class="wf-filter-grid"><label class="wf-field">From revision<input name="from" aria-label="From revision" type="number" min="0" max="${w.revision || 0}" required value="${esc(range.from)}"></label><label class="wf-field">To revision<input name="to" aria-label="To revision" type="number" min="0" max="${w.revision || 0}" required value="${esc(range.to || w.revision || 0)}"></label></div><button type="submit" class="btn primary">Compare revisions</button></form>${details("Available recent revisions", list(w.events).slice().reverse().map((e) => `<p>#${Number(e.sequence)} · ${esc(e.type)} · ${stamp(e.at)}</p>`).join("") || empty("No recorded workflow revisions."))}<div data-wf-comparison>${comparison ? renderComparison(comparison) : empty("Select revisions to inspect source text and workflow changes.")}</div>`);
    else if (view === "resume") replace(brief ? renderResume(brief, w) : '<p role="status">Loading resume brief…</p>');
  }
  async function request(kind, more = false) {
    const ticket = ++generation;
    const expected = root;
    try {
      let result;
      if (kind === "activity") {
        const query = new URLSearchParams({ limit: "25", ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) });
        if (more && history?.next_cursor != null) query.set("cursor", history.next_cursor);
        result = await api("GET", `/workflow/history?${query}`);
      } else if (kind === "changes") result = await api("GET", `/workflow/compare?${new URLSearchParams({ from: range.from, to: range.to || String(getState().workflow?.revision || 0) })}`);
      else result = await api("GET", `/workflow/resume${getSince() ? `?since=${encodeURIComponent(getSince())}` : ""}`);
      if (ticket !== generation || root !== expected || view !== kind || !root?.isConnected) return;
      if (kind === "activity") history = more ? { ...result, events: [...history.events, ...result.events] } : result;
      else if (kind === "changes") comparison = result;
      else brief = result;
      draw();
    } catch (error) {
      if (ticket !== generation || root !== expected || !root?.isConnected) return;
      const target = root.querySelector("[data-wf-history-results], [data-wf-comparison]") || root;
      target.innerHTML = `<p class="wf-warning" role="alert">${esc(error.message)}</p><button type="button" class="btn ghost" data-wf-action="reload">Try again</button>`;
    }
  }
  async function click(event) {
    const choice = event.target.closest("[data-wf-requirement]");
    if (choice) { selected = choice.dataset.wfRequirement; draw(); root.querySelector("select")?.focus(); return; }
    const button = event.target.closest("[data-wf-action]");
    if (!button) return;
    const action = button.dataset.wfAction;
    if (action === "more") { button.disabled = true; await request("activity", true); return; }
    if (action === "reset-history") { filters = {}; draft = {}; history = null; draw(); await request("activity"); return; }
    if (action === "resume-refresh" || action === "reload") { await request(view); return; }
    if (action === "copy-resume") {
      try { await navigator.clipboard.writeText(resumeText(brief)); notify("Resume brief copied"); } catch { notify("Clipboard unavailable. Select and copy the brief text from the panel."); }
      return;
    }
    button.disabled = true;
    try {
      const body = { idempotency_key: crypto.randomUUID() };
      if (action === "retry") { body.artifact = button.dataset.artifact; body.check = button.dataset.check; }
      await api("POST", action === "retry" ? "/workflow/validate/enqueue" : "/workflow/spec/refresh", body);
      await onRefresh();
      notify(action === "retry" ? "Check queued for the local runner" : "Specifications refreshed");
    } catch (error) { notify(error.message); button.disabled = false; }
  }
  return {
    mount(element, name) {
      generation++;
      root = element; view = name;
      const nextRevision = getState().workflow?.revision || 0;
      if (revision !== nextRevision) { history = null; brief = null; revision = nextRevision; }
      root.classList.add("workflow");
      root.onclick = click;
      root.oninput = (event) => {
        if (view === "activity" && event.target.name) draft[event.target.name] = event.target.value;
        if (view === "changes" && event.target.name) range[event.target.name] = event.target.value;
      };
      root.onchange = (event) => {
        if (event.target.dataset.wfSelect === "requirement") { selected = event.target.value; draw(); }
        else root.oninput(event);
      };
      root.onsubmit = (event) => {
        event.preventDefault();
        if (view === "activity") {
          filters = { ...draft };
          for (const key of ["from", "to"]) if (filters[key]) filters[key] = new Date(filters[key]).toISOString();
          history = null; draw();
        } else if (view === "changes") {
          const form = new FormData(event.target); range = { from: form.get("from"), to: form.get("to") };
        }
        void request(view);
      };
      draw();
      if (name === "activity" && !history || name === "resume" && !brief) void request(name);
    },
    detach() { generation++; root = null; view = null; },
  };
}
