// Specification documents remain human-owned; mappings and revisions live in the journal.
import fs from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { digest, fail } from "./workflow-schema.js";
import { safeWorkspacePath } from "./workflow-artifacts.js";
import { validateEvaluationContract } from "./workflow-evals.js";

const md = new MarkdownIt();
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const list = (value) => Array.isArray(value) ? value : [];
const portable = (value) => value.split(path.sep).join("/");
const own = (obj, key) => Object.hasOwn(obj, key);
const clean = (text) => text.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX~\/!?-]\]/gm, "$1[ ]").replace(/\r\n/g, "\n");

export const STARTER_PROFILES = Object.freeze({
  backend: { title: "Backend and bug fixes", guidance: "Verify interfaces, error paths, and regression cases.", methods: ["command", "review"] },
  ui: { title: "User interface", guidance: "Verify interactions, accessibility, and visual evidence.", methods: ["command", "manual", "review"] },
  data: { title: "Data", guidance: "Verify schemas, transformations, quality constraints, and lineage.", methods: ["command", "review"] },
  "statistical-ml": { title: "Statistical ML", guidance: "Declare held-out data, baselines, uncertainty, and measurable thresholds.", methods: ["evaluation", "review"] },
  research: { title: "Research", guidance: "Record sources, reproduce analysis, and distinguish findings from uncertainty.", methods: ["manual", "review"] },
  "agent-workflow": { title: "Agent workflow", guidance: "Separate development and held-out scenarios; calibrate graders and retain retries.", methods: ["evaluation", "review"] },
});
export const starterProfiles = STARTER_PROFILES;

export function workflowConfigPath(planPath) {
  const resolved = path.resolve(planPath);
  return path.join(path.dirname(resolved), `${path.basename(resolved, path.extname(resolved))}.workflow.json`);
}

export function loadWorkflowConfig(planPath) {
  const file = workflowConfigPath(planPath);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  let config;
  try { config = JSON.parse(text); } catch (error) { fail(`Invalid workflow JSON in ${file}: ${error.message}`, "INVALID_CONFIG"); }
  if (!object(config)) fail("Workflow configuration must be a JSON object", "INVALID_CONFIG");
  return { path: file, config };
}

