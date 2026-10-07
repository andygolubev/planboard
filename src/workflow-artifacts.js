// Candidate manifests contain hashes only: validation runs against the workspace.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { digest, fail } from "./workflow-schema.js";

const SKIP = new Set([".git", "node_modules", "dist", "build", "coverage", ".nyc_output", "test-results", "playwright-report"]);
const slash = (value) => value.split(path.sep).join("/");
const inside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);

function relativeName(value, label = "path") {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split("/").includes("..")) {
    fail(`${label} must be a relative path within the workspace`, "UNSAFE_PATH");
  }
  if (/[*?\[\]{}]/.test(value)) fail(`${label} does not support globs; use a file or directory path`, "UNSUPPORTED_GLOB");
  return slash(path.normalize(value)).replace(/\/$/, "") || ".";
}

export function safeWorkspacePath(workspace, relativePath, { mustExist = true } = {}) {
  if (typeof workspace !== "string" || !workspace) fail("workspace must be a directory", "UNSAFE_PATH");
  let root;
  try { root = fs.realpathSync(workspace); } catch { fail("Workspace does not exist", "UNSAFE_PATH"); }
  if (!fs.statSync(root).isDirectory()) fail("Workspace must be a directory", "UNSAFE_PATH");
  const relative = relativeName(relativePath);
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) fail("Path escapes the workspace", "UNSAFE_PATH");
  let ancestor = candidate;
  let missing = false;
  while (true) {
    try {
      const real = fs.realpathSync(ancestor);
      if (!inside(root, real)) fail(`Path escapes the workspace through a symlink: ${relative}`, "UNSAFE_PATH");
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      // A dangling symlink is never a safe missing output path.
      try { if (fs.lstatSync(ancestor).isSymbolicLink()) fail(`Unresolved symlink: ${relative}`, "UNSAFE_PATH"); }
      catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e; }
      missing = true;
      if (ancestor === root) fail(`Workspace path does not exist: ${relative}`, "MISSING_PATH");
      ancestor = path.dirname(ancestor);
    }
  }
  if (missing && mustExist) fail(`Workspace path does not exist: ${relative}`, "MISSING_PATH");
  return candidate;
}

function git(workspace, args) {
  const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

export function snapshotArtifact(workspace, scope = ["."], { exclude = [] } = {}) {
  if (!Array.isArray(scope) || !scope.length || !Array.isArray(exclude)) fail("Artifact scope and exclude must be path arrays", "INVALID_ARTIFACT");
  const root = safeWorkspacePath(workspace, ".");
  const scopes = [...new Set(scope.map((entry) => relativeName(entry, "scope")))].sort();
  const exclusions = [...new Set(exclude.map((entry) => {
    if (typeof entry === "string" && path.isAbsolute(entry)) {
      let absolute = path.resolve(entry);
      if (inside(path.resolve(workspace), absolute)) absolute = path.resolve(root, path.relative(path.resolve(workspace), absolute));
      else { try { absolute = fs.realpathSync(absolute); } catch { /* external or nonexistent exclusions need no reads */ } }
      if (!inside(root, absolute)) return null;
      return relativeName(slash(path.relative(root, absolute)) || ".", "exclude");
    }
    return relativeName(entry, "exclude");
  }).filter((entry) => entry !== null))].sort();
  const excluded = (name) => exclusions.some((entry) => entry === "." || name === entry || name.startsWith(entry + "/"));
  const automatic = (name) => name.split("/").some((part) => SKIP.has(part) || part.endsWith(".board"));
  const listing = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."]);
  const tracked = listing === null ? null : new Set(listing.split("\0").filter(Boolean));
  const includedDirectories = new Set(["."]);
  for (const name of tracked || []) {
    let parent = path.posix.dirname(name);
    while (parent !== ".") { includedDirectories.add(parent); parent = path.posix.dirname(parent); }
  }
  const explicitFiles = new Set();
  const explicitDirectories = new Set();
  for (const entry of scopes) {
    const absolute = safeWorkspacePath(root, entry, { mustExist: false });
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) explicitFiles.add(entry);
    else if (entry !== ".") explicitDirectories.add(entry);
  }
  const explicitlyIncluded = (name) => explicitFiles.has(name) || [...explicitDirectories].some((dir) => name === dir || name.startsWith(dir + "/"));
  const files = new Map();
  const walk = (name, ancestors = new Set(), throughLink = false) => {
    if (excluded(name) || automatic(name) && !explicitlyIncluded(name)) return;
    if (name.split("/").some((part) => part === ".git" || part.endsWith(".board"))) return;
    if (tracked && !throughLink && !tracked.has(name) && !includedDirectories.has(name) && !explicitlyIncluded(name)) return;
    const absolute = safeWorkspacePath(root, name, { mustExist: false });
    if (!fs.existsSync(absolute)) return;
    const stat = fs.statSync(absolute);
    const symbolic = fs.lstatSync(absolute).isSymbolicLink();
    if (stat.isDirectory()) {
      const real = fs.realpathSync(absolute);
      if (ancestors.has(real)) fail(`Cyclic artifact directory symlink: ${name}`, "UNSAFE_PATH");
      const visited = new Set(ancestors).add(real);
      if (symbolic) {
        const target = fs.readlinkSync(absolute);
        files.set(name, { path: name, hash: digest(`directory-symlink:${target}`), bytes: Buffer.byteLength(target) });
      }
      for (const entry of fs.readdirSync(absolute).sort()) walk(name === "." ? entry : `${name}/${entry}`, visited, throughLink || symbolic);
    } else if (stat.isFile()) {
      if (tracked && !throughLink && !tracked.has(name) && !explicitlyIncluded(name)) return;
      const content = fs.readFileSync(absolute);
      // Record the link itself as well as its target bytes, so retargeting is stale.
      const hash = symbolic ? digest(Buffer.concat([Buffer.from(`symlink:${fs.readlinkSync(absolute)}\0`), content])) : digest(content);
      files.set(name, { path: name, hash, bytes: content.length, executable: stat.mode & 0o111 });
    } else {
      fail(`Artifact scope contains a nonregular file: ${name}`, "INVALID_ARTIFACT");
    }
  };
  for (const entry of scopes) walk(entry);
  const entries = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
  const git_revision = git(root, ["rev-parse", "--verify", "HEAD"])?.trim() || null;
  return { hash: digest({ files: entries, git_revision }), workspace: root, scope: scopes, files: entries, git_revision, exclude: exclusions };
}

export function artifactFresh(manifest) {
  if (!manifest || typeof manifest.hash !== "string") return false;
  try { return snapshotArtifact(manifest.workspace, manifest.scope, { exclude: manifest.exclude || [] }).hash === manifest.hash; }
  catch { return false; }
}
