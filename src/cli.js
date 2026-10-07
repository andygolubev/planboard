// The CLI is the agent's interface (and the human's launcher). Machine-facing
// commands print JSON; the rest print short lines.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { AGENTS_MD_SECTION, CODEX_SKILL_MD, CURSOR_RULE_MDC, CURSOR_SKILL_MD, OPENCODE_SKILL_MD, PLAN_TEMPLATE, SKILL_MD, helpText, openNextStep } from "./guidance.js";
import { boardDir, canonicalPlanPath, defaultHost, defaultPlanPath, defaultPort, ensureDir, planKey, readJson, serverInfoPath, serverLogPath, stateRoot } from "./paths.js";
import { exportMarkdown } from "./export.js";
import { STATUSES, STATUS_LABEL, lint, normalizeStatus, parsePlan, setItemStatus } from "./plan.js";
import { BoardStore, anchorKey } from "./store.js";
import { PACKAGE_ROOT, version } from "./version.js";
import { WORKFLOW_COMMANDS, workflowCommand } from "./workflow-cli.js";

const BOOL_FLAGS = new Set(["no-open", "json", "pending", "global", "takeover", "help", "version", "brief", "hook", "force", "quiet", "agents-md", "once", "coordinator"]);

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name) || i + 1 >= argv.length || (argv[i + 1].startsWith("--") && argv[i + 1] !== "-")) flags[name] = true;
      else flags[name] = argv[++i];
    } else if (a === "-h") flags.help = true;
    else if (a === "-v" || a === "-V") flags.version = true;
    else positional.push(a);
  }
  return { flags, positional };
}

class CliError extends Error {
  constructor(message, { code = 1, hint } = {}) {
    super(message);
    this.exitCode = code;
    this.hint = hint;
  }
}

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function printJson(obj) {
  out(JSON.stringify(obj, null, 2));
}

// ---- http helpers -----------------------------------------------------------------

function request(method, url, body, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = { raw: data };
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function health(host, port) {
  try {
    const r = await request("GET", `http://${hostForUrl(host)}:${port}/health`, undefined, { timeoutMs: 1500 });
    return r.status === 200 && r.json && r.json.app === "planboard" ? r.json : null;
  } catch {
    return null;
  }
}

function hostForUrl(host) {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function ensureServer({ host, port, quiet = false }) {
  const existing = await health("127.0.0.1", port);
  if (existing) {
    if (existing.version !== version()) {
      // a stale daemon from an older install: replace it
      await request("POST", `http://127.0.0.1:${port}/shutdown`).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    } else if (!isLoopbackOnly(host) && !existing.hosts.includes(host)) {
      // running daemon does not listen where we were asked to: replace it
      await request("POST", `http://127.0.0.1:${port}/shutdown`).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    } else {
      return { ...existing, url: baseUrlFor(host, port) };
    }
  }
  ensureDir(stateRoot());
  const logFd = fs.openSync(serverLogPath(), "a");
  const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, "bin", "planboard.js"), "server", "--host", host, "--port", String(port)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, PLANBOARD_DAEMON: "1" },
  });
  child.unref();
  fs.closeSync(logFd);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const h = await health("127.0.0.1", port);
    if (h) {
      if (!quiet) process.stderr.write(`planboard server started (pid ${h.pid}) on port ${port}\n`);
      return { ...h, url: baseUrlFor(host, port) };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new CliError(`server did not come up on port ${port}`, { hint: `see ${serverLogPath()}` });
}

