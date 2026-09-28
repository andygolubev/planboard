// The local server: one process, every board. Express for HTTP, `ws` for the
// live channel the browser listens on. Binds loopback unless told otherwise.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";
import { WebSocketServer } from "ws";

import { Board, ListenerActiveError } from "./board.js";
import { exportMarkdown } from "./export.js";
import { feedbackNextStep } from "./guidance.js";
import { boardsRegistryPath, canonicalPlanPath, ensureDir, isLoopbackHost, planKey, readJson, serverInfoPath, stateRoot, writeJsonAtomic } from "./paths.js";
import { STATUS_LABEL } from "./plan.js";
import { ATTACHMENT_TYPES, isAttachmentFile } from "./store.js";
import { PACKAGE_ROOT, version as packageVersion } from "./version.js";

const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]", "::1"];

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function localInterfaceAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) out.add(iface.family === "IPv6" ? `[${iface.address}]` : iface.address);
  }
  return out;
}

function hostOf(header) {
  const h = String(header || "").trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("[")) return h.replace(/\]:\d+$/, "]");
  return h.replace(/:\d+$/, "");
}

function clientDir() {
  const dist = path.join(PACKAGE_ROOT, "dist", "client");
  if (fs.existsSync(path.join(dist, "app.js"))) return dist;
  return path.join(PACKAGE_ROOT, "client");
}

// The Excalidraw whiteboard frame is lavish-axi's built bundle: copied into
// dist/whiteboard by `npm run build`, or read straight from the dev dependency.
// Absent bundle = the board simply offers no whiteboard button.
export function whiteboardDir() {
  const candidates = [path.join(PACKAGE_ROOT, "dist", "whiteboard"), path.join(PACKAGE_ROOT, "node_modules", "lavish-axi", "dist", "whiteboard")];
  return candidates.find((d) => fs.existsSync(path.join(d, "whiteboard.js"))) || null;
}

export class BoardRegistry {
  constructor(file) {
    this.file = file;
    this.entries = readJson(file, {});
  }
  add(canonical) {
    const key = planKey(canonical);
    if (!this.entries[key]) {
      this.entries[key] = { path: canonical, added_at: new Date().toISOString() };
      writeJsonAtomic(this.file, this.entries);
    }
    return key;
  }
  remove(key) {
    if (this.entries[key]) {
      delete this.entries[key];
      writeJsonAtomic(this.file, this.entries);
    }
  }
}

