import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { artifactFresh, safeWorkspacePath, snapshotArtifact } from "../src/workflow-artifacts.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-artifacts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, write(name, text = name) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); } };
}

test("artifact freshness detects edits, additions, removals, and newly created output scopes", (t) => {
  const { dir, write } = fixture(t);
  write("src/a.js"); write("other.txt"); write("node_modules/pkg/index.js"); write("dist/out.js"); write("PLAN.board/journal.jsonl");
  const manifest = snapshotArtifact(dir, ["src", "new/output.txt"]);
  assert.deepEqual(manifest.files.map((entry) => entry.path), ["src/a.js"]);
  assert.equal(artifactFresh(manifest), true);
  write("other.txt", "irrelevant change"); assert.equal(artifactFresh(manifest), true);
  write("src/b.js"); assert.equal(artifactFresh(manifest), false);
  fs.unlinkSync(path.join(dir, "src/b.js")); assert.equal(artifactFresh(manifest), true);
  write("new/output.txt"); assert.equal(artifactFresh(manifest), false);
  const created = snapshotArtifact(dir);
  fs.unlinkSync(path.join(dir, "src/a.js")); assert.equal(artifactFresh(created), false);
  assert.equal(created.files.some((entry) => /node_modules|dist|\.board/.test(entry.path)), false);
  write("script.sh", "#!/bin/sh\nexit 0\n"); fs.chmodSync(path.join(dir, "script.sh"), 0o755);
  const executable = snapshotArtifact(dir, ["script.sh"]);
  fs.chmodSync(path.join(dir, "script.sh"), 0o644);
  assert.equal(artifactFresh(executable), false);
});

test("artifacts respect Git ignores and include explicitly declared ignored artifact files", (t) => {
  const { dir, write } = fixture(t);
  assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
  write(".gitignore", "ignored/\n*.log\n"); write("tracked.js"); write("untracked.js"); write("ignored/report.json"); write("run.log");
  assert.equal(spawnSync("git", ["-C", dir, "add", "tracked.js"]).status, 0);
  const manifest = snapshotArtifact(dir);
  assert.deepEqual(manifest.files.map((entry) => entry.path), [".gitignore", "tracked.js", "untracked.js"]);
  write("ignored/report.json", "changed"); assert.equal(artifactFresh(manifest), true);
  const explicit = snapshotArtifact(dir, ["ignored/report.json"]);
  assert.deepEqual(explicit.files.map((entry) => entry.path), ["ignored/report.json"]);
  write("ignored/report.json", "changed twice"); assert.equal(artifactFresh(explicit), false);
  write("dist/out.txt", "first");
  const directory = snapshotArtifact(dir, ["dist", "ignored"]);
  assert.ok(directory.files.some((entry) => entry.path === "dist/out.txt"));
  assert.ok(directory.files.some((entry) => entry.path === "ignored/report.json"));
  write("dist/out.txt", "second"); assert.equal(artifactFresh(directory), false);
  write("target/data.txt", "one");
  fs.symlinkSync("target", path.join(dir, "linked"));
  assert.equal(spawnSync("git", ["-C", dir, "add", "linked"]).status, 0);
  const link = snapshotArtifact(dir, ["linked"]);
  assert.deepEqual(link.files.map((entry) => entry.path), ["linked", "linked/data.txt"]);
  write("target/data.txt", "two"); assert.equal(artifactFresh(link), false);
});

test("artifact paths and symlinks cannot escape the workspace", (t) => {
  const { dir, write } = fixture(t);
  write("inside.txt");
  fs.symlinkSync(os.tmpdir(), path.join(dir, "outside"));
  assert.throws(() => safeWorkspacePath(dir, "../outside"), { code: "UNSAFE_PATH" });
  assert.throws(() => safeWorkspacePath(dir, "/tmp/file"), { code: "UNSAFE_PATH" });
  assert.throws(() => safeWorkspacePath(dir, "outside/new.txt", { mustExist: false }), { code: "UNSAFE_PATH" });
  assert.throws(() => snapshotArtifact(dir, ["*.txt"]), { code: "UNSUPPORTED_GLOB" });
  assert.throws(() => snapshotArtifact(dir), { code: "UNSAFE_PATH" });
  fs.unlinkSync(path.join(dir, "outside"));
  fs.symlinkSync("inside.txt", path.join(dir, "alias.txt"));
  const manifest = snapshotArtifact(dir);
  write("inside.txt", "changed"); assert.equal(artifactFresh(manifest), false);
  assert.equal(safeWorkspacePath(dir, "future/file.txt", { mustExist: false }), path.join(fs.realpathSync(dir), "future/file.txt"));
});

test("artifact exclusions accept local absolute sidecars without reading external paths", (t) => {
  const { dir, write } = fixture(t);
  write("PLAN.md"); write("src/a.js");
  const manifest = snapshotArtifact(dir, ["."], { exclude: [path.join(dir, "PLAN.md"), "/elsewhere/PLAN.md"] });
  assert.deepEqual(manifest.exclude, ["PLAN.md"]);
  write("PLAN.md", "status update"); assert.equal(artifactFresh(manifest), true);
});
