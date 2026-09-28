// One Board per plan file inside the server: parses the file, watches it, owns
// the store, fans events out to browser tabs, and hands sent notes to the agent's
// long poll. All store operations are synchronous, so there is no interleaving
// to guard against - one process, one writer.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import chokidar from "chokidar";

import { diffSnapshots, snapshotOf } from "./diff.js";
import { boardDir, canonicalPlanPath, planKey } from "./paths.js";
import { STATUS_LABEL, findAnchorTarget, parsePlan, renderMarkdown, setItemStatus } from "./plan.js";
import { ATTACHMENT_TYPES, BoardStore, DEPTHS, anchorKey } from "./store.js";

export class ListenerActiveError extends Error {
  constructor(owner) {
    super(`another poll is already listening on this board${owner ? ` (${owner})` : ""}`);
    this.code = "LISTENER_ACTIVE";
    this.owner = owner;
  }
}

export function sourceHash(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

export class Board extends EventEmitter {
  constructor(planPath, { log = () => {}, version = "0.0.0", baseUrl = "", features = {} } = {}) {
    super();
    this.path = canonicalPlanPath(planPath);
    this.key = planKey(this.path);
    this.dir = boardDir(this.path);
    this.version = version;
    this.baseUrl = baseUrl;
    this.features = { whiteboard: false, ...features };
    this.log = log;
    this.store = new BoardStore(this.dir);
    this.model = null;
    this.error = null;
    this.updatedAt = null;
    this.clients = new Set();
    this.poll = null;
    this.presence = "waiting";
    this.pollOwner = null;
    this.watcher = null;
    this.lastEvents = [];
  }

  get url() {
    return `${this.baseUrl}/boards/${this.key}`;
  }

  get assetBase() {
    return `/boards/${this.key}/asset/`;
  }

  get attachmentBase() {
    return `/boards/${this.key}/attachment/`;
  }

  start() {
    this.refresh();
    this.watcher = chokidar.watch(this.path, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 },
    });
    this.watcher.on("add", () => this.refresh());
    this.watcher.on("change", () => this.refresh());
    this.watcher.on("unlink", () => this.refresh());
    this.watcher.on("error", (err) => this.log(`watcher error for ${this.path}: ${err.message}`));
    return this;
  }

  async close() {
    if (this.watcher) await this.watcher.close().catch(() => {});
    this.watcher = null;
    if (this.poll) {
      const p = this.poll;
      this.poll = null;
      clearTimeout(p.timer);
      p.resolve({ status: "closed" });
    }
    for (const ws of this.clients) {
      try {
        ws.close(1001, "board closed");
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  refresh() {
    let source;
    try {
      source = fs.readFileSync(this.path, "utf8");
    } catch (err) {
      this.error = err.code === "ENOENT" ? "plan file not found" : `cannot read plan: ${err.message}`;
      this.updatedAt = new Date().toISOString();
      this.broadcast({ type: "plan", events: [], error: this.error });
      return;
    }
    const model = parsePlan(source, { assetBase: this.assetBase });
    const next = snapshotOf(model);
    const events = diffSnapshots(this.store.snapshot, next);
    if (events.length) this.store.appendEvents(events);
    // Re-save when the snapshot shape grew (older snapshots lack diagram sources).
    const shapeChanged = this.store.snapshot && this.store.snapshot.diagrams.some((d) => typeof d.source !== "string") && next.diagrams.length;
    if (!this.store.snapshot || events.length || shapeChanged) this.store.setSnapshot(next);
    this.source = source;
    this.model = model;
    this.error = null;
    this.updatedAt = new Date().toISOString();
    this.lastEvents = events;
    if (events.length) this.log(`${path.basename(this.path)}: ${events.length} change(s)`);
    this.emit("plan", events);
    this.broadcast({ type: "plan", events });
  }

  // ---- state for the browser -------------------------------------------------

  state() {
    const m = this.model;
    const visit = this.store.visitInfo();
    const sinceIso = visit.since || visit.visit_started;
    const notes = this.store.notes.map((n) => this.decorateNote(n));
    return {
      app: "planboard",
      version: this.version,
      key: this.key,
      path: this.path,
      dir: this.dir,
      url: this.url,
      title: m ? m.title : path.basename(this.path),
      counts: m ? m.counts : null,
      sections: m ? m.sections : [],
      items: m ? m.items : [],
      diagrams: m ? m.diagrams.map((d) => ({ id: d.id, section: d.section, line: d.line, hash: sourceHash(d.source) })) : [],
      images: m ? m.images : [],
      html: m ? m.html : "",
      error: this.error,
      updated_at: this.updatedAt,
      notes,
      threads: this.store.threadsSummary(),
      presence: this.presence,
      poll_owner: this.pollOwner,
      visit,
      since: sinceIso,
      since_basis: visit.since ? "visit" : "open",
      events_since: this.store.eventsSince(sinceIso).slice(-500),
      recent_events: this.store.events.slice(-120),
      status_labels: STATUS_LABEL,
      depths: DEPTHS,
      attachment_base: this.attachmentBase,
      attachment_types: Object.keys(ATTACHMENT_TYPES).filter((t) => t.startsWith("image/")),
      features: this.features,
    };
  }

  summary() {
    const m = this.model;
    return {
      key: this.key,
      path: this.path,
      url: this.url,
      title: m ? m.title : path.basename(this.path),
      counts: m ? m.counts : null,
      presence: this.presence,
      queued: this.store.queued().length,
      pending: this.store.pending().length,
      error: this.error,
      updated_at: this.updatedAt,
    };
  }

  decorateNote(note) {
    const out = { ...note };
    if (note.from === "agent") out.html = renderMarkdown(note.text);
    out.label = this.anchorLabel(note.anchor);
    return out;
  }

  anchorLabel(anchor) {
    const m = this.model;
    if (!anchor || anchor.type === "board") return "Whole plan";
    if (!m) return anchorKey(anchor);
    const sectionTitle = (id) => {
      const s = m.sections.find((x) => x.id === id);
      return s ? s.title : id;
    };
    switch (anchor.type) {
      case "item":
      case "text": {
        if (anchor.item) {
          const item = m.items.find((i) => i.id === anchor.item);
          if (!item) return `item ${anchor.item} (no longer in the plan)`;
          return `${item.section ? sectionTitle(item.section) + " › " : ""}${item.text}`;
        }
        if (anchor.section) return sectionTitle(anchor.section);
        return "Whole plan";
      }
      case "section":
        return sectionTitle(anchor.section);
      case "node":
        return `${anchor.diagram} › ${anchor.label || anchor.node}`;
      case "diagram":
        return `diagram ${anchor.diagram}`;
      case "image":
        return `image ${anchor.src}${typeof anchor.x === "number" ? ` @ ${Math.round(anchor.x * 100)}%,${Math.round(anchor.y * 100)}%` : ""}`;
      default:
        return anchorKey(anchor);
    }
  }

  // ---- notes -----------------------------------------------------------------

  addNote({ anchor, text, quote, depth, attachments, kind }) {
    const note = this.store.addNote({ from: "user", anchor, text, quote, depth, attachments, kind });
    this.broadcast({ type: "notes", reason: "queued", ids: [note.id] });
    return this.decorateNote(note);
  }

  removeNote(id) {
    const result = this.store.removeNote(id);
    if (result.removed) this.broadcast({ type: "notes", reason: "removed", ids: [id] });
    return result;
  }

  send(ids = null) {
    const sent = this.store.sendQueued(ids);
    if (sent.length) {
      this.broadcast({ type: "notes", reason: "sent", ids: sent.map((n) => n.id) });
      this.wakePoll();
    }
    return sent;
  }

  reply({ text, to, anchor, attachments }) {
    let target = anchor;
    if (to) {
      const parent = this.store.notes.find((n) => n.id === to);
      if (!parent) throw Object.assign(new Error(`no note with id "${to}"`), { code: "NOT_FOUND" });
      target = parent.anchor;
    }
    const note = this.store.addNote({ from: "agent", anchor: target || { type: "board" }, text, reply_to: to || undefined, attachments });
    this.setPresence(this.poll ? "listening" : "waiting");
    this.broadcast({ type: "notes", reason: "reply", ids: [note.id] });
    return this.decorateNote(note);
  }

  thread(anchor) {
    return this.store.thread(anchor).map((n) => this.decorateNote(n));
  }

  // ---- attachments / whiteboard ------------------------------------------------

  saveAttachment(buffer, contentType) {
    const ext = ATTACHMENT_TYPES[String(contentType || "").split(";")[0].trim().toLowerCase()];
    if (!ext) throw Object.assign(new Error(`unsupported attachment type "${contentType}" (use ${Object.keys(ATTACHMENT_TYPES).join(", ")})`), { code: "BAD_TYPE" });
    const saved = this.store.saveAttachment(buffer, ext);
    return { ...saved, url: this.attachmentBase + encodeURIComponent(saved.file) };
  }

  diagram(id) {
    return this.model ? this.model.diagrams.find((d) => d.id === id) || null : null;
  }

  // A whiteboard session ended with "Queue feedback": store the PNG and the
  // Excalidraw scene beside the plan and queue a user note on the diagram whose
  // text is the edit summary the frame computed, so the agent reads what moved
  // and can look at the picture.
  sketchFeedback(diagramId, { note = "", summaryLines = [], stats = {}, pngDataUrl = "", scene = null, sourceHash: hash = "", imageFallback = false } = {}) {
    const d = this.diagram(diagramId);
    if (!d) throw Object.assign(new Error(`no diagram "${diagramId}" in the plan`), { code: "NOT_FOUND" });
    const attachments = [];
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(pngDataUrl || ""));
    if (m) attachments.push(this.store.saveAttachment(Buffer.from(m[1], "base64"), "png", { stem: `sketch-${d.id}` }).file);
    if (scene && typeof scene === "object") {
      const sceneJson = {
        type: "excalidraw",
        version: 2,
        source: "planboard",
        elements: Array.isArray(scene.elements) ? scene.elements : [],
        appState: scene.appState && typeof scene.appState === "object" ? scene.appState : {},
        files: scene.files && typeof scene.files === "object" ? scene.files : {},
      };
      attachments.push(this.store.saveAttachment(Buffer.from(JSON.stringify(sceneJson, null, 2) + "\n"), "excalidraw", { stem: `sketch-${d.id}` }).file);
    }
    const lines = Array.isArray(summaryLines) ? summaryLines.map((l) => String(l).slice(0, 300)).slice(0, 60) : [];
    const counts = ["added", "removed", "moved", "relabeled", "drawn"].map((k) => [k, Number(stats && stats[k]) || 0]).filter(([, v]) => v > 0);
    const header = `Whiteboard edits on diagram \`${d.id}\`${counts.length ? ` (${counts.map(([k, v]) => `${v} ${k}`).join(", ")})` : ""}${imageFallback ? " - drawn over an image of the diagram" : ""}:`;
    const parts = [];
    if (String(note || "").trim()) parts.push(String(note).trim());
    parts.push([header, ...lines.map((l) => `- ${l}`)].join("\n"));
    const text = parts.join("\n\n");
    const created = this.store.addNote({ from: "user", anchor: { type: "diagram", diagram: d.id }, text, attachments, kind: "sketch" });
    if (hash) created.source_hash = String(hash).slice(0, 32);
    this.store.saveNotes();
    this.broadcast({ type: "notes", reason: "queued", ids: [created.id] });
    return this.decorateNote(created);
  }

  // ---- plan edits ------------------------------------------------------------

  setStatus(itemId, status) {
    const source = fs.readFileSync(this.path, "utf8");
    const change = setItemStatus(source, itemId, status);
    const tmp = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, change.source);
    fs.renameSync(tmp, this.path);
    this.refresh();
    return { item: change.item.id, text: change.item.text, from: change.from, to: change.to };
  }

  // ---- agent poll ------------------------------------------------------------

  // Returns `{ promise, poll }`: the promise resolves with the sent-but-undelivered
  // notes as soon as there are any, or `{status: "waiting"}` after timeoutMs
  // (0 = wait forever); `poll` is this caller's registration (null when the answer
  // was immediate or refused) and is the only handle `releasePoll` accepts, so a
  // refused second poll can never release the first one. The caller marks
  // delivery only after its response is written - see `markDelivered`.
  waitForNotes({ timeoutMs = 0, owner = null, takeover = false } = {}) {
    if (this.poll) {
      if (!takeover) return { promise: Promise.reject(new ListenerActiveError(this.poll.owner)), poll: null };
      const old = this.poll;
      this.poll = null;
      clearTimeout(old.timer);
      old.resolve({ status: "replaced" });
    }
    const pending = this.store.pending();
    if (pending.length) {
      this.pollOwner = owner;
      return { promise: Promise.resolve({ status: "feedback", notes: pending }), poll: null };
    }
    const poll = { owner, resolve: null, timer: null };
    const promise = new Promise((resolve) => {
      poll.resolve = (value) => {
        if (this.poll === poll) this.poll = null;
        clearTimeout(poll.timer);
        if (value.status !== "feedback" && value.status !== "replaced") this.setPresence(this.presence === "working" ? "working" : "waiting");
        resolve(value);
      };
    });
    if (timeoutMs > 0) poll.timer = setTimeout(() => poll.resolve({ status: "waiting" }), timeoutMs);
    this.poll = poll;
    this.pollOwner = owner;
    this.setPresence("listening");
    return { promise, poll };
  }

  wakePoll() {
    if (!this.poll) return;
    const pending = this.store.pending();
    if (!pending.length) return;
    const poll = this.poll;
    poll.resolve({ status: "feedback", notes: pending });
  }

  // The poll request went away (client disconnected or finished). Only the
  // registration returned by `waitForNotes` may release; anything else is a no-op.
  releasePoll(poll) {
    if (!poll) return;
    if (this.poll === poll) {
      this.poll = null;
      clearTimeout(poll.timer);
    }
    if (!this.poll && this.presence === "listening") this.setPresence("waiting");
  }

  markDelivered(ids) {
    const taken = this.store.takePending(ids);
    if (taken.length) {
      this.setPresence("working");
      this.broadcast({ type: "notes", reason: "delivered", ids: taken.map((n) => n.id) });
    }
    return taken;
  }

  // What the agent receives for one note: the note, the plan element it points
  // at as it is right now, the whole thread on that element so far, and the
  // files attached to it (absolute paths - the agent reads them with its own tools).
  notesForAgent(notes) {
    const m = this.model;
    return notes.map((n) => {
      const out = { id: n.id, at: n.at, depth: n.depth || "normal", anchor: n.anchor, label: this.anchorLabel(n.anchor), text: n.text };
      if (n.kind) out.kind = n.kind;
      const quote = n.quote || (n.anchor.type === "text" ? n.anchor.quote : undefined);
      if (quote) out.quote = quote;
      if (n.attachments && n.attachments.length) {
        out.attachments = n.attachments.map((f) => this.store.attachmentInfo(f)).filter(Boolean);
      }
      if (m) {
        const target = findAnchorTarget(m, n.anchor.type === "text" ? (n.anchor.item ? { type: "item", item: n.anchor.item } : { type: "section", section: n.anchor.section }) : n.anchor);
        if (target && (n.anchor.type === "item" || (n.anchor.type === "text" && n.anchor.item))) {
          out.item = { id: target.id, text: target.text, status: target.status, section: target.section, line: target.line };
        } else if (target && (n.anchor.type === "section" || n.anchor.type === "text")) {
          out.section = { id: target.id, title: target.title, line: target.line };
        } else if (target && (n.anchor.type === "node" || n.anchor.type === "diagram")) {
          out.diagram = { id: target.id, line: target.line, source: target.source };
        }
      }
      out.thread = this.store
        .thread(n.anchor)
        .filter((t) => t.id !== n.id)
        .map((t) => ({
          id: t.id,
          at: t.at,
          from: t.from,
          text: t.text,
          ...(t.reply_to ? { reply_to: t.reply_to } : {}),
          ...(t.attachments && t.attachments.length ? { attachments: t.attachments.map((f) => this.store.attachmentInfo(f)).filter(Boolean).map((a) => a.path) } : {}),
        }));
      return out;
    });
  }

  // ---- presence / clients ------------------------------------------------------

  setPresence(state) {
    if (this.presence === state) return;
    this.presence = state;
    this.broadcast({ type: "presence", presence: state, owner: this.pollOwner });
  }

  attachClient(ws) {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    this.send_(ws, { type: "hello", presence: this.presence, owner: this.pollOwner });
  }

  send_(ws, msg) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    } catch {
      this.clients.delete(ws);
    }
  }

  broadcast(msg) {
    const payload = { at: new Date().toISOString(), ...msg };
    for (const ws of this.clients) this.send_(ws, payload);
  }

  touchVisit() {
    return this.store.touchVisit();
  }
}
