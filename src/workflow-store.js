// One durable transaction per line: state and its event cannot disagree after a
// crash. Snapshots are disposable caches; the journal is the source of truth.
import fs from "node:fs";
import path from "node:path";
import { digest, fail, initialWorkflow, uid, WORKFLOW_VERSION } from "./workflow-schema.js";
import { ensureDir, writeJsonAtomic } from "./paths.js";

export class WorkflowStore {
  constructor(boardDir, { readonly = false } = {}) {
    this.dir = path.join(boardDir, "workflow");
    this.file = path.join(this.dir, "journal.jsonl");
    this.lockFile = path.join(this.dir, "writer.lock");
    this.readonly = readonly;
    this.state = initialWorkflow();
    this.events = [];
    this.receipts = new Map();
    this.lock = null;
    if (!readonly) this.acquire();
    try { this.load(); } catch (err) { this.close(); throw err; }
  }

  acquire() {
    ensureDir(this.dir);
    const record = { pid: process.pid, token: uid("lock"), at: new Date().toISOString() };
    // Serialize *all* acquisitions, including recovery. A check-then-unlink of
    // a stale writer lock alone can delete a newly acquired live owner's lock.
    const guard = path.join(this.dir, "writer.guard");
    let guardFd;
    try { guardFd = fs.openSync(guard, "wx", 0o600); }
    catch (err) {
      if (err.code === "EEXIST") fail("Board lock acquisition is in progress. If its process crashed, inspect workflow/writer.guard before removing the abandoned guard", "BOARD_LOCKED", 409);
      throw err;
    }
    try {
      fs.writeFileSync(guardFd, JSON.stringify(record)); fs.fsyncSync(guardFd);
      if (fs.existsSync(this.lockFile)) {
        let old;
        try { old = JSON.parse(fs.readFileSync(this.lockFile, "utf8")); } catch { fail("Workflow writer lock is unreadable; inspect it before recovery", "BOARD_LOCKED", 409); }
        if (!Number.isInteger(old.pid) || old.pid <= 0) fail("Invalid workflow writer lock", "BOARD_LOCKED", 409);
        try { process.kill(old.pid, 0); fail("Another server owns this board", "BOARD_LOCKED", 409); }
        catch (e) { if (e.code !== "ESRCH") throw e; }
        fs.unlinkSync(this.lockFile);
      }
      try {
        const fd = fs.openSync(this.lockFile, "wx", 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        this.lock = record;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        fail("Another server owns this board", "BOARD_LOCKED", 409);
      }
    } finally {
      fs.closeSync(guardFd);
      fs.unlinkSync(guard);
    }
  }

  load() {
    let bytes;
    try { bytes = fs.readFileSync(this.file); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    let start = 0;
    let previous = "";
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      const line = bytes.subarray(start, end).toString("utf8");
      let record;
      try { record = JSON.parse(line); } catch { fail(`Corrupt workflow journal at byte ${start}`, "JOURNAL_CORRUPT", 409); }
      const { checksum, ...body } = record;
      if (record.schema_version !== WORKFLOW_VERSION || record.sequence !== this.state.revision + 1 || record.previous !== previous || checksum !== digest(body) || record.state?.revision !== record.sequence || record.event?.sequence !== record.sequence) {
        fail(`Invalid workflow transaction at byte ${start}`, "JOURNAL_CORRUPT", 409);
      }
      this.state = record.state;
      this.events.push(record.event);
      if (record.key) this.receipts.set(record.key, { request_hash: record.request_hash, result: record.result });
      previous = checksum;
      start = end + 1;
    }
    // Only an unterminated tail is uncommitted. Never skip a corrupt middle line.
    if (start < bytes.length && !this.readonly) fs.truncateSync(this.file, start);
    this.previous = previous;
  }

  transaction({ key, request = {}, expected_revision, type, actor = "system", links = {} }, mutate) {
    if (this.readonly || !this.lock) fail("Workflow store is read-only", "READ_ONLY", 409);
    let current;
    try { current = JSON.parse(fs.readFileSync(this.lockFile, "utf8")); } catch { /* fail closed */ }
    if (current?.token !== this.lock.token) fail("Workflow writer ownership was lost", "BOARD_LOCKED", 409);
    const requestHash = digest(request);
    if (key && this.receipts.has(key)) {
      const receipt = this.receipts.get(key);
      if (receipt.request_hash !== requestHash) fail("Idempotency key was already used for a different request", "IDEMPOTENCY_CONFLICT", 409);
      return structuredClone(receipt.result);
    }
    if (expected_revision !== undefined && expected_revision !== this.state.revision) fail("Workflow revision changed; refresh and retry", "REVISION_CONFLICT", 409);
    const state = structuredClone(this.state);
    const at = new Date().toISOString();
    const result = mutate(state, at) ?? { ok: true };
    state.revision++;
    const event = { schema_version: WORKFLOW_VERSION, sequence: state.revision, id: uid("event"), at, type, actor, ...links, detail: structuredClone(result) };
    const body = { schema_version: WORKFLOW_VERSION, sequence: state.revision, previous: this.previous || "", key: key || null, request_hash: requestHash, result, event, state };
    const checksum = digest(body);
    const fd = fs.openSync(this.file, "a", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ ...body, checksum }) + "\n"); fs.fsyncSync(fd); }
    catch (error) { this.readonly = true; throw error; }
    finally { fs.closeSync(fd); }
    this.state = state;
    this.events.push(event);
    this.previous = checksum;
    if (key) this.receipts.set(key, { request_hash: requestHash, result: structuredClone(result) });
    // A failed cache write cannot turn a committed transaction into a failure.
    try { writeJsonAtomic(path.join(this.dir, "snapshot.json"), { checksum, state }); } catch { /* rebuilt on next mutation */ }
    return structuredClone(result);
  }

  close() {
    if (!this.lock) return;
    try {
      const current = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
      if (current.token === this.lock.token) fs.unlinkSync(this.lockFile);
    } catch { /* no longer ours */ }
    this.lock = null;
  }
}
