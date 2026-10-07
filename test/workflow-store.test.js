import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkflowStore } from "../src/workflow-store.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("workflow transactions replay, deduplicate, fence revisions, and rebuild caches", (t) => {
  const dir = fixture(t);
  let store = new WorkflowStore(dir);
  const request = { task: "a" };
  const call = () => store.transaction({ key: "one", request, type: "run.created" }, (s) => { s.runs.a = { id: "a" }; return s.runs.a; });
  assert.deepEqual(call(), { id: "a" });
  assert.deepEqual(call(), { id: "a" });
  assert.equal(store.state.revision, 1);
  assert.throws(() => store.transaction({ key: "one", request: {}, type: "x" }, () => {}), /different request/);
  assert.throws(() => store.transaction({ expected_revision: 0, type: "x" }, () => {}), /revision changed/);
  assert.throws(() => new WorkflowStore(dir), /Another server/);
  store.close();
  fs.writeFileSync(path.join(dir, "workflow/snapshot.json"), "broken cache");
  store = new WorkflowStore(dir);
  t.after(() => store.close());
  assert.equal(store.state.runs.a.id, "a");
  assert.equal(call().id, "a");
  assert.equal(store.events.length, 1);
});
test("workflow recovers only an uncommitted tail and refuses middle corruption", (t) => {
  const dir = fixture(t);
  let store = new WorkflowStore(dir);
  store.transaction({ type: "first" }, () => ({ ok: true }));
  const journal = store.file;
  store.close();
  fs.appendFileSync(journal, '{"incomplete":');
  store = new WorkflowStore(dir);
  assert.equal(store.state.revision, 1);
  store.transaction({ type: "second" }, () => ({ ok: true }));
  store.close();
  const text = fs.readFileSync(journal, "utf8").replace('"first"', '"wrong"');
  fs.writeFileSync(journal, text);
  assert.throws(() => new WorkflowStore(dir), /Invalid workflow transaction/);
  assert.equal(fs.existsSync(path.join(dir, "workflow/writer.lock")), false);
});

test("lock recovery is serialized and lost ownership blocks appends", (t) => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, "workflow"));
  fs.writeFileSync(path.join(dir, "workflow/writer.guard"), JSON.stringify({ pid: 99999999 }));
  assert.throws(() => new WorkflowStore(dir), /lock acquisition/);
  fs.unlinkSync(path.join(dir, "workflow/writer.guard"));
  fs.writeFileSync(path.join(dir, "workflow/writer.lock"), JSON.stringify({ pid: 99999999, token: "dead" }));
  const store = new WorkflowStore(dir); t.after(() => store.close());
  fs.writeFileSync(store.lockFile, JSON.stringify({ pid: process.pid, token: "other" }));
  assert.throws(() => store.transaction({ type: "wrong-writer" }, () => ({})), /ownership was lost/);
  assert.equal(fs.existsSync(store.file), false);
});