function isLoopbackOnly(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function baseUrlFor(host, port) {
  return `http://${hostForUrl(host)}:${port}`;
}

async function runningServer(port) {
  return health("127.0.0.1", port);
}

function resolvePlan(arg, { mustExist = true } = {}) {
  if (!arg) throw new CliError("plan file required, e.g. `planboard PLAN.md`");
  const canonical = canonicalPlanPath(arg);
  if (mustExist && !fs.existsSync(canonical)) throw new CliError(`plan file not found: ${canonical}`, { hint: "create one with `planboard init PLAN.md`" });
  return canonical;
}

async function ensureBoard(planArg, { host, port, quiet }) {
  const canonical = resolvePlan(planArg);
  const server = await ensureServer({ host, port, quiet });
  const r = await request("POST", `${server.url}/api/boards`, { path: canonical });
  if (r.status !== 200) throw new CliError(`server refused to open the board: ${r.json && r.json.error ? r.json.error : r.status}`);
  return { canonical, server, board: r.json, api: `${server.url}/boards/${r.json.key}/api` };
}

// ---- commands ---------------------------------------------------------------------

async function cmdOpen(planArg, flags, ctx) {
  const { canonical, server, board } = await ensureBoard(planArg, ctx);
  const url = board.url;
  const noOpen = flags["no-open"] || process.env.PLANBOARD_NO_OPEN === "1" || process.env.PLANBOARD_DAEMON === "1";
  let opened = false;
  if (!noOpen) {
    try {
      const { default: open } = await import("open");
      await open(url);
      opened = true;
    } catch {
      opened = false;
    }
  }
  const lines = [
    `board: ${board.title}`,
    `url: ${url}`,
    `plan: ${canonical}`,
    `state: ${board.dir}`,
    `progress: ${board.counts ? `${board.counts.done}/${board.counts.total} done` : "n/a"}`,
    `browser: ${opened ? "opened" : "not opened (open the url yourself)"}`,
  ];
  if (!isLoopbackOnly(ctx.host)) lines.push(`network: bound to ${ctx.host} - anyone who can reach this machine on port ${ctx.port} can read the plan and write notes the agent will act on`);
  lines.push(`next_step: ${openNextStep(canonical)}`);
  out(lines.join("\n"));
  void server;
}

async function cmdPoll(planArg, flags, ctx) {
  const { canonical, api } = await ensureBoard(planArg, { ...ctx, quiet: true });
  const timeout = flags.timeout ? Number(flags.timeout) : 0;
  if (flags.timeout && !(Number.isFinite(timeout) && timeout >= 0)) throw new CliError("--timeout must be a number of seconds");
  const owner = flags.owner ? String(flags.owner) : `${os.hostname()}:${process.ppid} (pass --owner "<model>, effort <level>")`;
  const params = new URLSearchParams({ timeout: String(timeout), owner });
  if (flags.worker) params.set("worker", String(flags.worker));
  if (flags.token) params.set("token", String(flags.token));
  if (flags.takeover) params.set("takeover", "1");
  process.stderr.write(`planboard: waiting for notes on ${path.basename(canonical)}${timeout ? ` (up to ${timeout}s)` : ""} - Ctrl-C is safe, nothing is lost\n`);
  const r = await request("GET", `${api}/poll?${params}`, undefined, { timeoutMs: 0 });
  if (r.status === 409 && r.json?.code !== "COORDINATOR_REQUIRED") throw new CliError(r.json?.code && r.json.code !== "LISTENER_ACTIVE" ? `poll failed: ${r.json.error}` : `another poll is already listening on this board (${r.json.owner || "unknown owner"}); pass --takeover to replace it`, { code: 3 });
  if (r.json?.code === "COORDINATOR_REQUIRED") throw new CliError("this workflow board requires an active coordinator to poll", { code: 3, hint: "pass --worker <coordinator-id> --token <coordinator-token>; register and acquire a coordinator lease first" });
  if (r.status !== 200) throw new CliError(`poll failed: ${r.json && r.json.error ? r.json.error : r.status}`);
  printJson(r.json);
}

async function readReplyText(flags, positional) {
  if (flags.file) {
    if (flags.file === "-") return fs.readFileSync(0, "utf8");
    return fs.readFileSync(String(flags.file), "utf8");
  }
  const text = positional.join(" ").trim();
  if (!text) throw new CliError("reply text required (as an argument, or --file <path> / --file -)");
  return text;
}

async function cmdReply(planArg, flags, positional, ctx) {
  const canonical = resolvePlan(planArg);
  const text = await readReplyText(flags, positional);
  let anchor = null;
  if (flags.item) anchor = { type: "item", item: String(flags.item) };
  else if (flags.section) anchor = { type: "section", section: String(flags.section) };
  const to = flags.to ? String(flags.to) : null;
  const server = await runningServer(ctx.port);
  if (server) {
    const key = planKey(canonical);
    const r = await request("POST", `${server.url || baseUrlFor("127.0.0.1", ctx.port)}/boards/${key}/api/reply`, { text, to, anchor });
    if (r.status === 404 && r.json && r.json.error === "unknown board") {
      await request("POST", `${baseUrlFor("127.0.0.1", ctx.port)}/api/boards`, { path: canonical });
      return cmdReply(planArg, flags, positional, ctx);
    }
    if (r.status !== 200) throw new CliError(`reply failed: ${r.json && r.json.error ? r.json.error : r.status}`);
    out(`replied ${r.json.note.id} on: ${r.json.note.label}`);
    return;
  }
  // no server: write straight into the store (nobody else is writing)
  const store = new BoardStore(boardDir(canonical));
  if (to) {
    const parent = store.notes.find((n) => n.id === to);
    if (!parent) throw new CliError(`no note with id "${to}"`);
    anchor = parent.anchor;
  }
  const note = store.addNote({ from: "agent", anchor: anchor || { type: "board" }, text, reply_to: to || undefined });
  out(`replied ${note.id} (server not running; the board will show it when opened)`);
}

async function cmdSet(planArg, flags, positional, ctx) {
  const canonical = resolvePlan(planArg);
  const [itemId, statusArg] = positional;
  if (!itemId || !statusArg) throw new CliError("usage: planboard set <PLAN.md> <item-id> <status>", { hint: `statuses: ${STATUSES.join(", ")}` });
  if (!normalizeStatus(statusArg)) throw new CliError(`unknown status "${statusArg}"`, { hint: `statuses: ${STATUSES.join(", ")}` });
  const server = await runningServer(ctx.port);
  if (server) {
    const key = planKey(canonical);
    const r = await request("POST", `${baseUrlFor("127.0.0.1", ctx.port)}/boards/${key}/api/status`, { item: itemId, status: statusArg });
    if (r.status === 200) {
      out(`${r.json.item}: ${STATUS_LABEL[r.json.from] || r.json.from || "none"} → ${STATUS_LABEL[r.json.to]}  (${r.json.text})`);
      return;
    }
    if (!(r.status === 404 && r.json && r.json.error === "unknown board")) throw new CliError(`set failed: ${r.json && r.json.error ? r.json.error : r.status}`);
  }
  const source = fs.readFileSync(canonical, "utf8");
  const change = setItemStatus(source, itemId, statusArg);
  const tmp = `${canonical}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, change.source);
  fs.renameSync(tmp, canonical);
  out(`${change.item.id}: ${STATUS_LABEL[change.from] || change.from || "none"} → ${STATUS_LABEL[change.to]}  (${change.item.text})`);
}

function loadLocal(planArg) {
  const canonical = resolvePlan(planArg);
  const source = fs.readFileSync(canonical, "utf8");
  const model = parsePlan(source);
  const store = new BoardStore(boardDir(canonical));
  return { canonical, model, store };
}

const MARK = { todo: "[ ]", in_progress: "[~]", done: "[x]", blocked: "[!]", question: "[?]", dropped: "[-]" };

function formatPlanText(model, store) {
  const threads = store.threadsSummary();
  const lines = [];
  const c = model.counts;
  lines.push(`${model.title}  —  ${c.done}/${c.total} done, ${c.in_progress} in progress, ${c.blocked} blocked, ${c.question} need a decision, ${c.todo} to do${c.dropped ? `, ${c.dropped} dropped` : ""}`);
  const noteMark = (key) => {
    const t = threads[key];
    if (!t) return "";
    const parts = [`${t.count} note${t.count === 1 ? "" : "s"}`];
    if (t.pending) parts.push(`${t.pending} pending`);
    if (t.queued) parts.push(`${t.queued} queued`);
    return `  «${parts.join(", ")}»`;
  };
  if (threads.board) lines.push(`(whole plan)${noteMark("board")}`);
  for (const s of model.sections) {
    const indent = "  ".repeat(Math.max(0, s.level - 1));
    const prog = s.counts.total ? `  ${s.counts.done}/${s.counts.total}` : "";
    lines.push(`${indent}${"#".repeat(s.level)} ${s.title} {#${s.id}}${prog}${noteMark(`section:${s.id}`)}`);
    for (const item of model.items.filter((i) => i.section === s.id)) {
      const ind = indent + "  " + "  ".repeat(item.depth);
      const mark = item.status ? MARK[item.status] : " - ";
      const idTag = item.status || !item.autoId ? ` {#${item.id}}${item.autoId ? " (auto id)" : ""}` : "";
      lines.push(`${ind}${mark} ${item.text}${idTag}${noteMark(`item:${item.id}`)}`);
    }
    for (const d of model.diagrams.filter((x) => x.section === s.id)) {
      const nodes = Object.keys(threads).filter((k) => k.startsWith(`node:${d.id}/`));
      lines.push(`${indent}  [diagram ${d.id}]${nodes.length ? `  «notes on nodes: ${nodes.map((k) => k.slice(`node:${d.id}/`.length)).join(", ")}»` : ""}`);
    }
  }
  const orphanItems = model.items.filter((i) => !i.section);
  for (const item of orphanItems) {
    const mark = item.status ? MARK[item.status] : " - ";
    lines.push(`${"  ".repeat(item.depth)}${mark} ${item.text} {#${item.id}}${noteMark(`item:${item.id}`)}`);
  }
  const pending = store.pending().length;
  const queued = store.queued().length;
  if (pending || queued) lines.push(`\n${pending} note(s) pending delivery${queued ? `, ${queued} queued in the browser (not sent yet)` : ""} — run \`planboard poll\` to receive them.`);
  return lines.join("\n");
}

async function localWorkflow(canonical, model, options) {
  const { readWorkflow } = await import("./workflow.js");
  return readWorkflow(canonical, boardDir(canonical), model, options);
}

async function cmdShow(planArg, flags) {
  const { canonical, model, store } = loadLocal(planArg);
  const workflow = await localWorkflow(canonical, model);
  if (flags.json) {
    printJson({
      path: canonical,
      title: model.title,
      counts: model.counts,
      sections: model.sections,
      items: model.items,
      diagrams: model.diagrams.map((d) => ({ id: d.id, section: d.section, line: d.line })),
      threads: store.threadsSummary(),
      pending: store.pending().map((n) => n.id),
      workflow,
    });
    return;
  }
  out(formatPlanText(model, store));
  if (workflow.enabled) {
    out(`\nWorkflow revision ${workflow.revision}:`);
    for (const task of workflow.tasks || []) out(`  ${task.id}: ${task.acceptance} · ${task.phase} · ${task.checks_passed || 0}/${task.checks_total || 0} checks${task.blockers?.length ? ` · ${task.blockers.join("; ")}` : ""}`);
  }
  if (workflow.error) out(`workflow error: ${workflow.error}`);
}

function formatThread(notes, label) {
  const lines = [`Thread on: ${label}  (${notes.length} entr${notes.length === 1 ? "y" : "ies"})`];
  for (const n of notes) {
    const who = n.from === "agent" ? "agent" : "user";
    const state = n.from === "user" && n.state !== "delivered" ? ` [${n.state}]` : "";
    const depth = n.depth && n.depth !== "normal" ? ` · ${n.depth}` : "";
    const files = n.attachments && n.attachments.length ? `\n  attachments: ${n.attachments.join(", ")}` : "";
    lines.push(`\n[${n.id}] ${who} · ${n.at}${state}${depth}${n.quote ? `\n  > ${n.quote}` : ""}\n  ${n.text.split("\n").join("\n  ")}${files}`);
  }
  return lines.join("\n");
}

function anchorFromArg(model, arg) {
  if (!arg || arg === "board" || arg === "plan") return { type: "board" };
  if (model.items.some((i) => i.id === arg)) return { type: "item", item: arg };
  if (model.sections.some((s) => s.id === arg)) return { type: "section", section: arg };
  const node = /^([^/]+)\/(.+)$/.exec(arg);
  if (node && model.diagrams.some((d) => d.id === node[1])) return { type: "node", diagram: node[1], node: node[2] };
  if (model.images.some((im) => im.src === arg)) return { type: "image", src: arg };
  throw new CliError(`no item, section, diagram node or image called "${arg}"`, { hint: "run `planboard show <PLAN.md>` to list ids; node anchors are <diagram-id>/<node-id>" });
}

function cmdThread(planArg, flags, positional) {
  const { model, store } = loadLocal(planArg);
  const anchor = anchorFromArg(model, positional[0]);
  const notes = store.thread(anchor);
  if (flags.json) return printJson({ anchor, notes });
  const label =
    anchor.type === "board"
      ? "Whole plan"
      : anchor.type === "item"
        ? model.items.find((i) => i.id === anchor.item).text
        : anchor.type === "section"
          ? model.sections.find((s) => s.id === anchor.section).title
          : anchorKey(anchor);
  out(formatThread(notes, label));
}

function cmdNotes(planArg, flags) {
  const { store } = loadLocal(planArg);
  const notes = flags.pending ? store.pending() : store.notes;
  if (flags.json) return printJson({ notes });
  if (!notes.length) return out(flags.pending ? "no pending notes" : "no notes yet");
  for (const n of notes) {
    const extra = [n.depth && n.depth !== "normal" ? `depth ${n.depth}` : "", n.kind ? n.kind : "", n.attachments && n.attachments.length ? `${n.attachments.length} attachment(s)` : ""].filter(Boolean);
    out(`[${n.id}] ${n.from} · ${n.state} · ${anchorKey(n.anchor)} · ${n.at}${extra.length ? ` · ${extra.join(" · ")}` : ""}\n  ${n.text.split("\n").join("\n  ")}`);
  }
}

async function cmdExport(planArg, flags) {
  const canonical = resolvePlan(planArg);
  const source = fs.readFileSync(canonical, "utf8");
  const model = parsePlan(source);
  const store = new BoardStore(boardDir(canonical));
  const workflow = await localWorkflow(canonical, model, { fullHistory: true });
  const md = flags.json ? JSON.stringify({ schema_version: 1, plan: { path: canonical, title: model.title, source }, notes: store.notes, events: store.events, workflow }, null, 2) + "\n" : exportMarkdown({ source, model, store, planPath: canonical, version: version(), workflow });
  if (flags.out) {
    const target = path.resolve(String(flags.out));
    if (canonicalPlanPath(target) === canonical) throw new CliError("--out must not be the plan file itself");
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, md);
    const threads = Object.keys(store.threadsSummary()).length;
    out(`wrote ${target} (${md.split("\n").length} lines, ${store.notes.length} notes in ${threads} thread${threads === 1 ? "" : "s"}, ${store.events.length} status events)`);
    return;
  }
  process.stdout.write(md);
}

