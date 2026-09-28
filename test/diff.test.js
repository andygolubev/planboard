import assert from "node:assert/strict";
import { test } from "node:test";

import { diffSnapshots, snapshotOf } from "../src/diff.js";
import { parsePlan } from "../src/plan.js";

const before = parsePlan(`# P {#p}\n- [ ] A {#a}\n- [~] B {#b}\n- [ ] C {#c}\n\n\`\`\`mermaid d\nflowchart LR\n X-->Y\n\`\`\`\n`);
const after = parsePlan(`# P {#p}\n- [x] A {#a}\n- [~] B renamed {#b}\n- [ ] D {#d}\n\n## New {#new}\n\n\`\`\`mermaid d\nflowchart LR\n X-->Z\n\`\`\`\n`);

test("first sighting produces no events", () => {
  assert.deepEqual(diffSnapshots(null, snapshotOf(before)), []);
});

test("status flips, additions, removals, rewordings and diagram edits are events", () => {
  const events = diffSnapshots(snapshotOf(before), snapshotOf(after), "2026-01-01T00:00:00.000Z");
  const types = events.map((e) => `${e.type}:${e.item || e.section || e.diagram}`);
  assert.deepEqual(types.sort(), ["added:d", "diagram_changed:d", "removed:c", "reworded:b", "section_added:new", "status:a"].sort());
  const status = events.find((e) => e.type === "status");
  assert.equal(status.from, "todo");
  assert.equal(status.to, "done");
  assert.equal(status.at, "2026-01-01T00:00:00.000Z");
});

test("identical snapshots produce nothing", () => {
  assert.deepEqual(diffSnapshots(snapshotOf(before), snapshotOf(before)), []);
});

test("a changed diagram carries its previous and new source so the board can show before/after", () => {
  const events = diffSnapshots(snapshotOf(before), snapshotOf(after));
  const d = events.find((e) => e.type === "diagram_changed");
  assert.match(d.from, /X-->Y/);
  assert.match(d.to, /X-->Z/);
  // snapshots written by older versions (hash only) still diff, just without sources
  const legacy = { ...snapshotOf(before), diagrams: snapshotOf(before).diagrams.map(({ id, hash }) => ({ id, hash })) };
  const d2 = diffSnapshots(legacy, snapshotOf(after)).find((e) => e.type === "diagram_changed");
  assert.equal(d2.from, undefined);
  assert.match(d2.to, /X-->Z/);
});