export async function serve({ host = "127.0.0.1", port = 4747, log = () => {}, openPlan = null } = {}) {
  const version = packageVersion();
  const hosts = [host];
  if (!isLoopbackHost(host) && host !== "0.0.0.0" && host !== "::") hosts.push("127.0.0.1");
  const linkHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const baseUrl = `http://${linkHost.includes(":") && !linkHost.startsWith("[") ? `[${linkHost}]` : linkHost}:${port}`;

  ensureDir(stateRoot());
  const registry = new BoardRegistry(boardsRegistryPath());
  const boards = new Map();
  const wbDir = whiteboardDir();
  const features = { whiteboard: Boolean(wbDir) };

  function boardFor(planPath, { register = true } = {}) {
    const canonical = canonicalPlanPath(planPath);
    const key = planKey(canonical);
    let board = boards.get(key);
    if (!board) {
      board = new Board(canonical, { log, version, baseUrl, features }).start();
      boards.set(key, board);
      if (register) registry.add(canonical);
    }
    return board;
  }

  for (const entry of Object.values(registry.entries)) {
    if (entry && entry.path && fs.existsSync(entry.path)) {
      try {
        boardFor(entry.path, { register: false });
      } catch (err) {
        log(`could not restore board ${entry.path}: ${err.message}`);
      }
    }
  }
  if (openPlan) boardFor(openPlan);

  // ---- security: Host allowlist (DNS rebinding) + Origin guard ---------------------
  const allowAllHosts = process.env.PLANBOARD_ALLOWED_HOSTS === "*";
  function allowedHost(h) {
    if (allowAllHosts) return true;
    if (LOOPBACK_NAMES.includes(h)) return true;
    if (hosts.includes(h) || h === linkHost.toLowerCase()) return true;
    if (localInterfaceAddresses().has(h)) return true;
    const extra = (process.env.PLANBOARD_ALLOWED_HOSTS || "").split(/\s+/).filter(Boolean).map((x) => x.toLowerCase());
    return extra.includes(h);
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.use((req, res, next) => {
    const h = hostOf(req.headers.host);
    if (!h || !allowedHost(h)) return res.status(403).type("text").send("forbidden host");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let oh = "";
        try {
          oh = hostOf(new URL(origin).host);
        } catch {
          oh = "";
        }
        if (!oh || !allowedHost(oh)) return res.status(403).type("text").send("forbidden origin");
      }
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const smallJson = express.json({ limit: "2mb" });
  const bigJson = express.json({ limit: "24mb" });
  const rawImage = express.raw({ type: () => true, limit: "12mb" });
  app.use((req, res, next) => {
    if (/^\/boards\/[a-f0-9]{12}\/api\/attachments$/.test(req.path) && req.method === "POST") return rawImage(req, res, next);
    if (/^\/boards\/[a-f0-9]{12}\/api\/whiteboard\//.test(req.path)) return bigJson(req, res, next);
    return smallJson(req, res, next);
  });

  function getBoard(req, res) {
    const board = boards.get(req.params.key);
    if (!board) {
      res.status(404).json({ error: "unknown board", key: req.params.key });
      return null;
    }
    return board;
  }

  // ---- control -----------------------------------------------------------------
  app.get("/health", (req, res) => {
    res.json({ ok: true, app: "planboard", version, pid: process.pid, port, hosts, boards: boards.size, state_root: stateRoot(), features });
  });
  app.post("/shutdown", (req, res) => {
    res.json({ ok: true, stopping: true });
    log("shutdown requested");
    setTimeout(() => shutdown(0), 50);
  });

  app.get("/api/boards", (req, res) => {
    res.json({ boards: [...boards.values()].map((b) => b.summary()) });
  });
  app.post("/api/boards", (req, res) => {
    const p = req.body && req.body.path;
    if (!p || typeof p !== "string") return res.status(400).json({ error: "path required" });
    if (!fs.existsSync(p)) return res.status(404).json({ error: "plan file not found", path: p });
    const board = boardFor(p);
    res.json({ ...board.summary(), dir: board.dir });
  });
  app.delete("/api/boards/:key", async (req, res) => {
    const board = boards.get(req.params.key);
    if (board) {
      await board.close();
      boards.delete(req.params.key);
    }
    registry.remove(req.params.key);
    res.json({ ok: true });
  });

  // ---- pages -------------------------------------------------------------------
  app.get("/", (req, res) => {
    res.type("html").send(renderHome([...boards.values()], version));
  });
  app.get("/boards/:key", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    res.type("html").send(renderBoardPage(board));
  });

  const clientRoot = clientDir();
  app.use(
    "/client",
    express.static(clientRoot, {
      etag: false,
      lastModified: false,
      setHeaders: (r) => r.setHeader("Cache-Control", "no-cache"),
    }),
  );

  // Images and other files referenced from the plan, confined to the plan's
  // directory by lexical check and by real path (a symlink beside the plan must
  // not serve a file outside it - lavish-axi's `resolveArtifactAsset` rule).
  app.get("/boards/:key/asset/*rest", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    const rel = Array.isArray(req.params.rest) ? req.params.rest.join("/") : String(req.params.rest || "");
    const root = path.dirname(board.path);
    const target = path.resolve(root, rel);
    const inside = (p) => p === root || p.startsWith(root + path.sep);
    if (!inside(target)) return res.status(403).type("text").send("outside plan directory");
    let real;
    try {
      real = fs.realpathSync(target);
    } catch {
      return res.status(404).type("text").send("not found");
    }
    let realRoot = root;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      // keep root
    }
    if (!(real === realRoot || real.startsWith(realRoot + path.sep))) return res.status(403).type("text").send("outside plan directory");
    res.sendFile(real, { dotfiles: "deny" }, (err) => {
      if (err && !res.headersSent) res.status(err.status || 500).type("text").send("cannot serve asset");
    });
  });

  // ---- board API (browser) -------------------------------------------------------
  app.get("/boards/:key/api/state", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    res.json(board.state());
  });
  app.post("/boards/:key/api/seen", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    res.json(board.touchVisit());
  });
  app.post("/boards/:key/api/notes", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    const { anchor, text, quote, depth, attachments } = req.body || {};
    const hasFiles = Array.isArray(attachments) && attachments.length > 0;
    if ((!text || !String(text).trim()) && !hasFiles) return res.status(400).json({ error: "text required" });
    res.json({ note: board.addNote({ anchor, text: String(text || "").trim(), quote, depth, attachments }) });
  });
  app.delete("/boards/:key/api/notes/:id", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    const result = board.removeNote(req.params.id);
    if (!result.removed) return res.status(409).json({ error: result.reason });
    res.json({ ok: true });
  });
  app.post("/boards/:key/api/send", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
    const sent = board.send(ids);
    res.json({ sent: sent.map((n) => n.id), presence: board.presence });
  });
  app.get("/boards/:key/api/thread", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    let anchor = { type: "board" };
    if (req.query.item) anchor = { type: "item", item: String(req.query.item) };
    else if (req.query.section) anchor = { type: "section", section: String(req.query.section) };
    else if (req.query.anchor) {
      try {
        anchor = JSON.parse(String(req.query.anchor));
      } catch {
        return res.status(400).json({ error: "anchor must be JSON" });
      }
    }
    res.json({ anchor, label: board.anchorLabel(anchor), notes: board.thread(anchor) });
  });

  app.get("/boards/:key/api/export", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    if (!board.model) return res.status(409).json({ error: board.error || "plan not readable" });
    const stem = path.basename(board.path, path.extname(board.path));
    const md = exportMarkdown({ source: board.source, model: board.model, store: board.store, planPath: board.path, version });
    if (req.query.download !== undefined) res.setHeader("Content-Disposition", `attachment; filename="${stem}-with-threads.md"`);
    res.type("text/markdown; charset=utf-8").send(md);
  });

  // ---- attachments (pasted screenshots, whiteboard sketches) ------------------------
  app.post("/boards/:key/api/attachments", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!ATTACHMENT_TYPES[type]) return res.status(415).json({ error: `unsupported type "${type}"`, accepted: Object.keys(ATTACHMENT_TYPES) });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "empty body" });
    try {
      res.json({ attachment: board.saveAttachment(req.body, type) });
    } catch (err) {
      res.status(err.code === "BAD_TYPE" ? 415 : 500).json({ error: err.message });
    }
  });
  app.delete("/boards/:key/api/attachments/:file", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    if (!isAttachmentFile(req.params.file)) return res.status(400).json({ error: "bad file name" });
    res.json({ removed: board.store.removeAttachmentIfUnreferenced(req.params.file) });
  });
  app.get("/boards/:key/attachment/:file", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    const file = board.store.attachmentPath(req.params.file);
    if (!file) return res.status(404).type("text").send("not found");
    const ext = path.extname(file).slice(1).toLowerCase();
    if (ext === "excalidraw") res.type("application/json");
    res.sendFile(file, { dotfiles: "deny" }, (err) => {
      if (err && !res.headersSent) res.status(err.status || 500).type("text").send("cannot serve attachment");
    });
  });

  // ---- whiteboard (Excalidraw frame from lavish-axi) ---------------------------------
  app.get("/whiteboard-frame", (req, res) => {
    if (!wbDir) return res.status(404).type("text").send("whiteboard bundle not installed - run `npm run build` in planboard");
    res.type("html").send(renderWhiteboardFrame());
  });
  if (wbDir) {
    app.use(
      "/whiteboard-assets",
      express.static(wbDir, {
        etag: false,
        lastModified: false,
        setHeaders: (r, file) => r.setHeader("Cache-Control", /\.(woff2?|ttf)$/.test(file) ? "public, max-age=86400" : "no-cache"),
      }),
    );
  }
  app.get("/boards/:key/api/whiteboard/:diagram", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    const d = board.diagram(req.params.diagram);
    if (!d) return res.status(404).json({ error: "unknown diagram" });
    res.json({ diagram: d.id, source: d.source, whiteboard: board.store.loadWhiteboard(d.id) });
  });
  app.put("/boards/:key/api/whiteboard/:diagram", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    const d = board.diagram(req.params.diagram);
    if (!d) return res.status(404).json({ error: "unknown diagram" });
    const { sourceHash, textMetricsVersion, scene, baseline } = req.body || {};
    if (!scene || typeof scene !== "object") return res.status(400).json({ error: "scene required" });
    const record = board.store.saveWhiteboard(d.id, { sourceHash, textMetricsVersion, scene, baseline });
    res.json({ ok: true, updated_at: record.updated_at });
  });
  app.post("/boards/:key/api/whiteboard/:diagram/feedback", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    try {
      res.json({ note: board.sketchFeedback(req.params.diagram, req.body || {}) });
    } catch (err) {
      res.status(err.code === "NOT_FOUND" ? 404 : 500).json({ error: err.message });
    }
  });

  // ---- board API (agent) --------------------------------------------------------
  app.get("/boards/:key/api/poll", async (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    const timeoutSec = Number(req.query.timeout || 0);
    const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 0;
    const owner = req.query.owner ? String(req.query.owner).slice(0, 80) : null;
    const takeover = req.query.takeover === "1" || req.query.takeover === "true";
    let pollRef = null;
    let closed = false;
    req.on("close", () => {
      closed = true;
      if (pollRef) board.releasePoll(pollRef);
    });
    let result;
    try {
      const wait = board.waitForNotes({ timeoutMs, owner, takeover });
      pollRef = wait.poll;
      result = await wait.promise;
    } catch (err) {
      if (err instanceof ListenerActiveError) return res.status(409).json({ error: err.message, code: err.code, owner: err.owner });
      return res.status(500).json({ error: err.message });
    }
    if (closed) return;
    if (result.status === "feedback") {
      const notes = board.notesForAgent(result.notes);
      const body = {
        status: "feedback",
        plan: { path: board.path, title: board.model ? board.model.title : null, counts: board.model ? board.model.counts : null },
        notes,
        next_step: feedbackNextStep(board.path, notes),
      };
      const ids = result.notes.map((n) => n.id);
      res.on("finish", () => {
        board.markDelivered(ids);
        board.releasePoll(pollRef);
      });
      res.json(body);
      return;
    }
    board.releasePoll(pollRef);
    res.json({ status: result.status, plan: { path: board.path } });
  });
  app.post("/boards/:key/api/reply", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    const { text, to, anchor } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text required" });
    try {
      res.json({ note: board.reply({ text: String(text), to: to ? String(to) : null, anchor }) });
    } catch (err) {
      res.status(err.code === "NOT_FOUND" ? 404 : 500).json({ error: err.message });
    }
  });
  app.post("/boards/:key/api/status", (req, res) => {
    const board = getBoard(req, res);
    if (!board) return;
    const { item, status } = req.body || {};
    try {
      res.json(board.setStatus(String(item || ""), String(status || "")));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.use((err, req, res, _next) => {
    log(`error: ${err && err.stack ? err.stack : err}`);
    if (res.headersSent) return;
    res.status(err && err.status ? err.status : 500).json({ error: err && err.message ? err.message : "server error" });
  });

  // ---- websockets -------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, 30000);
  wss.on("connection", (ws, req, board) => {
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    ws.on("message", () => {}); // browser → server messages are not part of the protocol
    board.attachClient(ws);
  });

  const servers = [];
  function attachUpgrade(server) {
    server.on("upgrade", (req, socket, head) => {
      const h = hostOf(req.headers.host);
      const m = /^\/boards\/([a-f0-9]{12})\/events$/.exec((req.url || "").split("?")[0]);
      const origin = req.headers.origin;
      let originOk = true;
      if (origin) {
        try {
          originOk = allowedHost(hostOf(new URL(origin).host));
        } catch {
          originOk = false;
        }
      }
      if (!h || !allowedHost(h) || !originOk || !m || !boards.has(m[1])) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, boards.get(m[1])));
    });
  }

  async function listen(bindHost) {
    const server = http.createServer(app);
    attachUpgrade(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, bindHost, () => {
        server.removeListener("error", reject);
        server.on("error", (err) => log(`listener ${bindHost}:${port} error: ${err.message}`));
        resolve();
      });
    });
    servers.push(server);
  }
  for (const h of hosts) {
    try {
      await listen(h);
      log(`listening on http://${h}:${port}`);
    } catch (err) {
      if (h === hosts[0]) throw err;
      log(`could not also bind ${h}:${port}: ${err.message}`);
    }
  }

  const info = { pid: process.pid, port, hosts, url: baseUrl, version, started_at: new Date().toISOString(), state_root: stateRoot() };
  writeJsonAtomic(serverInfoPath(), info);

  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    for (const board of boards.values()) await board.close();
    for (const s of servers) s.close();
    for (const ws of wss.clients) ws.terminate();
    try {
      const current = readJson(serverInfoPath(), null);
      if (current && current.pid === process.pid) fs.unlinkSync(serverInfoPath());
    } catch {
      // ignore
    }
    log("stopped");
    if (code !== null) setTimeout(() => process.exit(code), 20).unref();
  }
  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));

  const idleMs = Number(process.env.PLANBOARD_IDLE_TIMEOUT_MS || 0);
  if (idleMs > 0) {
    setInterval(() => {
      const busy = [...boards.values()].some((b) => b.clients.size > 0 || b.poll);
      if (busy) lastBusy = Date.now();
      else if (Date.now() - lastBusy > idleMs) {
        log(`idle for ${idleMs}ms, stopping`);
        shutdown(0);
      }
    }, 30000).unref();
  }
  let lastBusy = Date.now();

  return { info, boards, boardFor, close: () => shutdown(null) };
}