async function cmdLint(planArg) {
  const { canonical, model } = loadLocal(planArg);
  const warnings = lint(model);
  const workflow = await localWorkflow(canonical, model);
  if (workflow.error) warnings.push({ level: "error", message: `workflow: ${workflow.error}` });
  for (const issue of workflow.specs?.issues || []) warnings.push({ level: issue.level || "error", message: `workflow: ${issue.message || JSON.stringify(issue)}` });
  if (!warnings.length) return out(`${path.basename(canonical)}: ok (${model.items.filter((i) => i.status).length} tracked items, ${model.sections.length} sections, ${model.diagrams.length} diagrams)`);
  for (const w of warnings) out(`${path.basename(canonical)}:${w.line || 0}: ${w.level}: ${w.message}`);
  if (warnings.some((w) => w.level === "error")) throw new CliError("lint found errors", { code: 2 });
}

function cmdInit(planArg, flags) {
  const target = planArg ? path.resolve(planArg) : defaultPlanPath();
  if (fs.existsSync(target) && !flags.force) throw new CliError(`${target} exists (pass --force to overwrite)`);
  const titleDir = planArg ? path.dirname(target) : path.dirname(path.dirname(target));
  const title = flags.title ? String(flags.title) : path.basename(titleDir) || "Plan";
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, PLAN_TEMPLATE(title));
  out(`wrote ${target}\nnext_step: edit it (keep the {#id} anchors and checkbox statuses), then run \`planboard ${path.relative(process.cwd(), target) || target}\` to open the board.`);
}

