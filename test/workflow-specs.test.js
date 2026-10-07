import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parsePlan } from "../src/plan.js";
import { indexSpecifications, loadWorkflowConfig, workflowConfigPath, STARTER_PROFILES } from "../src/workflow-specs.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-specs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const source = "# Plan\n- [ ] Build feature {#feature}\n";
  const planPath = write("PLAN.md", source);
  const model = parsePlan(source);
  const config = { schema_version: 1, workspace: ".", sources: [{ path: "requirements.md", kind: "requirements" }], tasks: { feature: { requirements: ["req-feature"], criteria: [{ id: "accept-feature", text: "Feature works" }], checks: ["test"], scope: ["src"], outputs: ["Feature"], profile: "backend" } }, checks: { test: { method: "command", required: true, criteria: ["accept-feature"], command: { executable: "node", args: ["--test"], cwd: ".", timeout_ms: 1000 } } } };
  write("requirements.md", "# Requirements\n\n## Feature {#req-feature}\nFeature must work.\n\n### Scenario: Valid input {#scenario-valid}\nGiven valid input, succeeds.\n");
  return { dir, write, planPath, model, config, index: (overrides = {}) => indexSpecifications({ planPath, model, config, ...overrides }) };
}

test("workflow indexes anchored documents and criteria with stable revisions and strict JSON", (t) => {
  const { dir, write, planPath, index, config } = fixture(t);
  const result = index();
  assert.deepEqual(result.issues, []);
  assert.equal(result.requirements["req-feature"].status, "canonical");
  assert.equal(result.requirements["req-feature"].scenarios[0].id, "scenario-valid");
  assert.equal(workflowConfigPath(planPath), path.join(dir, "PLAN.workflow.json"));
  assert.equal(loadWorkflowConfig(planPath), null);
  write("PLAN.workflow.json", "{ invalid");
  assert.throws(() => loadWorkflowConfig(planPath), { code: "INVALID_CONFIG" });
  write("PLAN.workflow.json", JSON.stringify(config));
  assert.deepEqual(loadWorkflowConfig(planPath).config, config);
  write("PLAN.md", "# Plan\n- [x] Build feature {#feature}\n");
  assert.equal(index().documents["PLAN.md"].revision, result.documents["PLAN.md"].revision);
  assert.deepEqual(Object.keys(STARTER_PROFILES), ["backend", "ui", "data", "statistical-ml", "research", "agent-workflow"]);
});

test("workflow lint rejects invalid configurations, missing references, missing coverage, cycles, and unsafe paths", (t) => {
  const { config, model, index } = fixture(t);
  const broken = structuredClone(config);
  broken.tasks.feature.requirements = ["missing"];
  broken.tasks.feature.depends_on = ["feature"];
  broken.tasks.feature.scope = ["../outside"];
  broken.checks.test.criteria = ["nonexistent"];
  const result = index({ config: broken });
  for (const code of ["UNKNOWN_REQUIREMENT", "DEPENDENCY_CYCLE", "UNSAFE_PATH", "UNKNOWN_CRITERION", "UNCOVERED_CRITERION"]) assert.ok(result.issues.some((issue) => issue.code === code), code);
  const generated = structuredClone(model); generated.items[0].autoId = true;
  assert.ok(index({ model: generated }).issues.some((issue) => issue.code === "MISSING_TASK_ANCHOR"));
  for (const invalid of [null, [], { schema_version: 2, tasks: { feature: null }, checks: null, sources: [null, 7], requirements: [null] }, { ...config, tasks: { feature: { criteria: [null], checks: [null], requirements: [null], depends_on: [null], scope: [null] } }, checks: { test: null } }]) assert.doesNotThrow(() => index({ config: invalid }));
});

