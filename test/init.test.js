import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/planboard.js", import.meta.url));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-init-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    run(cwd, ...args) {
      return spawnSync(process.execPath, [cli, "init", ...args], {
        cwd, encoding: "utf8", timeout: 10000,
      });
    },
  };
}

for (const worktree of [false, true]) {
  test(`init defaults to the repository root from a subdirectory (${worktree ? "worktree" : "normal repo"})`, (t) => {
    const f = fixture(t);
    if (worktree) fs.writeFileSync(path.join(f.dir, ".git"), "gitdir: /unused/worktree\n");
    else fs.mkdirSync(path.join(f.dir, ".git"));
    const nested = path.join(f.dir, "src", "app");
    fs.mkdirSync(nested, { recursive: true });
    const r = f.run(nested);
    assert.equal(r.status, 0, r.stderr);
    const target = path.join(f.dir, ".planboard", "PLAN.md");
    const content = fs.readFileSync(target, "utf8");
    assert.ok(content.includes(`# ${path.basename(f.dir)}`));
    assert.ok(r.stdout.includes(target));
    assert.equal(fs.existsSync(path.join(nested, ".planboard")), false);
    assert.equal(f.run(nested).status, 1, "does not overwrite an existing plan");
    assert.equal(fs.readFileSync(target, "utf8"), content);
    const force = f.run(nested, "--force", "--title", "Replacement plan");
    assert.equal(force.status, 0, force.stderr);
    assert.match(fs.readFileSync(target, "utf8"), /# Replacement plan/);
  });
}

test("init uses the current directory outside Git", (t) => {
  const f = fixture(t);
  const r = f.run(f.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(f.dir, ".planboard", "PLAN.md")));
});

test("init honors explicit relative and absolute locations", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, ".git"));
  const nested = path.join(f.dir, "src");
  fs.mkdirSync(nested);
  const relative = f.run(nested, "docs/custom.md", "--title", "Custom plan");
  assert.equal(relative.status, 0, relative.stderr);
  assert.match(fs.readFileSync(path.join(nested, "docs", "custom.md"), "utf8"), /# Custom plan/);
  const absolute = path.join(f.dir, "elsewhere", "launch.md");
  const r = f.run(nested, absolute);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(absolute));
  assert.equal(fs.existsSync(path.join(f.dir, ".planboard")), false);
});