// ---- page shells ------------------------------------------------------------------

// The whiteboard frame page (lavish-axi's shell, verbatim in shape): the bundle
// finds its fonts through EXCALIDRAW_ASSET_PATH = /whiteboard-assets/, which is
// why the assets keep that path.
function renderWhiteboardFrame() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>planboard whiteboard</title>
<link rel="stylesheet" href="/whiteboard-assets/whiteboard.css">
</head>
<body>
<script>window.__lavishWhiteboardChannelToken="planboard";</script>
<script src="/whiteboard-assets/whiteboard.js"></script>
</body>
</html>`;
}

function renderHome(boards, version) {
  const rows = boards
    .map((b) => {
      const s = b.summary();
      const c = s.counts || { total: 0, done: 0 };
      const pct = c.total ? Math.round((100 * c.done) / c.total) : 0;
      return `<li class="board-row"><a href="${escapeHtml(s.url)}"><span class="board-title">${escapeHtml(s.title)}</span><span class="board-path">${escapeHtml(s.path)}</span></a><span class="board-progress"><span class="bar"><i style="width:${pct}%"></i></span>${c.done}/${c.total}</span><span class="presence presence-${escapeHtml(s.presence)}" title="agent ${escapeHtml(s.presence)}"></span></li>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>planboard</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Crect width=%2732%27 height=%2732%27 rx=%277%27 fill=%27%232456d6%27/%3E%3Cpath d=%27M9 16.5l4.5 4.5L23 12%27 fill=%27none%27 stroke=%27%23fff%27 stroke-width=%273.2%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E"><link rel="stylesheet" href="/client/board.css"></head><body class="home"><header class="topbar"><div class="brand">planboard</div><div class="muted">${escapeHtml(version)}</div></header><main class="home-main"><h1>Boards</h1>${rows ? `<ul class="board-list">${rows}</ul>` : `<p class="muted">No boards yet. Run <code>planboard PLAN.md</code> in a project.</p>`}</main></body></html>`;
}

