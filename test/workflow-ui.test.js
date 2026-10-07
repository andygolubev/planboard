import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceBadge, renderRequirements, renderValidation, renderWorkflowEvents, renderComparison, resumeText } from "../client/workflow.js";

test("done is not represented as accepted without validation", () => {
  assert.match(acceptanceBadge({ status: "done" }), /Not validated/);
  assert.match(acceptanceBadge({ status: "todo", acceptance: "accepted" }), /Validated/);
});

test("untrusted requirement, evidence and event text are escaped", () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const w = { enabled: true, tasks: [], specs: { requirements: { req: { id: "req", title: hostile, text: hostile, source: hostile, scenarios: [{ id: "scenario", text: hostile }] } } } };
  const html = renderRequirements(w, "req") + renderWorkflowEvents([{ id: "event", type: hostile, detail: { message: hostile } }]) + renderComparison({ from: 0, to: 1, changes: [{ group: "specs", id: hostile, before: null, after: hostile }], documents: { after: { plan: hostile } } });
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img/);
});

test("stale artifacts override old passed results and cannot queue another check", () => {
  const w = { enabled: true, tasks: [{ id: "task", artifact: "a", acceptance: "stale" }], artifacts: { a: { id: "a", task: "task", stale: true, checks: { check: { method: "manual", criteria: ["AC"] } } } }, results: { result: { artifact: "a", check: "check", outcome: "passed", fresh: true, evidence: [{ id: "f".repeat(64), name: '<script>alert(1)</script>', bytes: 4 }] } } };
  const html = renderValidation(w, "/boards/test/api");
  assert.match(html, /Stale artifact/);
  assert.match(html, /Stale evidence/);
  assert.ok(!html.includes('data-wf-action="retry"'));
  assert.match(html, /\/workflow\/evidence\/f{64}" download/);
  assert.ok(!html.includes("<script>"));
});

test("resume copy remains deterministic and retains recovery references", () => {
  const brief = { title: "Recovery", objective: "Deliver", revision: 7, scope: ["src"], validated: [], incomplete: [{ id: "task", acceptance: "stale", phase: "candidate", blockers: ["Needs new evidence"], href: "#task", event: "event7" }], next_actions: [{ task: "task", action: "Validate", href: "#task", event: "event7" }], changes: { events: [{ id: "event7", type: "result", sequence: 7 }] }, history_coverage: "Since activation" };
  assert.equal(resumeText({ ...brief, as_of: "2026-01-01" }), resumeText({ ...brief, as_of: "2026-02-02" }));
  assert.match(resumeText(brief), /Needs new evidence/);
  assert.match(resumeText(brief), /#task, event event7/);
});
