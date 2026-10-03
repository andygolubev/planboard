import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorForHash, samePageHash } from "../client/links.js";
import { parsePlan, renderMarkdown } from "../src/plan.js";

test("plain URLs and Markdown links render in plans and discussions without enabling HTML or script URLs in notes", () => {
  const url = "http://192.168.65.4:4747/boards/99c6f25db931#breaking";
  const source = `[Breaking changes](${url})\n\n${url}`;
  for (const html of [parsePlan(source).html, renderMarkdown(source)]) {
    assert.equal(html.split(`href="${url}"`).length - 1, 2);
  }
  const html = renderMarkdown('<script>alert(1)</script> [bad](javascript:alert(1))');
  assert.doesNotMatch(html, /<script|href="javascript:/);
});

test("board links resolve stable section, item, diagram IDs and legacy prefixes", () => {
  const state = { sections: [{ id: "breaking" }, { id: "日本語" }], items: [{ id: "fix" }], diagrams: [{ id: "flow" }] };
  assert.deepEqual(anchorForHash("#breaking", state), { type: "section", section: "breaking" });
  assert.deepEqual(anchorForHash("#sec-breaking", state), { type: "section", section: "breaking" });
  assert.deepEqual(anchorForHash("#fix", state), { type: "item", item: "fix" });
  assert.deepEqual(anchorForHash("#flow", state), { type: "diagram", diagram: "flow" });
  assert.deepEqual(anchorForHash("#%E6%97%A5%E6%9C%AC%E8%AA%9E", state), { type: "section", section: "日本語" });
  assert.equal(anchorForHash("#%broken", state), null);
  assert.equal(anchorForHash("#unknown", state), null);
});

test("only same-board hash links are intercepted; external and cross-board URLs retain normal navigation", () => {
  const page = "http://127.0.0.1:4747/boards/abc";
  assert.equal(samePageHash("#breaking", page), "#breaking");
  assert.equal(samePageHash(page + "#breaking", page), "#breaking");
  assert.equal(samePageHash(page + "/#breaking", page), "#breaking");
  assert.equal(samePageHash("/boards/other#breaking", page), null);
  assert.equal(samePageHash("http://192.168.65.4:4747/boards/abc#breaking", page), null);
  assert.equal(samePageHash("https://example.com/#breaking", page), null);
});
