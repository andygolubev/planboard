import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "bin", "planboard.js");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, "project");
  const home = path.join(dir, "home");
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  // Isolate global installs without changing the real home or Codex configuration.
  const preload = path.join(dir, "home.mjs");
  fs.writeFileSync(preload, `import os from 'node:os'; os.homedir = () => ${JSON.stringify(home)};\n`);
  return {
    project, home,
    run(...args) {
      return spawnSync(process.execPath, ["--import", preload, cli, ...args], {
        cwd: project, encoding: "utf8", timeout: 10000,
        env: { ...process.env, PLANBOARD_HOME: path.join(dir, "state") },
      });
    },
  };
}

for (const global of [false, true]) {
  test(`Codex setup installs a usable ${global ? "global" : "project"} skill and preserves instructions`, (t) => {
    const f = fixture(t);
    const instructions = "# Project instructions\n\nKeep existing conventions.\n";
    const instructionsPath = path.join(f.project, "AGENTS.md");
    fs.writeFileSync(instructionsPath, instructions);
    const otherSkill = path.join(f.project, ".agents", "skills", "other");
    fs.mkdirSync(otherSkill, { recursive: true });
    fs.writeFileSync(path.join(otherSkill, "SKILL.md"), "unrelated skill\n");
    const configDir = path.join(f.home, ".codex");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "AGENTS.md"), instructions);
    fs.writeFileSync(path.join(configDir, "config.toml"), "# existing configuration\n");
    const args = ["setup", "codex", ...(global ? ["--global"] : [])];
    const r = f.run(...args);
    assert.equal(r.status, 0, r.stderr);
    const skillPath = path.join(global ? f.home : f.project, ".agents", "skills", "planboard", "SKILL.md");
    const skill = fs.readFileSync(skillPath, "utf8");
    assert.match(r.stdout, /Use \$planboard/);
    assert.match(skill, /^---\nname: planboard\ndescription: [^\n]+\n---\n/);
    assert.match(skill, /planboard poll PLAN.md --timeout 30/);
    assert.match(skill, /planboard reply PLAN.md --to <note-id>/);
    assert.doesNotMatch(skill, /\$ARGUMENTS|run_in_background|\/planboard/);
    assert.equal(skill, fs.readFileSync(path.join(root, "skills", "codex", "planboard", "SKILL.md"), "utf8"));
    assert.equal(f.run(...args).status, 0);
    assert.equal(fs.readFileSync(skillPath, "utf8"), skill, "repeated setup is idempotent");
    assert.equal(fs.readFileSync(instructionsPath, "utf8"), instructions);
    assert.equal(fs.readFileSync(path.join(configDir, "AGENTS.md"), "utf8"), instructions);
    assert.equal(fs.readFileSync(path.join(configDir, "config.toml"), "utf8"), "# existing configuration\n");
    assert.equal(fs.readFileSync(path.join(otherSkill, "SKILL.md"), "utf8"), "unrelated skill\n");
    assert.equal(fs.existsSync(path.join(global ? f.project : f.home, ".agents", "skills", "planboard")), false);
  });

  test(`Claude setup retains ${global ? "global" : "project"} skills and idempotent hooks`, (t) => {
    const f = fixture(t);
    const dest = path.join(global ? f.home : f.project, ".claude");
    fs.mkdirSync(dest);
    const settings = { permissions: { allow: ["Bash(npm test)"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo existing" }] }] } };
    const settingsPath = path.join(dest, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const args = ["setup", "claude", "--hook", ...(global ? ["--global"] : [])];
    assert.equal(f.run(...args).status, 0);
    assert.equal(f.run(...args).status, 0);
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(after.permissions, settings.permissions);
    assert.deepEqual(after.hooks.SessionStart[0], settings.hooks.SessionStart[0]);
    assert.equal(after.hooks.SessionStart.length, 2);
    assert.equal(after.hooks.SessionStart[1].hooks[0].command, "planboard boards --brief");
    const skill = fs.readFileSync(path.join(dest, "skills", "planboard", "SKILL.md"), "utf8");
    assert.match(skill, /\$ARGUMENTS/);
    assert.equal(skill, fs.readFileSync(path.join(root, "skills", "planboard", "SKILL.md"), "utf8"));
  });

  test(`Cursor setup retains ${global ? "global" : "project"} behavior`, (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.project, "AGENTS.md"), "# Existing project rules\n");
    const args = ["setup", "cursor", "--agents-md", ...(global ? ["--global"] : [])];
    const r = f.run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.run(...args).status, 0);
    const dest = path.join(global ? f.home : f.project, ".cursor");
    assert.ok(fs.existsSync(path.join(dest, "skills", "planboard", "SKILL.md")));
    assert.equal(fs.existsSync(path.join(dest, "rules", "planboard.mdc")), !global);
    const agents = fs.readFileSync(path.join(f.project, "AGENTS.md"), "utf8");
    assert.ok(agents.startsWith("# Existing project rules\n"));
    assert.equal(agents.match(/## planboard/g).length, 1);
    if (global) assert.match(r.stdout, /Settings › Rules/);
    else assert.match(fs.readFileSync(path.join(dest, "rules", "planboard.mdc"), "utf8"), /alwaysApply: false/);
  });
}

test("setup defaults to Claude, advertises Codex, and rejects unsupported Codex options before writing", (t) => {
  const f = fixture(t);
  assert.equal(f.run("setup").status, 0);
  assert.ok(fs.existsSync(path.join(f.project, ".claude", "skills", "planboard", "SKILL.md")));
  assert.match(f.run("--help").stdout, /planboard setup codex \[--global\]/);
  const unknown = f.run("setup", "unknown");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /claude.*cursor.*codex/);
  for (const flag of ["--hook", "--agents-md"]) {
    assert.equal(f.run("setup", "codex", flag).status, 1);
  }
  assert.equal(fs.existsSync(path.join(f.project, ".agents")), false);
});
