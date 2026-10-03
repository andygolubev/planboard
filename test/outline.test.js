import assert from "node:assert/strict";
import { test } from "node:test";
import { numberedSections } from "../client/outline.js";

const section = (id, level, title = id) => ({ id, level, title });
test("contents numbers nested headings and renumbers inserted sections without changing anchors", () => {
  const source = [section("title", 1), section("a", 2), section("b", 3), section("c", 4), section("d", 3), section("e", 2)];
  assert.deepEqual(numberedSections(source).map(s => s.number), ["", "1", "1.1", "1.1.1", "1.2", "2"]);
  const updated = numberedSections([...source.slice(0, 2), section("new", 3), ...source.slice(2)]);
  assert.equal(updated.find(s => s.id === "c").number, "1.2.1");
  assert.equal(updated.find(s => s.id === "d").number, "1.3");
  assert.equal(source[2].number, undefined);
});

test("handles missing titles, skipped levels, and legacy numbering", () => {
  const result = numberedSections([section("a", 2, "1. Scope"), section("b", 4, "1.3.5 Detail"), section("c", 2, "2026 launch")]);
  assert.deepEqual(result.map(s => s.number), ["1", "1.1", "2"]);
  assert.deepEqual(result.map(s => s.displayTitle), ["Scope", "Detail", "2026 launch"]);
  assert.deepEqual(numberedSections([]), []);
});