function renderBoardPage(board) {
  const state = board.state();
  const json = JSON.stringify(state).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(state.title)} · planboard</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Crect width=%2732%27 height=%2732%27 rx=%277%27 fill=%27%232456d6%27/%3E%3Cpath d=%27M9 16.5l4.5 4.5L23 12%27 fill=%27none%27 stroke=%27%23fff%27 stroke-width=%273.2%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E">
<link rel="stylesheet" href="/client/board.css">
<script id="planboard-state" type="application/json">${json}</script>
</head>
<body>
<header class="topbar" id="topbar">
  <a class="brand" href="/" title="All boards">planboard</a>
  <div class="board-name" id="boardTitle">${escapeHtml(state.title)}</div>
  <div class="progress" id="progress"></div>
  <button type="button" class="changes-chip" id="changesChip" hidden></button>
  <div class="spacer"></div>
  <a class="top-link" id="exportLink" href="/boards/${escapeHtml(state.key)}/api/export?download" title="Download the plan with all threads as one Markdown file">Export</a>
  <button type="button" class="top-link" id="helpBtn" title="Keyboard shortcuts (?)">?</button>
  <div class="presence-wrap" id="presence"></div>
</header>
<div class="layout" id="layout">
  <div class="board-wrap">
    <div class="toolbar" id="toolbar">
      <span class="toolbar-label">Show</span>
      <button type="button" class="filter" data-filter="open" title="Hide done and dropped items (o)">Open</button>
      <button type="button" class="filter" data-filter="changed" title="Only what changed since your last visit (c)">Changed</button>
      <button type="button" class="filter" data-filter="notes" title="Only items with notes (t)">With notes</button>
      <span class="toolbar-count" id="filterCount"></span>
      <span class="spacer"></span>
      <button type="button" class="toolbar-btn" id="collapseBtn" title="Expand or collapse the finished sections">Collapse done</button>
    </div>
    <main id="board" class="board"></main>
    <div class="ruler" id="ruler" title="Where the changes and notes are - click to jump"></div>
  </div>
  <aside class="panel" id="panel">
    <button type="button" class="sheet-handle" id="sheetHandle" aria-label="Open the notes panel"><span class="sheet-grip"></span><span class="sheet-title" id="sheetTitle">Whole plan</span><span class="sheet-badge" id="sheetBadge" hidden></span></button>
    <div class="panel-head">
      <div class="panel-context" id="panelContext"></div>
      <nav class="tabs" id="tabs">
        <button class="tab active" data-tab="thread">Thread</button>
        <button class="tab" data-tab="activity">Activity</button>
        <button class="tab" data-tab="changes">Changes</button>
      </nav>
    </div>
    <div class="panel-scroll" id="panelScroll"></div>
    <form class="composer" id="composer">
      <div class="attach-strip" id="attachStrip" hidden></div>
      <textarea id="composerText" rows="3" placeholder="Note on the whole plan… (Enter adds, ⌘/Ctrl+Enter adds and sends)"></textarea>
      <div class="composer-row">
        <div class="depth" id="depth" title="How hard the agent should work on this note">
          <button type="button" data-depth="quick" title="Quick: a short answer from what the agent knows, trivial edits only">quick</button>
          <button type="button" data-depth="normal" class="active" title="Normal: read, change, verify, reply briefly">normal</button>
          <button type="button" data-depth="deep" title="Deep: research, weigh alternatives, implement and verify, explain the reasoning">deep</button>
        </div>
        <button type="button" class="icon-btn" id="attachBtn" title="Attach a screenshot (or paste / drop one)">📎</button>
        <input type="file" id="attachInput" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
        <span class="composer-hint" id="composerHint"></span>
        <button type="button" class="btn ghost" id="sendBtn" disabled>Send</button>
        <button type="submit" class="btn primary" id="addBtn">Add note</button>
      </div>
    </form>
  </aside>
