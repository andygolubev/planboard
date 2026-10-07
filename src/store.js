// Per-board persistence: notes (the conversation, anchored to plan elements),
// the derived status log, visit markers, the last plan snapshot for diffing,
// attachments (pasted screenshots, whiteboard sketches) and whiteboard scenes.
// Small files, one writer (the server), rewritten atomically or appended.

import fs from "node:fs";
import path from "node:path";

import { appendJsonl, ensureDir, readJson, readJsonl, shortId, writeJsonAtomic } from "./paths.js";

export const VISIT_GAP_MS = 30 * 60 * 1000;
export const DEPTHS = ["quick", "normal", "deep"];
export const ATTACHMENT_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/vnd.excalidraw+json": "excalidraw",
};
export const ATTACHMENT_EXT_TYPE = Object.fromEntries(Object.entries(ATTACHMENT_TYPES).map(([t, e]) => [e, t]));
ATTACHMENT_EXT_TYPE.jpeg = "image/jpeg";
export const MAX_ATTACHMENTS_PER_NOTE = 8;
const ATTACHMENT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|jpe?g|gif|webp|excalidraw)$/;
// The sidecar lines planboard keeps out of git: one machine's viewing state and
// the autosaved whiteboard working scenes (large, rewritten on every stroke).
const SIDECAR_IGNORES = ["visits.json", "*.tmp", "whiteboards/", "workflow/writer.lock", "workflow/writer.guard", "workflow/snapshot.json", "workflow/journal.jsonl"];

export function anchorKey(anchor) {
  if (!anchor || !anchor.type || anchor.type === "board") return "board";
  switch (anchor.type) {
    case "item":
      return `item:${anchor.item}`;
    case "section":
      return `section:${anchor.section}`;
    case "node":
      return `node:${anchor.diagram}/${anchor.node}`;
    case "diagram":
      return `diagram:${anchor.diagram}`;
    case "image":
      return `image:${anchor.src}`;
    case "text":
      return anchor.item ? `item:${anchor.item}` : anchor.section ? `section:${anchor.section}` : "board";
    default:
      return "board";
  }
}

// Validate an anchor coming from the browser (untrusted) down to a fixed shape.
export function normalizeAnchor(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  const str = (v, n = 200) => (v === undefined || v === null ? undefined : String(v).slice(0, n));
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);
  switch (a.type) {
    case "item":
      return { type: "item", item: str(a.item) || "" };
    case "section":
      return { type: "section", section: str(a.section) || "" };
    case "node":
      return { type: "node", diagram: str(a.diagram) || "", node: str(a.node) || "", label: str(a.label, 120) };
    case "diagram":
      return { type: "diagram", diagram: str(a.diagram) || "" };
    case "image":
      return { type: "image", src: str(a.src, 500) || "", x: num(a.x), y: num(a.y) };
    case "text":
      return { type: "text", item: str(a.item), section: str(a.section), quote: str(a.quote, 1000) || "" };
    default:
      return { type: "board" };
  }
}

export function normalizeDepth(value, fallback = "normal") {
  const d = String(value ?? "").trim().toLowerCase();
  return DEPTHS.includes(d) ? d : fallback;
}

export function isAttachmentFile(name) {
  return ATTACHMENT_FILE_RE.test(String(name || ""));
}