async function cmdBoards(flags, ctx) {
  const server = await runningServer(ctx.port);
  const brief = flags.brief;
  if (!server) {
    const known = readJson(path.join(stateRoot(), "boards.json"), {});
    const entries = Object.entries(known);
    if (flags.json) return printJson({ server: null, boards: entries.map(([key, e]) => ({ key, path: e.path })) });
    if (!entries.length) return out(brief ? "" : "planboard server is not running and no boards are known.");
    out(`planboard server is not running. Known boards (run \`planboard <PLAN.md>\` to open one):`);
    for (const [, e] of entries) out(`  ${e.path}`);
    return;
  }
  const r = await request("GET", `${baseUrlFor("127.0.0.1", ctx.port)}/api/boards`);
  const boards = (r.json && r.json.boards) || [];
  if (flags.json) return printJson({ server, boards });
  if (!boards.length) return out(brief ? "" : "planboard server is running with no boards.");
  out(`planboard boards (server ${server.url || baseUrlFor("127.0.0.1", ctx.port)}):`);
  for (const b of boards) {
    const c = b.counts || { done: 0, total: 0 };
    out(`  ${b.title}  ${c.done}/${c.total} done  agent:${b.presence}${b.pending ? `  ${b.pending} note(s) pending` : ""}\n    ${b.path}\n    ${b.url}`);
  }
  if (boards.some((b) => b.pending)) out(`next_step: run \`planboard poll <PLAN.md>\` on the board with pending notes.`);
}