</div>
<div class="wb-overlay" id="wbOverlay" hidden>
  <div class="wb-shell">
    <div class="wb-bar"><span class="wb-title" id="wbTitle">Whiteboard</span><span class="wb-hint">Draw on the diagram, then <b>Queue feedback</b> in the frame: the sketch lands in the thread as a note you send like any other.</span><button type="button" class="wb-close" id="wbClose" aria-label="Close whiteboard">×</button></div>
    <div class="wb-error" id="wbError" hidden></div>
    <iframe id="wbFrame" title="Excalidraw whiteboard"></iframe>
  </div>
</div>
<div class="help-overlay" id="helpOverlay" hidden>
  <div class="help-card">
    <h3>Keyboard</h3>
    <dl>
      <dt>j / k</dt><dd>next / previous item</dd>
      <dt>Enter</dt><dd>open the item's thread and write</dd>
      <dt>Esc</dt><dd>back to the whole plan (closes overlays first)</dd>
      <dt>n / p</dt><dd>next / previous change since your last visit</dd>
      <dt>o · c · t</dt><dd>toggle the Open · Changed · With notes filters</dd>
      <dt>1 · 2 · 3</dt><dd>Thread · Activity · Changes tab</dd>
      <dt>?</dt><dd>this help</dd>
    </dl>
    <p class="muted">In the note box: Enter adds the note, ⌘/Ctrl+Enter adds and sends, Shift+Enter is a new line. Paste or drop a screenshot to attach it.</p>
    <button type="button" class="btn" id="helpClose">Close</button>
  </div>
</div>
<script src="/client/app.js" defer></script>
</body>
</html>`;
}

export { STATUS_LABEL };