test("workflow sources and scopes cannot follow escaping symlinks", (t) => {
  const { dir, config, index } = fixture(t);
  fs.symlinkSync(os.tmpdir(), path.join(dir, "escape"));
  const broken = structuredClone(config);
  broken.sources[0].path = "escape/whatever.md";
  broken.tasks.feature.scope = ["escape/new-file.txt"];
  assert.ok(index({ config: broken }).issues.filter((issue) => issue.code === "UNSAFE_PATH").length >= 2);
});

test("OpenSpec keeps canonical and proposed requirements separate and maps unanchored names persistently", (t) => {
  const { write, config, index } = fixture(t);
  write("openspec/specs/auth/spec.md", "# Auth\n\n## Requirements\n\n### Requirement: Login\nUsers log in.\n\n#### Scenario: Valid credentials\nSucceeds.\n\n### Requirement: Old mode\nStill supported.\n");
  write("openspec/changes/oauth/proposal.md", "# OAuth\nAdd OAuth.\n");
  write("openspec/changes/oauth/design.md", "# Design\nReuse sessions.\n");
  write("openspec/changes/oauth/tasks.md", "# Tasks\n- [ ] Implement OAuth\n");
  write("openspec/changes/oauth/specs/auth/spec.md", "## MODIFIED Requirements\n\n### Requirement: Login\nUsers log in with OAuth.\n\n#### Scenario: OAuth\nSucceeds.\n\n## ADDED Requirements\n\n### Requirement: Logout\nUsers log out.\n\n## REMOVED Requirements\n\n### Requirement: Old mode\nObsolete.\n");
  const updated = { ...config, openspec: "openspec" };
  const first = index({ config: updated });
  assert.deepEqual(first.issues, []);
  const canonical = Object.values(first.requirements).find((entry) => entry.title === "Login" && entry.status === "canonical");
  const modified = Object.values(first.requirements).find((entry) => entry.operation === "modified");
  assert.equal(modified.canonical_id, canonical.id);
  assert.equal(first.requirements[canonical.id].text.includes("with OAuth"), false);
  assert.equal(modified.text.includes("with OAuth"), true);
  assert.equal(Object.keys(first.changes.oauth.requirements).length, 3);
  assert.ok(first.documents["openspec/changes/oauth/proposal.md"]);
  assert.equal(first.changes.oauth.design, "openspec/changes/oauth/design.md");
  write("openspec/specs/auth/spec.md", "# Auth\n\n### Requirement: Login\nUsers log in safely.\n\n### Requirement: Old mode\nStill supported.\n");
  const next = index({ config: updated, previous: first });
  assert.equal(next.requirements[canonical.id].title, "Login");
  assert.notEqual(next.requirements[canonical.id].revision, canonical.revision);
});

test("OpenSpec renames require unambiguous FROM and TO pairs", (t) => {
  const { dir, write, config, index } = fixture(t);
  write("openspec/specs/auth/spec.md", "### Requirement: Login\nLogin works.\n");
  write("openspec/changes/rename/specs/auth/spec.md", "## RENAMED Requirements\n- FROM: `### Requirement: Login`\n- TO: `### Requirement: Sign in`\n");
  const result = index({ config: { ...config, openspec: "openspec" } });
  assert.deepEqual(result.issues, []);
  const rename = Object.values(result.requirements).find((entry) => entry.operation === "renamed");
  assert.equal(rename.title, "Sign in");
  assert.equal(rename.renamed_from, "Login");
  write("openspec/changes/rename/specs/auth/spec.md", "## RENAMED Requirements\nUnclear rename.\n");
  assert.ok(index({ config: { ...config, openspec: "openspec" } }).issues.some((issue) => issue.code === "AMBIGUOUS_RENAME"));
  fs.rmSync(path.join(dir, "openspec/changes/rename"), { recursive: true });
  write("openspec/specs/auth/spec.md", "### Requirement: Sign in\nLogin works.\n");
  const reconciled = index({ config: { ...config, openspec: "openspec" }, previous: result });
  assert.equal(reconciled.requirements[rename.canonical_id].title, "Sign in");
});