function cmdSetupCursor(flags) {
  const root = flags.global ? path.join(os.homedir(), ".cursor") : path.join(process.cwd(), ".cursor");
  const skillDir = path.join(root, "skills", "planboard");
  ensureDir(skillDir);
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), CURSOR_SKILL_MD);
  const lines = [`wrote ${path.join(skillDir, "SKILL.md")}`, `In Agent chat, type / and select planboard, or ask Cursor to use the planboard skill. Restart Cursor if it does not appear.`];
  if (flags.global) {
    lines.push(`Cursor keeps global rules in Customize › Rules (Settings › Rules in older versions); run \`planboard setup cursor\` inside a project to add a project rule, or paste this rule there:`);
    lines.push(CURSOR_RULE_MDC.trimEnd());
  } else {
    const rulesDir = path.join(root, "rules");
    ensureDir(rulesDir);
    fs.writeFileSync(path.join(rulesDir, "planboard.mdc"), CURSOR_RULE_MDC);
    lines.push(`wrote ${path.join(rulesDir, "planboard.mdc")} (Cursor picks it up when the conversation is about the plan)`);
  }
  if (flags["agents-md"]) {
    const agentsPath = path.join(process.cwd(), "AGENTS.md");
    const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
    if (existing.includes("planboard --help")) lines.push(`${agentsPath} already mentions planboard`);
    else {
      fs.writeFileSync(agentsPath, (existing ? existing.replace(/\s*$/, "\n") : "# Agent notes\n") + AGENTS_MD_SECTION);
      lines.push(`appended a planboard section to ${agentsPath}`);
    }
  } else lines.push(`Optional: pass --agents-md to append a short planboard section to ./AGENTS.md as well.`);
  out(lines.join("\n"));
}

