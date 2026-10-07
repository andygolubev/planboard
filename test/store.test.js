import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BoardStore, anchorKey, normalizeAnchor } from "../src/store.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "planboard-store-"));
}

test("notes move queued -> sent -> delivered and can be restored", () => {
  const dir = tmp();
  const s = new BoardStore(dir);
  const n1 = s.addNote({ anchor: { type: "item", item: "a" }, text: "first" });
  const n2 = s.addNote({ anchor: { type: "item", item: "a" }, text: "second" });
  assert.equal(n1.state, "queued");
  assert.deepEqual(s.pending(), []);
  assert.equal(s.sendQueued([n1.id]).length, 1);
  assert.deepEqual(
    s.pending().map((n) => n.id),
    [n1.id],
  );
  assert.equal(s.removeNote(n1.id).removed, false, "sent notes cannot be removed");
  assert.equal(s.removeNote(n2.id).removed, true);
  const taken = s.takePending();
  assert.equal(taken[0].state, "delivered");
  assert.deepEqual(s.pending(), []);
  s.restore([n1.id]);
  assert.deepEqual(
    s.pending().map((n) => n.id),
    [n1.id],
  );
  // survives a reload from disk
  const s2 = new BoardStore(dir);
  assert.equal(s2.notes.length, 1);
  assert.equal(s2.notes[0].state, "sent");
});

test("agent replies land delivered and thread with their anchor", () => {
  const s = new BoardStore(tmp());
  const q = s.addNote({ anchor: { type: "text", item: "a", quote: "x" }, text: "why?" });
  const r = s.addNote({ from: "agent", anchor: { type: "item", item: "a" }, text: "because", reply_to: q.id });
  assert.equal(r.state, "delivered");
  assert.deepEqual(
    s.thread({ type: "item", item: "a" }).map((n) => n.id),
    [q.id, r.id],
  );
  const summary = s.threadsSummary();
  assert.equal(summary["item:a"].count, 2);
  assert.equal(summary["item:a"].queued, 1);
  assert.equal(summary["item:a"].last_from, "agent");
});

test("anchors normalize to a fixed shape", () => {
  assert.deepEqual(normalizeAnchor({ type: "item", item: "x", extra: 1 }), { type: "item", item: "x" });
  assert.deepEqual(normalizeAnchor({ type: "image", src: "a.png", x: 1.7, y: -2 }), { type: "image", src: "a.png", x: 1, y: 0 });
  assert.deepEqual(normalizeAnchor({ type: "weird" }), { type: "board" });
  assert.equal(anchorKey({ type: "node", diagram: "d", node: "A" }), "node:d/A");
  assert.equal(anchorKey({ type: "text", section: "s" }), "section:s");
});

test("visits: a 30 minute gap starts a new visit and exposes the previous one", () => {
  const s = new BoardStore(tmp());
  const t0 = Date.parse("2026-01-01T09:00:00Z");
  assert.equal(s.touchVisit(t0).since, null);
  assert.equal(s.touchVisit(t0 + 5 * 60000).new_visit, false);
  const next = s.touchVisit(t0 + 5 * 60000 + 31 * 60000);
  assert.equal(next.new_visit, true);
  assert.equal(next.since, new Date(t0 + 5 * 60000).toISOString());
  s.appendEvents([{ at: new Date(t0 + 10 * 60000).toISOString(), type: "status", item: "a", from: "todo", to: "done" }]);
  assert.equal(s.eventsSince(next.since).length, 1);
});

test("depth is normalized and only kept when it is not the default; attachments must exist", () => {
  const dir = tmp();
  const s = new BoardStore(dir);
  assert.equal(s.addNote({ anchor: { type: "board" }, text: "a", depth: "DEEP" }).depth, "deep");
  assert.equal(s.addNote({ anchor: { type: "board" }, text: "b", depth: "normal" }).depth, undefined);
  assert.equal(s.addNote({ anchor: { type: "board" }, text: "c", depth: "bogus" }).depth, undefined);
  assert.equal(s.addNote({ from: "agent", anchor: { type: "board" }, text: "d", depth: "deep" }).depth, undefined, "agent replies carry no depth");
  const saved = s.saveAttachment(Buffer.from("x"), "png");
  const n = s.addNote({ anchor: { type: "board" }, text: "e", attachments: [saved.file, "../etc/passwd", "nope.png"] });
  assert.deepEqual(n.attachments, [saved.file]);
  assert.equal(s.attachmentPath("../x.png"), null);
  assert.equal(s.attachmentInfo(saved.file).type, "image/png");
});

test("the sidecar .gitignore gains missing lines without losing custom ones", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, ".gitignore"), "visits.json\nmy-own-line\n");
  new BoardStore(dir);
  const text = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.deepEqual(text.trim().split("\n"), ["visits.json", "my-own-line", "*.tmp", "whiteboards/", "workflow/writer.lock", "workflow/writer.guard", "workflow/snapshot.json", "workflow/journal.jsonl"]);
  new BoardStore(dir);
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), text, "idempotent");
});