export function safeDiagramFile(diagramId) {
  const s = String(diagramId || "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 80);
  return s || "diagram";
}

export class BoardStore {
  constructor(dir) {
    this.dir = dir;
    this.notesFile = path.join(dir, "notes.json");
    this.eventsFile = path.join(dir, "events.jsonl");
    this.visitsFile = path.join(dir, "visits.json");
    this.snapshotFile = path.join(dir, "snapshot.json");
    this.attachmentsDir = path.join(dir, "attachments");
    this.whiteboardsDir = path.join(dir, "whiteboards");
    this.load();
  }

  load() {
    ensureDir(this.dir);
    this.ensureSidecarGitignore();
    this.notes = readJson(this.notesFile, []);
    this.events = readJsonl(this.eventsFile);
    this.visits = readJson(this.visitsFile, {});
    this.snapshot = readJson(this.snapshotFile, null);
  }

  saveNotes() {
    writeJsonAtomic(this.notesFile, this.notes);
  }

  // The sidecar is meant to be committed with the plan (notes, replies, the
  // status history and attachments are project knowledge); visits.json is one
  // machine's viewing state and whiteboards/ holds autosaved working scenes, so
  // both stay out. Idempotent: adds any missing line to an existing file.
  ensureSidecarGitignore() {
    const file = path.join(this.dir, ".gitignore");
    let existing = "";
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      existing = "";
    }
    const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missing = SIDECAR_IGNORES.filter((l) => !have.has(l));
    if (existing && !missing.length) return;
    try {
      fs.writeFileSync(file, (existing ? existing.replace(/\s*$/, "\n") : "") + missing.join("\n") + "\n");
    } catch {
      // read-only location: nothing to do
    }
  }

  newNoteId() {
    let id = shortId("n");
    while (this.notes.some((n) => n.id === id)) id = shortId("n");
    return id;
  }

  // A user note starts `queued` (visible only in the browser), becomes `sent`
  // when the user presses Send, and `delivered` once a poll has returned it.
  // Agent replies are `delivered` on arrival: they are for the user.
  // `depth` (quick · normal · deep) tells the agent how hard to work on a note;
  // `attachments` are file names inside attachments/; `kind` marks special
  // notes such as whiteboard sketches.
  addNote({ from = "user", anchor, text, quote, reply_to, at, depth, attachments, kind } = {}) {
    const note = {
      id: this.newNoteId(),
      at: at || new Date().toISOString(),
      from: from === "agent" ? "agent" : "user",
      anchor: normalizeAnchor(anchor),
      text: String(text ?? "").slice(0, 20000),
      state: from === "agent" ? "delivered" : "queued",
    };
    if (note.from === "user") {
      const d = normalizeDepth(depth);
      if (d !== "normal") note.depth = d;
    }
    if (quote) note.quote = String(quote).slice(0, 1000);
    if (reply_to) note.reply_to = String(reply_to).slice(0, 40);
    const files = this.validAttachments(attachments);
    if (files.length) note.attachments = files;
    if (kind && /^[a-z][a-z0-9_-]{0,30}$/.test(String(kind))) note.kind = String(kind);
    this.notes.push(note);
    this.saveNotes();
    return note;
  }

  validAttachments(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list.slice(0, MAX_ATTACHMENTS_PER_NOTE)) {
      const name = String(raw || "");
      if (!isAttachmentFile(name) || out.includes(name)) continue;
      if (!fs.existsSync(path.join(this.attachmentsDir, name))) continue;
      out.push(name);
    }
    return out;
  }

  removeNote(id) {
    const idx = this.notes.findIndex((n) => n.id === id);
    if (idx < 0) return { removed: false, reason: "not-found" };
    if (this.notes[idx].state !== "queued") return { removed: false, reason: "already-sent" };
    const [note] = this.notes.splice(idx, 1);
    this.saveNotes();
    for (const f of note.attachments || []) this.removeAttachmentIfUnreferenced(f);
    return { removed: true, note };
  }

  queued() {
    return this.notes.filter((n) => n.state === "queued");
  }

  sendQueued(ids = null) {
    const at = new Date().toISOString();
    const sent = [];
    for (const n of this.notes) {
      if (n.state !== "queued") continue;
      if (ids && !ids.includes(n.id)) continue;
      n.state = "sent";
      n.sent_at = at;
      sent.push(n);
    }
    if (sent.length) this.saveNotes();
    return sent;
  }

  pending() {
    return this.notes.filter((n) => n.state === "sent");
  }

  // Delivery is at-least-once: the caller marks delivered only after it has
  // written the response; `restore` puts a batch back if that write failed.
  takePending(ids = null) {
    const at = new Date().toISOString();
    const taken = this.pending().filter((n) => !ids || ids.includes(n.id));
    for (const n of taken) {
      n.state = "delivered";
      n.delivered_at = at;
    }
    if (taken.length) this.saveNotes();
    return taken;
  }

  restore(ids) {
    let changed = false;
    for (const n of this.notes) {
      if (ids.includes(n.id) && n.state === "delivered" && n.from === "user") {
        n.state = "sent";
        delete n.delivered_at;
        changed = true;
      }
    }
    if (changed) this.saveNotes();
    return changed;
  }

  thread(anchor) {
    const key = anchorKey(anchor);
    return this.notes.filter((n) => anchorKey(n.anchor) === key);
  }

  threadsSummary() {
    const out = {};
    for (const n of this.notes) {
      const key = anchorKey(n.anchor);
      const s = (out[key] ||= { key, anchor: n.anchor, count: 0, queued: 0, pending: 0, attachments: 0, last_at: null, last_from: null });
      s.count++;
      if (n.state === "queued") s.queued++;
      if (n.state === "sent") s.pending++;
      if (n.attachments) s.attachments += n.attachments.length;
      if (!s.last_at || n.at >= s.last_at) {
        s.last_at = n.at;
        s.last_from = n.from;
      }
    }
    return out;
  }

  // ---- attachments -------------------------------------------------------------

  // Store bytes under attachments/ with a fresh name; the caller has already
  // checked the type. Returns the file name the note will reference.
  saveAttachment(buffer, ext, { stem = "a" } = {}) {
    const e = String(ext).toLowerCase() === "jpeg" ? "jpg" : String(ext).toLowerCase();
    if (!ATTACHMENT_EXT_TYPE[e]) throw new Error(`unsupported attachment type "${ext}"`);
    ensureDir(this.attachmentsDir);
    let name;
    do name = `${stem}_${shortId("").slice(1)}.${e}`;
    while (fs.existsSync(path.join(this.attachmentsDir, name)));
    const file = path.join(this.attachmentsDir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, file);
    return { file: name, path: file, bytes: buffer.length, type: ATTACHMENT_EXT_TYPE[e] };
  }

  attachmentPath(name) {
    if (!isAttachmentFile(name)) return null;
    const p = path.join(this.attachmentsDir, name);
    return fs.existsSync(p) ? p : null;
  }

  attachmentInfo(name) {
    const p = this.attachmentPath(name);
    if (!p) return null;
    const ext = path.extname(name).slice(1).toLowerCase();
    let bytes = 0;
    try {
      bytes = fs.statSync(p).size;
    } catch {
      bytes = 0;
    }
    return { file: name, path: p, type: ATTACHMENT_EXT_TYPE[ext] || "application/octet-stream", bytes };
  }

  removeAttachmentIfUnreferenced(name) {
    if (!isAttachmentFile(name)) return false;
    if (this.notes.some((n) => (n.attachments || []).includes(name))) return false;
    try {
      fs.unlinkSync(path.join(this.attachmentsDir, name));
      return true;
    } catch {
      return false;
    }
  }

  // ---- whiteboard scenes ----------------------------------------------------------

  // The editable Excalidraw scene per diagram, autosaved by the frame while the
  // user draws (lavish-axi's sidecar shape: source_hash, scene, baseline).
  whiteboardFile(diagramId) {
    return path.join(this.whiteboardsDir, `${safeDiagramFile(diagramId)}.json`);
  }

  loadWhiteboard(diagramId) {
    return readJson(this.whiteboardFile(diagramId), null);
  }

  saveWhiteboard(diagramId, { sourceHash, textMetricsVersion = 0, scene, baseline = null }) {
    const record = {
      source_hash: String(sourceHash || ""),
      text_metrics_version: Math.max(0, Math.floor(Number(textMetricsVersion) || 0)),
      updated_at: new Date().toISOString(),
      scene: scene ?? null,
      baseline: baseline ?? null,
    };
    ensureDir(this.whiteboardsDir);
    const file = this.whiteboardFile(diagramId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
    return record;
  }

  // ---- events / snapshot / visits --------------------------------------------------

  appendEvents(events) {
    if (!events.length) return;
    appendJsonl(this.eventsFile, events);
    this.events.push(...events);
  }

  eventsSince(iso) {
    if (!iso) return [];
    return this.events.filter((e) => e.at > iso);
  }

  setSnapshot(snapshot) {
    this.snapshot = snapshot;
    writeJsonAtomic(this.snapshotFile, snapshot);
  }

  // A "visit" is a run of activity with no gap longer than VISIT_GAP_MS. The
  // board highlights what changed since the previous visit ended, which is what
  // a person coming back to the whiteboard the next morning wants to see.
  touchVisit(now = Date.now(), gapMs = VISIT_GAP_MS) {
    const v = this.visits;
    let newVisit = false;
    if (!v.last_seen || now - v.last_seen > gapMs) {
      v.previous_end = v.last_seen || null;
      v.current_start = now;
      newVisit = true;
    }
    v.last_seen = now;
    writeJsonAtomic(this.visitsFile, v);
    return {
      since: v.previous_end ? new Date(v.previous_end).toISOString() : null,
      visit_started: new Date(v.current_start).toISOString(),
      new_visit: newVisit,
    };
  }

  visitInfo() {
    const v = this.visits;
    return {
      since: v.previous_end ? new Date(v.previous_end).toISOString() : null,
      visit_started: v.current_start ? new Date(v.current_start).toISOString() : null,
      last_seen: v.last_seen ? new Date(v.last_seen).toISOString() : null,
    };
  }
}
