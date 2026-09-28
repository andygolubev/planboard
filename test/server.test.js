import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let serve;
let server;
let base;
let planPath;
let tmpDir;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "planboard-server-")));
  process.env.PLANBOARD_HOME = path.join(tmpDir, "home");
  planPath = path.join(tmpDir, "PLAN.md");
  fs.writeFileSync(planPath, "# Test plan {#p}\n\n## S {#s}\n\n- [ ] Alpha {#alpha}\n- [~] Beta {#beta}\n\n![m](img.png)\n");
  fs.writeFileSync(path.join(tmpDir, "img.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  fs.writeFileSync(path.join(tmpDir, "secret.txt"), "top secret");
  ({ serve } = await import("../src/server.js"));
  const port = await freePort();
  server = await serve({ host: "127.0.0.1", port, log: () => {} });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await server.close();
});

let key;

test("health and board registration", async () => {
  const h = await api("GET", "/health");
  assert.equal(h.json.app, "planboard");
  const r = await api("POST", "/api/boards", { path: planPath });
  assert.equal(r.status, 200);
  key = r.json.key;
  assert.equal(r.json.title, "Test plan");
  assert.equal(r.json.counts.total, 2);
  assert.ok(fs.existsSync(path.join(tmpDir, "PLAN.board")), "sidecar state dir is created next to the plan");
  const list = await api("GET", "/api/boards");
  assert.equal(list.json.boards.length, 1);
});