function cmdSetupCodex(flags) {
  if (flags.hook || flags["agents-md"]) {
    throw new CliError("setup codex supports --global; keep project instructions in AGENTS.md and use the planboard skill for the review loop");
  }
  const root = flags.global ? os.homedir() : process.cwd();
  const skillDir = path.join(root, ".agents", "skills", "planboard");
  ensureDir(skillDir);
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, CODEX_SKILL_MD);
  out(`wrote ${skillPath}\nUse $planboard in Codex CLI or the IDE extension, or select the planboard skill in the app.\nIf it does not appear, restart Codex. Existing AGENTS.md instructions are unchanged.`);
}

function cmdSetupOpenCode(flags) {
  if (flags.hook || flags["agents-md"]) {
    throw new CliError("setup opencode supports --global; keep project instructions in AGENTS.md and use the planboard skill for the review loop");
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configHome = xdgConfigHome && path.isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : path.join(os.homedir(), ".config");
  const root = flags.global
    ? process.env.OPENCODE_CONFIG_DIR || path.join(configHome, "opencode")
    : path.join(process.cwd(), ".opencode");
  const skillDir = path.join(root, "skills", "planboard");
  ensureDir(skillDir);
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, OPENCODE_SKILL_MD);
  out(`wrote ${skillPath}\nAsk OpenCode to use the planboard skill; it loads through the native skill tool.\nIf it does not appear, restart OpenCode and check skill permissions. Existing AGENTS.md instructions and OpenCode configuration are unchanged.`);
}

