import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlan } from "../src/plan.js";
import { executionCounts } from "../src/progress.js";
import { PLAN_TEMPLATE } from "../src/guidance.js";
import { readingSection } from "../client/outline.js";
import { renderNow } from "../client/reader.js";

test("progress counts execution, without treating questions or cancellation as completion", () => {
  const model = parsePlan("# Plan {#plan}\n\n## Work {#work}\n\n- [x] Built {#built}\n- [?] Which target? {#target}\n- [-] Old idea {#old}\n- A fact {#fact}\n");
  assert.equal(model.counts.total, 3, "historical API counts remain compatible");
  assert.deepEqual(executionCounts(model.counts), { todo: 0, done: 1, blocked: 0, in_progress: 0, total: 1 });
  assert.match(model.html, /1\/1 actions/);
  assert.match(model.html, /1 to decide/);
  assert.doesNotMatch(model.html, /Everything in this section is done|sec-complete|sec-done-mark/);
  assert.doesNotMatch(model.html.split("</h1>")[0], /sec-progress/);
  const questions = parsePlan("## Decision {#decision}\n\n- [?] Which? {#which}\n");
  assert.doesNotMatch(questions.html, /sec-progress/);
  assert.match(questions.html, /1 to decide/);
});

test("reading section follows the reading edge and reaches a short final section", () => {
  const headings = [{ id: "a", top: -200 }, { id: "b", top: 125 }, { id: "c", top: 690 }];
  const viewport = { top: 100, height: 700, scrollTop: 300, scrollHeight: 2000 };
  assert.equal(readingSection(headings, viewport), "b");
  assert.equal(readingSection(headings, { ...viewport, scrollTop: 1300 }), "c");
  assert.equal(readingSection(headings, { ...viewport, scrollTop: 0, scrollHeight: 700 }), "b", "short documents do not force the last heading");
  assert.equal(readingSection([], viewport), null);
  assert.equal(readingSection([{ id: "parent", top: 100 }, { id: "child", top: 140 }], viewport), "parent", "a subsection just below a linked heading does not steal its highlight");
});

test("Now is source-backed, escapes source text, and does not infer verification", () => {
  assert.equal(renderNow([{ id: "done", status: "done", text: "Built" }]), "");
  const html = renderNow([{ id: "now-outcome", text: '<script>bad</script>' }, { id: "question:a", status: "question", text: "Which target?" }]);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /href="#question%3Aa"/);
  assert.match(html, /Not recorded/);
  assert.doesNotMatch(html, /All done|100%/);
});

test("new plan scaffolding is parseable without fabricated work or verification", () => {
  const model = parsePlan(PLAN_TEMPLATE("New task", "2026-10-19T12:00:00.000Z"));
  assert.deepEqual(model.sections.filter(s => s.level === 2).map(s => s.id), ["description", "requirements", "architecture", "decisions", "risks", "implementation", "apply", "results", "handoff", "timeline"]);
  assert.equal(model.counts.total, 0);
  assert.equal(model.warnings.length, 0);
  assert.match(model.html, /2026-10-19T12:00:00.000Z/);
  assert.match(renderNow(model.items), /Not yet verified/);
  assert.match(model.html, /<details id="architecture-context">/);
});