test("board page and state", async () => {
  const page = await fetch(`${base}/boards/${key}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /planboard-state/);
  const embedded = JSON.parse(/<script id="planboard-state" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.match(embedded.html, /data-item="alpha"/);
  const st = await api("GET", `/boards/${key}/api/state`);
  assert.equal(st.json.items.length, 2);
  assert.equal(st.json.presence, "waiting");
});

test("host allowlist and origin guard", async () => {
  const badStatus = await new Promise((resolve, reject) => {
    const u = new URL(`${base}/health`);
    http.get({ hostname: u.hostname, port: u.port, path: "/health", headers: { host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
  assert.equal(badStatus, 403);
  const badOrigin = await api("POST", `/boards/${key}/api/notes`, { anchor: { type: "board" }, text: "x" }, { origin: "http://evil.example" });
  assert.equal(badOrigin.status, 403);
  const goodOrigin = await api("POST", `/boards/${key}/api/notes`, { anchor: { type: "board" }, text: "hello from a good origin" }, { origin: base });
  assert.equal(goodOrigin.status, 200);
  await api("DELETE", `/boards/${key}/api/notes/${goodOrigin.json.note.id}`);
});

test("assets are confined to the plan directory", async (t) => {
  const ok = await fetch(`${base}/boards/${key}/asset/img.png`);
  assert.equal(ok.status, 200);
  const escape = await fetch(`${base}/boards/${key}/asset/..%2Fsecret.txt`);
  assert.notEqual(escape.status, 200);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, "secret.txt");
  fs.writeFileSync(target, "outside the plan directory");
  fs.symlinkSync(target, path.join(tmpDir, "link.txt"));
  const viaLink = await fetch(`${base}/boards/${key}/asset/link.txt`);
  assert.equal(viaLink.status, 403);
});

test("notes: queue, send, poll delivers with thread, reply shows up", async () => {
  const n1 = await api("POST", `/boards/${key}/api/notes`, { anchor: { type: "item", item: "alpha" }, text: "Split this into two" });
  assert.equal(n1.status, 200);
  assert.equal(n1.json.note.state, "queued");
  assert.equal(n1.json.note.label, "S › Alpha");

  // a poll with nothing sent waits; a short timeout returns "waiting"
  const waiting = await api("GET", `/boards/${key}/api/poll?timeout=1`);
  assert.equal(waiting.json.status, "waiting");

  // start a long poll, then send: the poll must return the note with its item
  const pollPromise = api("GET", `/boards/${key}/api/poll?timeout=10&owner=test`);
  await new Promise((r) => setTimeout(r, 150));
  const st = await api("GET", `/boards/${key}/api/state`);
  assert.equal(st.json.presence, "listening");
  const sent = await api("POST", `/boards/${key}/api/send`, {});
  assert.deepEqual(sent.json.sent, [n1.json.note.id]);
  const poll = await pollPromise;
  assert.equal(poll.json.status, "feedback");
  assert.equal(poll.json.notes.length, 1);
  assert.equal(poll.json.notes[0].item.id, "alpha");
  assert.equal(poll.json.notes[0].item.status, "todo");
  assert.deepEqual(poll.json.notes[0].thread, []);
  assert.match(poll.json.next_step, /planboard reply/);

  await new Promise((r) => setTimeout(r, 50));
  const st2 = await api("GET", `/boards/${key}/api/state`);
  assert.equal(st2.json.notes[0].state, "delivered");
  assert.equal(st2.json.presence, "working");

  const reply = await api("POST", `/boards/${key}/api/reply`, { text: "Done: **split** into alpha-1 and alpha-2", to: n1.json.note.id });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json.note.anchor, { type: "item", item: "alpha" });
  assert.match(reply.json.note.html, /<strong>split<\/strong>/);
  const thread = await api("GET", `/boards/${key}/api/thread?item=alpha`);
  assert.equal(thread.json.notes.length, 2);
  const st3 = await api("GET", `/boards/${key}/api/state`);
  assert.equal(st3.json.presence, "waiting");

  // a second note on the same item arrives with the earlier thread
  const n2 = await api("POST", `/boards/${key}/api/notes`, { anchor: { type: "text", item: "alpha", quote: "Alpha" }, text: "and rename it" });
  await api("POST", `/boards/${key}/api/send`, {});
  const poll2 = await api("GET", `/boards/${key}/api/poll?timeout=5`);
  assert.equal(poll2.json.notes[0].id, n2.json.note.id);
  assert.equal(poll2.json.notes[0].quote, "Alpha");
  assert.equal(poll2.json.notes[0].thread.length, 2);
  assert.equal(poll2.json.notes[0].thread[1].from, "agent");
});

test("a second concurrent poll is refused unless it takes over", async () => {
  const first = api("GET", `/boards/${key}/api/poll?timeout=5&owner=one`);
  await new Promise((r) => setTimeout(r, 100));
  const second = await api("GET", `/boards/${key}/api/poll?timeout=1&owner=two`);
  assert.equal(second.status, 409);
  assert.equal(second.json.code, "LISTENER_ACTIVE");
  const third = api("GET", `/boards/${key}/api/poll?timeout=1&owner=three&takeover=1`);
  const firstResult = await first;
  assert.equal(firstResult.json.status, "replaced");
  const thirdResult = await third;
  assert.equal(thirdResult.json.status, "waiting");
});

test("status edits rewrite the plan file and log an event", async () => {
  const r = await api("POST", `/boards/${key}/api/status`, { item: "alpha", status: "done" });
  assert.equal(r.status, 200);
  assert.equal(r.json.from, "todo");
  assert.equal(r.json.to, "done");
  assert.match(fs.readFileSync(planPath, "utf8"), /- \[x\] Alpha \{#alpha\}/);
  const st = await api("GET", `/boards/${key}/api/state`);
  assert.equal(st.json.items.find((i) => i.id === "alpha").status, "done");
  assert.ok(st.json.recent_events.some((e) => e.type === "status" && e.item === "alpha" && e.to === "done"));
  const bad = await api("POST", `/boards/${key}/api/status`, { item: "alpha", status: "nope" });
  assert.equal(bad.status, 400);
});

test("attachments: upload, serve, attach to a note with a depth, deliver paths to the agent", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const up = await fetch(`${base}/boards/${key}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
  assert.equal(up.status, 200);
  const { attachment } = await up.json();
  assert.match(attachment.file, /^a_[a-z0-9]+\.png$/);
  assert.ok(fs.existsSync(path.join(tmpDir, "PLAN.board", "attachments", attachment.file)));
  const served = await fetch(`${base}${attachment.url}`);
  assert.equal(served.status, 200);
  assert.equal(Buffer.from(await served.arrayBuffer()).length, png.length);
  const bad = await fetch(`${base}/boards/${key}/api/attachments`, { method: "POST", headers: { "content-type": "text/plain" }, body: "nope" });
  assert.equal(bad.status, 415);
  const escape = await fetch(`${base}/boards/${key}/attachment/..%2Fnotes.json`);
  assert.notEqual(escape.status, 200);

  const n = await api("POST", `/boards/${key}/api/notes`, { anchor: { type: "item", item: "beta" }, text: "see the screenshot", depth: "deep", attachments: [attachment.file, "missing.png"] });
  assert.equal(n.status, 200);
  assert.equal(n.json.note.depth, "deep");
  assert.deepEqual(n.json.note.attachments, [attachment.file]);
  const noText = await api("POST", `/boards/${key}/api/notes`, { anchor: { type: "item", item: "beta" }, text: "", attachments: [attachment.file] });
  assert.equal(noText.status, 200, "an attachment alone is a valid note");
  await api("DELETE", `/boards/${key}/api/notes/${noText.json.note.id}`);
  assert.ok(fs.existsSync(path.join(tmpDir, "PLAN.board", "attachments", attachment.file)), "file kept while another note references it");
  await api("POST", `/boards/${key}/api/send`, {});
  const poll = await api("GET", `/boards/${key}/api/poll?timeout=5`);
  assert.equal(poll.json.notes[0].depth, "deep");
  assert.equal(poll.json.notes[0].attachments[0].path, path.join(tmpDir, "PLAN.board", "attachments", attachment.file));
  assert.equal(poll.json.notes[0].attachments[0].type, "image/png");
  assert.match(poll.json.next_step, /deep notes/);
  assert.match(poll.json.next_step, /attached image/);
  const quick = await api("POST", `/boards/${key}/api/notes`, { anchor: { type: "board" }, text: "just say yes or no", depth: "quick" });
  assert.equal(quick.json.note.depth, "quick");
  await api("DELETE", `/boards/${key}/api/notes/${quick.json.note.id}`);
});

test("whiteboard: saved scene round-trips and queued feedback becomes a sketch note with files", async () => {
  fs.writeFileSync(planPath, fs.readFileSync(planPath, "utf8") + "\n```mermaid arch\nflowchart LR\n  A --> B\n```\n");
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const st = await api("GET", `/boards/${key}/api/state`);
    ready = st.json.diagrams.some((d) => d.id === "arch");
  }
  assert.ok(ready);
  const empty = await api("GET", `/boards/${key}/api/whiteboard/arch`);
  assert.equal(empty.json.whiteboard, null);
  assert.match(empty.json.source, /A --> B/);
  const saved = await api("PUT", `/boards/${key}/api/whiteboard/arch`, { sourceHash: "h1", textMetricsVersion: 1, scene: { elements: [{ id: "A", type: "rectangle" }], appState: {} }, baseline: { elements: [] } });
  assert.equal(saved.status, 200);
  const again = await api("GET", `/boards/${key}/api/whiteboard/arch`);
  assert.equal(again.json.whiteboard.source_hash, "h1");
  assert.equal(again.json.whiteboard.scene.elements[0].id, "A");
  assert.ok(fs.existsSync(path.join(tmpDir, "PLAN.board", "whiteboards", "arch.json")));
  assert.match(fs.readFileSync(path.join(tmpDir, "PLAN.board", ".gitignore"), "utf8"), /whiteboards\//);

  const png = "data:image/png;base64," + Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const fb = await api("POST", `/boards/${key}/api/whiteboard/arch/feedback`, {
    note: "make B a cache",
    summaryLines: ['Relabeled rectangle (B): "B" -> "Cache"', "Added arrow from A to Cache"],
    stats: { added: 1, relabeled: 1 },
    pngDataUrl: png,
    scene: { elements: [{ id: "B", type: "rectangle" }], appState: {}, files: {} },
    sourceHash: "h1",
  });
  assert.equal(fb.status, 200);
  const note = fb.json.note;
  assert.equal(note.kind, "sketch");
  assert.deepEqual(note.anchor, { type: "diagram", diagram: "arch" });
  assert.equal(note.state, "queued");
  assert.match(note.text, /^make B a cache\n\nWhiteboard edits on diagram `arch` \(1 added, 1 relabeled\):\n- Relabeled/);
  assert.equal(note.attachments.length, 2);
  assert.ok(note.attachments.some((f) => /^sketch-arch_[a-z0-9]+\.png$/.test(f)));
  assert.ok(note.attachments.some((f) => f.endsWith(".excalidraw")));
  const scene = await fetch(`${base}/boards/${key}/attachment/${note.attachments.find((f) => f.endsWith(".excalidraw"))}`);
  assert.equal(scene.status, 200);
  assert.equal((await scene.json()).type, "excalidraw");
  const missing = await api("POST", `/boards/${key}/api/whiteboard/nope/feedback`, { summaryLines: [] });
  assert.equal(missing.status, 404);
  await api("DELETE", `/boards/${key}/api/notes/${note.id}`);
  assert.equal(fs.readdirSync(path.join(tmpDir, "PLAN.board", "attachments")).filter((f) => f.startsWith("sketch-")).length, 0, "removing the queued sketch removes its files");
});

test("export route returns the plan with threads folded in", async () => {
  const r = await fetch(`${base}/boards/${key}/api/export?download`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/markdown/);
  assert.match(r.headers.get("content-disposition"), /PLAN-with-threads\.md/);
  const md = await r.text();
  assert.match(md, /- \[x\] Alpha \{#alpha\}\n  > \*\*Thread\*\* · /);
  assert.match(md, /## Status history/);
});

test("editing the file on disk is picked up by the watcher", async () => {
  fs.writeFileSync(planPath, fs.readFileSync(planPath, "utf8") + "- [ ] Gamma {#gamma}\n");
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const st = await api("GET", `/boards/${key}/api/state`);
    found = st.json.items.some((it) => it.id === "gamma");
  }
  assert.ok(found, "new item appears after the file changes");
  const st = await api("GET", `/boards/${key}/api/state`);
  assert.ok(st.json.recent_events.some((e) => e.type === "added" && e.item === "gamma"));
});