function cmdSetup(positional, flags) {
  const target = positional[0] || "claude";
  if (target === "cursor") return cmdSetupCursor(flags);
  if (target === "codex") return cmdSetupCodex(flags);
  if (target === "opencode") return cmdSetupOpenCode(flags);
  if (target !== "claude") throw new CliError(`unknown setup target "${target}" (use "claude", "cursor", "codex" or "opencode")`);
  const root = flags.global ? path.join(os.homedir(), ".claude") : path.join(process.cwd(), ".claude");
  const skillDir = path.join(root, "skills", "planboard");
  ensureDir(skillDir);
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_MD);
  const lines = [`wrote ${path.join(skillDir, "SKILL.md")}`, `Claude Code picks it up as /planboard in a new session.`];
  if (flags.hook) {
    const settingsPath = path.join(root, "settings.json");
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      } catch {
        throw new CliError(`${settingsPath} is not plain JSON; add the hook by hand:`, { hint: HOOK_SNIPPET });
      }
    }
    settings.hooks ||= {};
    settings.hooks.SessionStart ||= [];
    const already = JSON.stringify(settings.hooks.SessionStart).includes("planboard boards");
    if (!already) {
      settings.hooks.SessionStart.push({ matcher: "", hooks: [{ type: "command", command: "planboard boards --brief" }] });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      lines.push(`added a SessionStart hook to ${settingsPath} (restart Claude Code)`);
    } else lines.push(`SessionStart hook already present in ${settingsPath}`);
  } else {
    lines.push(`Optional: pass --hook to add a SessionStart hook that lists open boards at the start of every session.`);
  }
  out(lines.join("\n"));
}

const HOOK_SNIPPET = `"hooks": { "SessionStart": [ { "matcher": "", "hooks": [ { "type": "command", "command": "planboard boards --brief" } ] } ] }`;

async function cmdServer(flags, ctx) {
  const { serve } = await import("./server.js");
  const log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  await serve({ host: ctx.host, port: ctx.port, log });
  log(`planboard ${version()} serving on ${ctx.host}:${ctx.port}`);
}

async function cmdStop(ctx) {
  const server = await runningServer(ctx.port);
  if (!server) return out(`no planboard server on port ${ctx.port}`);
  await request("POST", `${baseUrlFor("127.0.0.1", ctx.port)}/shutdown`).catch(() => {});
  out(`stopped planboard server (pid ${server.pid})`);
}

// ---- entry ------------------------------------------------------------------------

export async function run(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.version) return out(version());
  const workerHost = positional[0] === "worker" && positional[2] === "register";
  const ctx = {
    host: flags["server-host"] ? String(flags["server-host"]) : flags.host && !workerHost ? String(flags.host) : defaultHost(),
    port: flags.port ? Number(flags.port) : defaultPort(),
    quiet: !!flags.quiet,
  };
  if (!Number.isInteger(ctx.port) || ctx.port <= 0) throw new CliError("--port must be a positive integer");

  const [first, ...rest] = positional;
  const command = first && !looksLikePlan(first) ? first : first ? "open" : flags.help ? "help" : "help";
  const planArg = command === "open" ? first : rest[0];
  const tail = command === "open" ? rest : rest.slice(1);

  if (flags.help && command !== "help") return out(helpText({ version: version() }));
  if (WORKFLOW_COMMANDS.has(command)) return workflowCommand(command, planArg, flags, tail, { ensureBoard, request, printJson, out, ctx });

  switch (command) {
    case "help":
      return out(helpText({ version: version() }));
    case "open":
      return cmdOpen(planArg, flags, ctx);
    case "poll":
      return cmdPoll(planArg, flags, ctx);
    case "reply":
      return cmdReply(planArg, flags, tail, ctx);
    case "set":
      return cmdSet(planArg, flags, tail, ctx);
    case "show":
      return cmdShow(planArg, flags);
    case "thread":
      return cmdThread(planArg, flags, tail);
    case "notes":
      return cmdNotes(planArg, flags);
    case "lint":
      return cmdLint(planArg);
    case "export":
      return cmdExport(planArg, flags);
    case "init":
      return cmdInit(planArg, flags);
    case "boards":
      return cmdBoards(flags, ctx);
    case "setup":
      return cmdSetup(rest, flags);
    case "server":
      return cmdServer(flags, ctx);
    case "stop":
      return cmdStop(ctx);
    default:
      throw new CliError(`unknown command "${command}"`, { hint: "run `planboard --help`" });
  }
}

function looksLikePlan(arg) {
  if (/\.(md|markdown|txt)$/i.test(arg)) return true;
  if (arg.includes("/") || arg.includes("\\")) return true;
  return false;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await run(argv);
  } catch (err) {
    if (err instanceof CliError || Number.isInteger(err.exitCode)) {
      process.stderr.write(`planboard: ${err.message}\n${err.hint ? `  ${err.hint}\n` : ""}`);
      process.exitCode = err.exitCode;
      return;
    }
    process.stderr.write(`planboard: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  }
}
