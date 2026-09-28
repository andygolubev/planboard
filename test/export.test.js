import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { exportMarkdown } from "../src/export.js";
import { parsePlan } from "../src/plan.js";
import { BoardStore } from "../src/store.js";

const PLAN = `---
title: Export test
---

# Export test {#plan}

## Milestone {#m1}

Intro paragraph.

- [x] Alpha done {#alpha}
- [ ] Beta open {#beta}
  - [ ] Beta child {#beta-child}
1. [~] Numbered gamma {#gamma}

\`\`\`mermaid arch
flowchart LR
  A --> B
\`\`\`

![shot](img.png)
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-export-"));
  const planPath = path.join(dir, "PLAN.md");
  fs.writeFileSync(planPath, PLAN);
  const store = new BoardStore(path.join(dir, "PLAN.board"));
  return { dir, planPath, store, model: parsePlan(PLAN) };
}

test("export folds threads under their items, headings, diagrams and images", () => {
  const { planPath, store, model } = setup();
  const q = store.addNote({ anchor: { type: "item", item: "beta" }, text: "Split this\ninto two", depth: "deep", at: "2026-09-23T10:00:00Z" });
  store.addNote({ from: "agent", anchor: { type: "item", item: "beta" }, text: "Done: **split**", reply_to: q.id, at: "2026-09-23T10:05:00Z" });
  store.addNote({ anchor: { type: "item", item: "gamma" }, text: "numbered", at: "2026-09-23T10:06:00Z" });
  store.addNote({ anchor: { type: "section", section: "m1" }, text: "section note", at: "2026-09-23T10:07:00Z" });
  store.addNote({ anchor: { type: "node", diagram: "arch", node: "A", label: "A" }, text: "rename A", at: "2026-09-23T10:08:00Z" });
  store.addNote({ anchor: { type: "image", src: "img.png", x: 0.5, y: 0.25 }, text: "pin here", at: "2026-09-23T10:09:00Z" });
  store.addNote({ anchor: { type: "board" }, text: "whole plan", at: "2026-09-23T10:10:00Z" });
  store.addNote({ anchor: { type: "item", item: "gone" }, text: "orphan", at: "2026-09-23T10:11:00Z" });
  store.sendQueued();
  store.appendEvents([{ at: "2026-09-23T09:00:00Z", type: "status", item: "alpha", from: "todo", to: "done", text: "Alpha done" }]);
  const shot = store.saveAttachment(Buffer.from("89504e47", "hex"), "png");
  store.notes[0].attachments = [shot.file];
  store.saveNotes();

  const md = exportMarkdown({ source: PLAN, model, store, planPath, version: "test", at: new Date("2026-09-23T12:00:00Z") });
  const lines = md.split("\n");

  // front matter survives, header comment follows it
  assert.equal(lines[0], "---");
  assert.ok(lines.some((l) => l.startsWith("<!-- Exported by planboard test")));
  // the beta thread sits right under the beta line, indented as list continuation, before beta's child
  const betaIdx = lines.findIndex((l) => l.startsWith("- [ ] Beta open"));
  assert.ok(betaIdx > 0);
  assert.equal(lines[betaIdx + 1], "  > **Thread** · 2 notes");
  assert.ok(lines[betaIdx + 3].includes("**User**"));
  assert.ok(lines[betaIdx + 3].includes("depth: deep"));
  assert.ok(lines[betaIdx + 3].includes("sent, not yet delivered"));
  assert.equal(lines[betaIdx + 4], "  > Split this");
  assert.equal(lines[betaIdx + 5], "  > into two");
  assert.ok(lines[betaIdx + 6].startsWith(`  > ![${shot.file}](PLAN.board/attachments/${shot.file})`), lines[betaIdx + 6]);
  const childIdx = lines.findIndex((l) => l.includes("Beta child"));
  assert.ok(childIdx > betaIdx + 6, "child item comes after the thread");
  // numbered list continuation indent is 3 spaces
  const gammaIdx = lines.findIndex((l) => l.startsWith("1. [~] Numbered gamma"));
  assert.equal(lines[gammaIdx + 1], "   > **Thread** · 1 note");
  // section thread after the heading, diagram thread after the closing fence, image thread after the image
  const headIdx = lines.findIndex((l) => l.startsWith("## Milestone"));
  assert.equal(lines[headIdx + 2], "> **Thread on “Milestone”** · 1 note");
  const fenceClose = lines.findIndex((l, i) => i > 0 && l.trim() === "```" && lines.slice(0, i).some((x) => x.startsWith("```mermaid")));
  assert.ok(lines[fenceClose + 2].startsWith("> **Thread on node “A”**"), lines[fenceClose + 2]);
  const imgIdx = lines.findIndex((l) => l.startsWith("![shot]"));
  assert.ok(lines[imgIdx + 2].startsWith("> **Thread on image @ 50%, 25%**"), lines[imgIdx + 2]);
  // appendices
  assert.ok(md.includes("## Notes on the whole plan"));
  assert.ok(md.includes("## Threads on elements no longer in the plan"));
  assert.ok(md.includes("Thread on item:gone"));
  assert.ok(md.includes("## Status history"));
  assert.ok(md.includes("Alpha done (`alpha`): To do → Done"));
  // agent markdown is kept verbatim inside the quote
  assert.ok(md.includes("> Done: **split**"));
  // the export still parses as a plan with the same items
  const again = parsePlan(md);
  assert.deepEqual(
    again.items.filter((i) => i.status).map((i) => i.id),
    model.items.filter((i) => i.status).map((i) => i.id),
  );
});