function headings(text) {
  const lines = text.split(/\r?\n/);
  const tokens = md.parse(text, {});
  const found = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "heading_open") continue;
    const raw = tokens[index + 1].content;
    const anchor = /\s*\{#([^}]+)\}\s*$/.exec(raw);
    found.push({ title: raw.replace(/\s*\{#[^}]+\}\s*$/, "").trim(), anchor: anchor?.[1] || null, level: Number(token.tag.slice(1)), start: token.map[0], contentStart: token.map[1] });
  }
  return found.map((entry, index) => {
    const next = found.slice(index + 1).find((other) => other.level <= entry.level);
    return { ...entry, end: next?.start ?? lines.length, text: lines.slice(entry.contentStart, next?.start ?? lines.length).join("\n").trim() };
  });
}

export function indexSpecifications({ planPath, config, model, previous = {} } = {}) {
  const result = { requirements: {}, decisions: {}, components: {}, changes: {}, documents: {}, mappings: {}, issues: [] };
  const issue = (code, message, detail = {}, level = "error") => result.issues.push({ level, code, message, ...detail });
  if (!object(config)) { issue("INVALID_CONFIG", "Workflow configuration must be an object"); return result; }
  if (!nonempty(planPath)) { issue("INVALID_CONFIG", "planPath must be a nonempty path"); return result; }
  if (config.schema_version !== 1) issue("INVALID_CONFIG", "Workflow schema_version must be 1");
  if (config.workspace !== undefined && !nonempty(config.workspace)) { issue("INVALID_CONFIG", "workspace must be a directory path relative to the plan"); return result; }
  if (config.workspace && path.isAbsolute(config.workspace)) { issue("UNSAFE_PATH", "workspace must be relative to the plan directory"); return result; }
  let workspace;
  try { workspace = fs.realpathSync(path.resolve(path.dirname(planPath), config.workspace || ".")); safeWorkspacePath(workspace, "."); }
  catch (error) { issue(error.code || "INVALID_CONFIG", `Invalid workspace: ${error.message}`); return result; }
  result.workspace = workspace;
  let resolvedPlan = path.resolve(planPath);
  try { resolvedPlan = fs.realpathSync(resolvedPlan); } catch { /* report the missing plan below */ }
  const planRelative = portable(path.relative(workspace, resolvedPlan));
  try { safeWorkspacePath(workspace, planRelative); } catch (error) { issue(error.code || "UNSAFE_PATH", `Plan must be inside workspace: ${error.message}`); }
  if (object(previous?.mappings)) result.mappings = structuredClone(previous.mappings);
  const readDocument = (relative) => {
    try {
      const absolute = safeWorkspacePath(workspace, relative);
      const text = fs.readFileSync(absolute, "utf8");
      const source = portable(path.relative(workspace, absolute));
      const document = { path: source, text, revision: digest(clean(text)) };
      result.documents[source] = document;
      return document;
    } catch (error) { issue(error.code || "SOURCE_READ", `Cannot read specification ${String(relative)}: ${error.message}`); return null; }
  };
  if (!planRelative.startsWith("..") && !path.isAbsolute(planRelative)) readDocument(planRelative);
  const mapped = (key, prefix) => {
    if (own(result.mappings, key) && typeof result.mappings[key] === "string" && ID.test(result.mappings[key])) return result.mappings[key];
    const id = `${prefix}_${digest(key).slice(0, 16)}`;
    result.mappings[key] = id;
    return id;
  };
  const add = (collection, record) => {
    if (!ID.test(record.id) || ["__proto__", "constructor", "prototype"].includes(record.id)) { issue("INVALID_ID", `Invalid stable id: ${record.id}`); return false; }
    if (own(result[collection], record.id)) { issue("DUPLICATE_ID", `Duplicate ${collection} id: ${record.id}`, collection === "requirements" ? { requirement: record.id } : {}); return false; }
    result[collection][record.id] = record;
    return true;
  };
  const scenariosFor = (heading, all, source, requirementId) => {
    const scenarios = all.filter((entry) => entry.start > heading.start && entry.start < heading.end && /^Scenario:\s*/i.test(entry.title));
    const ids = new Set();
    return scenarios.map((entry) => {
      const id = entry.anchor || mapped(`scenario:${source}:${requirementId}:${entry.title}`, "scenario");
      if (!ID.test(id) || ids.has(id)) issue("INVALID_SCENARIO_ID", `Invalid or duplicate scenario id: ${id}`, { requirement: requirementId });
      ids.add(id);
      return { id, text: `${entry.title.replace(/^Scenario:\s*/i, "")}\n${entry.text}`.trim() };
    });
  };
  const registerHeading = (document, heading, all, options) => {
    const { collection, status = "canonical", change, capability, operation, canonical } = options;
    const source = document.path;
    let id = heading.anchor || mapped(`${collection}:${source}:${heading.title}`, collection === "requirements" ? "req" : collection === "decisions" ? "decision" : "component");
    if (status === "proposed" && canonical) id = `${change}:${canonical.id}`;
    const text = `${heading.title}\n${heading.text}`.trim();
    const record = { id, title: heading.title.replace(/^Requirement:\s*/i, ""), text, revision: digest(clean(text)), source,
      anchor: heading.anchor, status, ...(change ? { change } : {}), ...(capability ? { capability } : {}), ...(operation ? { operation } : {}), ...(canonical ? { canonical_id: canonical.id } : {}) };
    if (collection === "requirements") record.scenarios = scenariosFor(heading, all, source, id);
    if (add(collection, record) && change) {
      result.changes[change] ||= { id: change, status: "proposed", requirements: {}, sources: [] };
      if (collection === "requirements") result.changes[change].requirements[id] = record;
      if (!result.changes[change].sources.includes(source)) result.changes[change].sources.push(source);
    }
    return record;
  };
  if (config.sources !== undefined && !Array.isArray(config.sources)) issue("INVALID_CONFIG", "sources must be an array");
  for (const source of [...list(config.sources)].sort((a, b) => Number(a?.status === "proposed") - Number(b?.status === "proposed"))) {
    if (!object(source) || !nonempty(source.path) || !["requirements", "decisions", "architecture"].includes(source.kind)) { issue("INVALID_CONFIG", "Each source requires a path and requirements, decisions, or architecture kind"); continue; }
    if (source.status !== undefined && !["canonical", "proposed"].includes(source.status)) { issue("INVALID_CONFIG", `Invalid source status: ${source.path}`); continue; }
    if (source.change !== undefined && (!nonempty(source.change) || !ID.test(source.change) || ["constructor", "prototype"].includes(source.change))) { issue("INVALID_ID", `Invalid source change id: ${source.path}`); continue; }
    if (source.status === "proposed" && !source.change) issue("MISSING_CHANGE", `Proposed source requires a change id: ${source.path}`);
    const document = readDocument(source.path);
    if (!document) continue;
    const all = headings(document.text);
    const anchored = all.filter((heading) => heading.anchor && !/^Scenario:/i.test(heading.title));
    if (!anchored.length) issue("MISSING_ANCHORS", `Specification ${source.path} needs explicit {#id} heading anchors`);
    for (const heading of anchored) {
      const canonicalId = source.canonical_ids?.[heading.anchor] || heading.anchor;
      const canonical = source.status === "proposed" && source.kind === "requirements" ? result.requirements[canonicalId] : null;
      const operation = source.status === "proposed" ? source.operation || (canonical ? "modified" : "added") : undefined;
      if (operation && !["added", "modified", "removed", "renamed"].includes(operation)) { issue("INVALID_CONFIG", `Invalid proposed operation in ${source.path}`); continue; }
      if (["modified", "removed", "renamed"].includes(operation) && !canonical) issue("UNRESOLVED_MAPPING", `Proposed ${heading.anchor} has no canonical requirement`, { requirement: heading.anchor });
      registerHeading(document, heading, all, { collection: source.kind === "architecture" ? "components" : source.kind, status: source.status, change: source.change, canonical, operation });
    }
  }
  if (config.requirements !== undefined && !Array.isArray(config.requirements)) issue("INVALID_CONFIG", "Inline requirements must be an array");
  for (const entry of list(config.requirements)) {
    if (!object(entry) || !nonempty(entry.id) || !nonempty(entry.text)) { issue("INVALID_CONFIG", "Inline requirements need id and text"); continue; }
    if (entry.scenarios !== undefined && !Array.isArray(entry.scenarios)) issue("INVALID_CONFIG", `Requirement ${entry.id} scenarios must be an array`);
    const scenarios = list(entry.scenarios).filter((scenario) => {
      if (!object(scenario) || !nonempty(scenario.id) || !ID.test(scenario.id) || !nonempty(scenario.text)) { issue("INVALID_SCENARIO_ID", `Invalid scenario in ${entry.id}`, { requirement: entry.id }); return false; }
      return true;
    });
    if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) issue("DUPLICATE_ID", `Duplicate scenario in ${entry.id}`, { requirement: entry.id });
    add("requirements", { id: entry.id, title: entry.title || entry.text.split("\n")[0], text: entry.text, revision: digest({ text: clean(entry.text), scenarios }), source: portable(path.relative(workspace, workflowConfigPath(resolvedPlan))), anchor: entry.id, status: "canonical", scenarios });
  }

  const scanMarkdown = (relative) => {
    let absolute;
    try { absolute = safeWorkspacePath(workspace, relative); } catch (error) { issue(error.code || "SOURCE_READ", `Cannot scan ${relative}: ${error.message}`); return []; }
    const files = [];
    const walk = (directory, visited) => {
      const real = fs.realpathSync(directory);
      if (visited.has(real)) { issue("UNSAFE_PATH", `Directory cycle in ${relative}`); return; }
      const next = new Set(visited).add(real);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if ([".git", "node_modules", "archive"].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        const source = portable(path.relative(workspace, file));
        try {
          safeWorkspacePath(workspace, source);
          if (fs.statSync(file).isDirectory()) walk(file, next);
          else if (entry.name.endsWith(".md")) files.push(source);
        } catch (error) { issue(error.code || "SOURCE_READ", `Cannot scan ${source}: ${error.message}`); }
      }
    };
    if (!fs.statSync(absolute).isDirectory()) { issue("INVALID_CONFIG", `OpenSpec path must be a directory: ${relative}`); return []; }
    walk(absolute, new Set());
    return files;
  };
  if (config.openspec !== undefined && !nonempty(config.openspec)) issue("INVALID_CONFIG", "openspec must be a relative directory path");
  if (nonempty(config.openspec)) {
    const files = scanMarkdown(config.openspec);
    const normalizedOpenSpec = portable(path.normalize(config.openspec)).replace(/\/$/, "");
    const prefix = normalizedOpenSpec === "." ? "" : normalizedOpenSpec + "/";
    const relativeOpenSpec = (source) => source.slice(prefix.length);
    const canonicalFiles = files.filter((source) => relativeOpenSpec(source).startsWith("specs/"));
    for (const source of canonicalFiles) {
      const document = readDocument(source);
      if (!document) continue;
      const all = headings(document.text);
      const capability = relativeOpenSpec(source).replace(/^specs\//, "").replace(/\/[^/]+$/, "");
      for (const heading of all.filter((entry) => /^Requirement:\s*/i.test(entry.title))) registerHeading(document, heading, all, { collection: "requirements", capability });
    }
    for (const source of files.filter((file) => relativeOpenSpec(file).startsWith("changes/"))) {
      const relative = relativeOpenSpec(source);
      const match = /^changes\/([^/]+)\/(.+)$/.exec(relative);
      if (!match) continue;
      const [, change, local] = match;
      if (!ID.test(change) || ["__proto__", "constructor", "prototype"].includes(change)) { issue("INVALID_ID", `Invalid OpenSpec change id: ${change}`); continue; }
      const document = readDocument(source);
      if (!document) continue;
      result.changes[change] ||= { id: change, status: "proposed", requirements: {}, sources: [] };
      result.changes[change].sources.push(source);
      if (["proposal.md", "design.md", "tasks.md"].includes(local)) result.changes[change][local.replace(".md", "")] = source;
      if (!local.startsWith("specs/")) continue;
      const capability = local.replace(/^specs\//, "").replace(/\/[^/]+$/, "");
      const all = headings(document.text);
      const findCanonical = (title, anchor) => Object.values(result.requirements).filter((entry) => entry.status === "canonical" && (anchor ? entry.id === anchor : entry.capability === capability && entry.title === title));
      for (const heading of all.filter((entry) => /^Requirement:\s*/i.test(entry.title))) {
        const section = all.filter((entry) => entry.start < heading.start && entry.end > heading.start && /^(ADDED|MODIFIED|REMOVED|RENAMED) Requirements$/i.test(entry.title)).at(-1);
        const operation = section?.title.split(" ")[0].toLowerCase();
        if (!operation) { issue("INVALID_DELTA", `OpenSpec delta requirement needs an ADDED/MODIFIED/REMOVED section: ${source}`); continue; }
        const title = heading.title.replace(/^Requirement:\s*/i, "");
        const matches = findCanonical(title, heading.anchor);
        if (operation !== "added" && matches.length !== 1) issue("AMBIGUOUS_REQUIREMENT", `Cannot uniquely resolve ${operation} requirement "${title}" in ${source}`);
        if (operation === "added" && matches.length) issue("DUPLICATE_REQUIREMENT", `ADDED requirement already exists: ${title}`);
        registerHeading(document, heading, all, { collection: "requirements", status: "proposed", change, capability, operation, canonical: matches.length === 1 ? matches[0] : null });
      }
      for (const section of all.filter((entry) => /^RENAMED Requirements$/i.test(entry.title))) {
        const pairs = [...section.text.matchAll(/-\s*FROM:\s*`?###\s*Requirement:\s*(.*?)`?\s*\r?\n\s*-\s*TO:\s*`?###\s*Requirement:\s*(.*?)`?\s*(?:\r?\n|$)/gi)];
        if (!pairs.length) issue("AMBIGUOUS_RENAME", `RENAMED requirements need explicit FROM and TO pairs: ${source}`);
        for (const pair of pairs) {
          const from = pair[1].replace(/`$/, "").trim();
          const to = pair[2].replace(/`$/, "").trim();
          const matches = findCanonical(from);
          if (matches.length !== 1 || !to || findCanonical(to).length) { issue("AMBIGUOUS_RENAME", `Cannot uniquely map OpenSpec rename "${from}" -> "${to}" in ${source}`); continue; }
          const canonical = matches[0];
          // When the native OpenSpec workflow later reconciles this rename,
          // the canonical heading retains its identity without editing its file.
          result.mappings[`requirements:${canonical.source}:Requirement: ${to}`] = canonical.id;
          const id = `${change}:${canonical.id}`;
          const record = { ...canonical, id, canonical_id: canonical.id, title: to, text: `Rename ${from} to ${to}`, source, anchor: null, status: "proposed", change, operation: "renamed", renamed_from: from, revision: digest({ from, to, canonical: canonical.revision }) };
          if (add("requirements", record)) result.changes[change].requirements[id] = record;
        }
      }
    }
  }
  for (const change of Object.values(result.changes)) {
    change.sources = [...new Set(change.sources)].sort();
    change.revision = digest(change.sources.map((source) => ({ source, revision: result.documents[source]?.revision })));
  }
  lintConfiguration(config, model, result, issue, workspace);
  return result;
}

function lintConfiguration(config, model, result, issue, workspace) {
  const tasks = object(config.tasks) ? config.tasks : {};
  const checks = object(config.checks) ? config.checks : {};
  if (!object(config.tasks)) issue("INVALID_CONFIG", "tasks must be an object keyed by explicit plan task id");
  if (!object(config.checks)) issue("INVALID_CONFIG", "checks must be an object keyed by check id");
  const items = new Map(list(model?.items).filter((item) => item?.status).map((item) => [item.id, item]));
  for (const warning of list(model?.warnings)) if (warning.level === "error") issue("PLAN_ID", warning.message);
  const criteria = new Map();
  const validTasks = new Map();
  const strings = (value, name, task, { required = false } = {}) => {
    if (!Array.isArray(value)) { if (value !== undefined || required) issue("INVALID_CONFIG", `${name} must be an array`, task ? { task } : {}); return []; }
    if (value.some((entry) => !nonempty(entry))) issue("INVALID_CONFIG", `${name} entries must be nonempty strings`, task ? { task } : {});
    if (new Set(value).size !== value.length) issue("DUPLICATE_REFERENCE", `${name} contains duplicate references`, task ? { task } : {});
    return value.filter(nonempty);
  };
  const safe = (relative, label, task, mustExist = false) => {
    try { safeWorkspacePath(workspace, relative, { mustExist }); }
    catch (error) { issue(error.code || "UNSAFE_PATH", `${label}: ${error.message}`, task ? { task } : {}); }
  };
  for (const [id, task] of Object.entries(tasks)) {
    if (!ID.test(id) || !object(task)) { issue("INVALID_CONFIG", `Invalid task configuration: ${id}`, { task: id }); continue; }
    validTasks.set(id, task);
    const item = items.get(id);
    if (!item || item.autoId) issue("MISSING_TASK_ANCHOR", `Task ${id} must reference an explicit Markdown task anchor`, { task: id });
    if (task.objective !== undefined && !nonempty(task.objective)) issue("INVALID_CONFIG", `Task ${id} objective must be nonempty`, { task: id });
    const requirements = strings(task.requirements, `${id}.requirements`, id, { required: true });
    if (!requirements.length) issue("MISSING_REQUIREMENTS", `Task ${id} has no requirement coverage`, { task: id });
    for (const requirement of requirements) if (!own(result.requirements, requirement)) issue("UNKNOWN_REQUIREMENT", `Task ${id} references unknown requirement ${requirement}`, { task: id, requirement });
    for (const [field, collection] of [["decisions", "decisions"], ["components", "components"]]) for (const reference of strings(task[field], `${id}.${field}`, id)) {
      if (!own(result[collection], reference)) issue("UNKNOWN_REFERENCE", `Task ${id} references unknown ${field} id ${reference}`, { task: id });
    }
    if (!Array.isArray(task.criteria) || !task.criteria.length) issue("MISSING_CRITERIA", `Task ${id} requires acceptance criteria`, { task: id });
    const localCriteria = new Set();
    for (const criterion of list(task.criteria)) {
      if (!object(criterion) || !nonempty(criterion.id) || !ID.test(criterion.id) || !nonempty(criterion.text)) { issue("INVALID_CRITERION", `Invalid criterion on ${id}`, { task: id }); continue; }
      if (criteria.has(criterion.id)) issue("DUPLICATE_ID", `Criterion id must be globally unique: ${criterion.id}`, { task: id });
      criteria.set(criterion.id, id); localCriteria.add(criterion.id);
    }
    const checkIds = strings(task.checks, `${id}.checks`, id, { required: true });
    if (!checkIds.length) issue("MISSING_CHECKS", `Task ${id} requires validation checks`, { task: id });
    for (const check of checkIds) if (!own(checks, check)) issue("UNKNOWN_CHECK", `Task ${id} references unknown check ${check}`, { task: id });
    for (const criterion of localCriteria) if (!checkIds.some((check) => object(checks[check]) && checks[check].required !== false && list(checks[check].criteria).includes(criterion))) issue("UNCOVERED_CRITERION", `Criterion ${criterion} needs a required check`, { task: id });
    for (const dependency of strings(task.depends_on, `${id}.depends_on`, id)) if (!own(tasks, dependency)) issue("UNKNOWN_DEPENDENCY", `Task ${id} references unknown dependency ${dependency}`, { task: id });
    for (const dependency of strings(task.integration_of, `${id}.integration_of`, id)) {
      if (!own(tasks, dependency)) issue("UNKNOWN_DEPENDENCY", `Integration task ${id} references unknown producer ${dependency}`, { task: id });
      if (!list(task.depends_on).includes(dependency)) issue("INTEGRATION_DEPENDENCY", `Integration task ${id} must depend on producer ${dependency}`, { task: id });
    }
    for (const scope of strings(task.scope, `${id}.scope`, id, { required: true })) safe(scope, `Invalid scope for ${id}`, id);
    if (!list(task.scope).length) issue("MISSING_SCOPE", `Task ${id} requires an artifact scope`, { task: id });
    strings(task.outputs, `${id}.outputs`, id, { required: true });
    if (!list(task.outputs).length) issue("MISSING_OUTPUTS", `Task ${id} requires declared outputs`, { task: id });
    if (task.profile !== undefined && (!nonempty(task.profile) || !own(STARTER_PROFILES, task.profile) && !own(config.profiles || {}, task.profile))) issue("UNKNOWN_PROFILE", `Unknown task profile: ${task.profile}`, { task: id });
  }
  for (const [id, check] of Object.entries(checks)) {
    if (!ID.test(id) || !object(check)) { issue("INVALID_CHECK", `Invalid check: ${id}`); continue; }
    if (!["command", "manual", "review", "evaluation"].includes(check.method)) issue("INVALID_CHECK", `Check ${id} has an invalid validation method`);
    if (typeof check.required !== "boolean") issue("INVALID_CHECK", `Check ${id} must declare required: true or false`);
    const covered = strings(check.criteria, `${id}.criteria`, null, { required: true });
    if (!covered.length) issue("MISSING_CHECK_COVERAGE", `Check ${id} must cover acceptance criteria`);
    for (const criterion of covered) if (!criteria.has(criterion)) issue("UNKNOWN_CRITERION", `Check ${id} references unknown criterion ${criterion}`);
    if (check.method === "command" || check.command !== undefined) {
      const command = check.command;
      if (!object(command) || !nonempty(command.executable) || !Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string") || !Number.isSafeInteger(command.timeout_ms) || command.timeout_ms < 1 || command.timeout_ms > 86400000) issue("INVALID_COMMAND", `Check ${id} needs executable, string args, and timeout_ms between 1 and 86400000`);
      if (object(command)) {
        if (command.cwd !== undefined) safe(command.cwd, `Invalid cwd for ${id}`, null, true);
        if (typeof command.executable === "string" && (command.executable.includes("/") || command.executable.includes("\\")) && !path.isAbsolute(command.executable)) safe(command.executable, `Invalid executable for ${id}`, null, false);
      }
    }
    if (check.method === "evaluation") {
      try { validateEvaluationContract(check.evaluation); } catch (error) { issue("INVALID_EVALUATION", `Check ${id}: ${error.message}`); }
    }
  }
  const visiting = new Set(), visited = new Set();
  const visit = (id, route) => {
    if (visiting.has(id)) { issue("DEPENDENCY_CYCLE", `Dependency cycle: ${[...route, id].join(" -> ")}`, { task: id }); return; }
    if (visited.has(id) || !validTasks.has(id)) return;
    visiting.add(id);
    for (const dependency of list(validTasks.get(id).depends_on).filter(nonempty)) visit(dependency, [...route, id]);
    visiting.delete(id); visited.add(id);
  };
  for (const id of validTasks.keys()) visit(id, []);
}
