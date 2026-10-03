import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP = "planboard";
export const DEFAULT_PORT = 4747;

// A .git directory or worktree .git file marks the nearest repository root.
// Outside a repository, keep the default local to the current directory.
export function defaultPlanPath(cwd = process.cwd()) {
  const start = path.resolve(cwd);
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return path.join(dir, ".planboard", "PLAN.md");
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(start, ".planboard", "PLAN.md");
    dir = parent;
  }
}

export function stateRoot() {
  return process.env.PLANBOARD_HOME || path.join(os.homedir(), ".planboard");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The canonical plan path is the board's identity (symlinks resolved), same idea
// as lavish-axi's file-path sessions: no opaque ids for the agent to remember.
export function canonicalPlanPath(p) {
  const abs = path.resolve(String(p));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

export function planKey(canonical) {
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

// Where a board keeps its notes/events. Sidecar next to the plan by default
// (`PLAN.md` -> `PLAN.board/`), or under PLANBOARD_STATE_DIR keyed by path hash.
export function boardDir(canonical) {
  const override = process.env.PLANBOARD_STATE_DIR;
  if (override) return path.join(path.resolve(override), "boards", planKey(canonical));
  const stem = path.basename(canonical, path.extname(canonical));
  return path.join(path.dirname(canonical), `${stem}.board`);
}

export function serverInfoPath() {
  return path.join(stateRoot(), "server.json");
}

export function boardsRegistryPath() {
  return path.join(stateRoot(), "boards.json");
}

export function serverLogPath() {
  return path.join(stateRoot(), "server.log");
}

export function defaultPort() {
  const n = Number(process.env.PLANBOARD_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

export function defaultHost() {
  return process.env.PLANBOARD_HOST || "127.0.0.1";
}

export function isLoopbackHost(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn last line after a crash is dropped, never fatal
    }
  }
  return out;
}

export function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, records) {
  if (!records.length) return;
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function shortId(prefix = "n") {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${prefix}_${s}`;
}
