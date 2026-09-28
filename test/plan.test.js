import assert from "node:assert/strict";
import { test } from "node:test";

import { lint, parsePlan, setItemStatus, slugify } from "../src/plan.js";

const SAMPLE = `---
title: Auth rollout
---

# Auth rollout {#plan}

Goal paragraph.

## Phase 1 {#p1}

- [x] Login endpoint {#p1-login}
- [~] Rate limiting on /token {#p1-rate}
  - [ ] Bucket config {#p1-rate-cfg}
- [!] Audit log {#p1-audit}
- [?] Keep basic auth for legacy? {#p1-legacy}
- [-] Dropped idea {#p1-drop}
- [ ] No id here
- plain note

\`\`\`mermaid arch
flowchart LR
  C[Client] --> G[Gateway]
\`\`\`

## Phase 2 {#p2}

![Login mock](mocks/login.png)

- [ ] Rollout {#p2-rollout}
`;

test("statuses, ids, sections and nesting are parsed", () => {
  const m = parsePlan(SAMPLE);
  assert.equal(m.title, "Auth rollout");
  assert.deepEqual(
    m.items.map((i) => [i.id, i.status, i.parent]),
    [
      ["p1-login", "done", null],
      ["p1-rate", "in_progress", null],
      ["p1-rate-cfg", "todo", "p1-rate"],
      ["p1-audit", "blocked", null],
      ["p1-legacy", "question", null],
      ["p1-drop", "dropped", null],
      ["p1--no-id-here", "todo", null],
      ["p1--plain-note", null, null],
      ["p2-rollout", "todo", null],
    ],
  );
  assert.equal(m.items[0].text, "Login endpoint");
  assert.equal(m.items[0].line, 11);
  assert.deepEqual(
    m.sections.map((s) => [s.id, s.level, s.parent]),
    [
      ["plan", 1, null],
      ["p1", 2, "plan"],
      ["p2", 2, "plan"],
    ],
  );
  assert.equal(m.counts.total, 8);
  assert.equal(m.counts.done, 1);
  assert.equal(m.counts.in_progress, 1);
  assert.equal(m.counts.blocked, 1);
  assert.equal(m.counts.question, 1);
  assert.equal(m.counts.dropped, 1);
  assert.equal(m.counts.todo, 3);
  const p1 = m.sections.find((s) => s.id === "p1");
  assert.equal(p1.counts.total, 7);
  const plan = m.sections.find((s) => s.id === "plan");
  assert.equal(plan.counts.total, 8, "h1 rolls up its h2 children");
});

test("diagrams and images are collected with their section", () => {
  const m = parsePlan(SAMPLE, { assetBase: "/boards/abc/asset/" });
  assert.deepEqual(m.diagrams.map((d) => [d.id, d.section]), [["arch", "p1"]]);
  assert.match(m.diagrams[0].source, /flowchart LR/);
  assert.deepEqual(m.images.map((i) => [i.src, i.section]), [["mocks/login.png", "p2"]]);
  assert.match(m.html, /<img src="\/boards\/abc\/asset\/mocks\/login\.png"/);
  assert.match(m.html, /<figure class="diagram" data-diagram="arch"/);
});

test("rendered HTML carries the anchors the browser needs", () => {
  const m = parsePlan(SAMPLE);
  assert.match(m.html, /<li class="item status-done" data-item="p1-login" data-status="done" data-line="11">/);
  assert.match(m.html, /<h2 class="section-head" id="sec-p1" data-section="p1"/);
  assert.match(m.html, /1\/7<\/span><\/h2>/);
  assert.doesNotMatch(m.html, /\{#/, "ids are stripped from the visible text");
  assert.doesNotMatch(m.html, /\[x\]|\[~\]/, "task markers are stripped from the visible text");
  assert.match(m.html, /<p class="block" data-block="7" data-section-of="plan">Goal paragraph\.<\/p>/);
});

test("setItemStatus flips exactly the checkbox character", () => {
  const { source, from, to, item } = setItemStatus(SAMPLE, "p1-rate-cfg", "done");
  assert.equal(from, "todo");
  assert.equal(to, "done");
  assert.equal(item.id, "p1-rate-cfg");
  assert.match(source, /  - \[x\] Bucket config \{#p1-rate-cfg\}/);
  assert.equal(source.split("\n").length, SAMPLE.split("\n").length);
  assert.throws(() => setItemStatus(SAMPLE, "nope", "done"), /no item/);
  assert.throws(() => setItemStatus(SAMPLE, "p1-login", "bogus"), /unknown status/);
  const again = setItemStatus(source, "p1-rate-cfg", "blocked");
  assert.match(again.source, /\[!\] Bucket config/);
});

test("status aliases are accepted", () => {
  assert.match(setItemStatus(SAMPLE, "p1-login", "wip").source, /\[~\] Login endpoint/);
  assert.match(setItemStatus(SAMPLE, "p1-login", "x").source, /\[x\] Login endpoint/);
  assert.match(setItemStatus(SAMPLE, "p1-login", "in-progress").source, /\[~\] Login endpoint/);
});

test("lint reports missing and duplicate ids", () => {
  const warnings = lint(parsePlan(SAMPLE));
  assert.ok(warnings.some((w) => /No id here/.test(w.message) && w.level === "warn"));
  const dup = lint(parsePlan("- [ ] a {#same}\n- [ ] b {#same}\n"));
  assert.ok(dup.some((w) => w.level === "error" && /duplicate id "same"/.test(w.message)), JSON.stringify(dup));
});

test("a plan without front matter or ids still parses", () => {
  const m = parsePlan("# Hello world\n\n- [ ] Do the thing\n- [x] Done thing\n");
  assert.equal(m.title, "Hello world");
  assert.deepEqual(m.items.map((i) => i.id), ["hello-world--do-the-thing", "hello-world--done-thing"]);
  assert.equal(m.items[0].line, 3);
});

test("slugify keeps unicode letters", () => {
  assert.equal(slugify("Привет, мир!"), "привет-мир");
  assert.equal(slugify("  Hello   World  "), "hello-world");
});
