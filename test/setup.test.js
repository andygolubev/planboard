import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "bin", "planboard.js");

function fixture(t, setupEnv = {}) {
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
        env: { ...process.env, PLANBOARD_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: "", OPENCODE_CONFIG_DIR: "", ...setupEnv },
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
    assert.match(skill, /Do not create commits or new Git branches/);
    assert.match(skill, /unless the user explicitly asks for that Git action/);
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
    const instructionsPath = path.join(f.project, "CLAUDE.md");
    const globalInstructionsPath = path.join(f.home, ".claude", "CLAUDE.md");
    const instructions = "# Existing Claude instructions\n";
    fs.mkdirSync(path.dirname(globalInstructionsPath), { recursive: true });
    fs.writeFileSync(instructionsPath, instructions);
    fs.writeFileSync(globalInstructionsPath, instructions);
    assert.equal(f.run("setup", "claude", ...(global ? ["--global"] : [])).status, 0);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), JSON.stringify(settings), "settings stay unchanged without --hook");
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
    assert.equal(fs.readFileSync(instructionsPath, "utf8"), instructions);
    assert.equal(fs.readFileSync(globalInstructionsPath, "utf8"), instructions);
    assert.equal(fs.existsSync(path.join(global ? f.project : f.home, ".claude", "skills", "planboard")), false);
  });

  test(`Cursor setup retains ${global ? "global" : "project"} behavior`, (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.project, "AGENTS.md"), "# Existing project rules\n");
    assert.equal(f.run("setup", "cursor", ...(global ? ["--global"] : [])).status, 0);
    assert.equal(fs.readFileSync(path.join(f.project, "AGENTS.md"), "utf8"), "# Existing project rules\n", "instructions stay unchanged without --agents-md");
    const args = ["setup", "cursor", "--agents-md", ...(global ? ["--global"] : [])];
    const r = f.run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.run(...args).status, 0);
    const dest = path.join(global ? f.home : f.project, ".cursor");
    const skill = fs.readFileSync(path.join(dest, "skills", "planboard", "SKILL.md"), "utf8");
    assert.equal(skill, fs.readFileSync(path.join(root, "skills", "cursor", "planboard", "SKILL.md"), "utf8"));
    assert.doesNotMatch(skill, /\$ARGUMENTS|run_in_background/);
    assert.equal(fs.existsSync(path.join(global ? f.project : f.home, ".cursor", "skills", "planboard")), false);
    assert.equal(fs.existsSync(path.join(dest, "rules", "planboard.mdc")), !global);
    const agents = fs.readFileSync(path.join(f.project, "AGENTS.md"), "utf8");
    assert.ok(agents.startsWith("# Existing project rules\n"));
    assert.equal(agents.match(/## planboard/g).length, 1);
    if (global) assert.match(r.stdout, /Settings › Rules/);
    else assert.match(fs.readFileSync(path.join(dest, "rules", "planboard.mdc"), "utf8"), /alwaysApply: false/);
  });

  test(`OpenCode setup installs a ${global ? "global" : "project"} skill and preserves instructions and configuration`, (t) => {
    const f = fixture(t);
    const configDir = path.join(f.home, ".config", "opencode");
    const dest = global ? configDir : path.join(f.project, ".opencode");
    fs.mkdirSync(configDir, { recursive: true });
    const preserved = new Map([
      [path.join(f.project, "AGENTS.md"), "# Existing project instructions\n"],
      [path.join(configDir, "AGENTS.md"), "# Existing user instructions\n"],
      [path.join(f.project, "opencode.json"), '{ "permission": { "bash": "ask" } }\n'],
      [path.join(configDir, "opencode.json"), '{ "permission": { "skill": { "*": "ask" } } }\n'],
      [path.join(dest, "skills", "other", "SKILL.md"), "unrelated skill\n"],
    ]);
    for (const [file, content] of preserved) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    const args = ["setup", "opencode", ...(global ? ["--global"] : [])];
    const r = f.run(...args);
    assert.equal(r.status, 0, r.stderr);
    const skillPath = path.join(dest, "skills", "planboard", "SKILL.md");
    const skill = fs.readFileSync(skillPath, "utf8");
    assert.match(skill, /^---\nname: planboard\ndescription: [^\n]+\n---\n/);
    assert.doesNotMatch(skill, /\$ARGUMENTS|run_in_background/);
    assert.equal(skill, fs.readFileSync(path.join(root, "skills", "opencode", "planboard", "SKILL.md"), "utf8"));
    assert.equal(f.run(...args).status, 0);
    assert.equal(fs.readFileSync(skillPath, "utf8"), skill, "repeated setup is idempotent");
    for (const [file, content] of preserved) assert.equal(fs.readFileSync(file, "utf8"), content);
    const otherScope = global ? path.join(f.project, ".opencode") : configDir;
    assert.equal(fs.existsSync(path.join(otherScope, "skills", "planboard")), false);
  });
}

test("OpenCode global setup follows config overrides while project setup stays local", (t) => {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-config-"));
  t.after(() => fs.rmSync(configRoot, { recursive: true, force: true }));
  const xdg = path.join(configRoot, "xdg");
  const custom = path.join(configRoot, "custom");
  const f = fixture(t, { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: custom });
  assert.equal(f.run("setup", "opencode").status, 0);
  assert.ok(fs.existsSync(path.join(f.project, ".opencode", "skills", "planboard", "SKILL.md")));
  assert.equal(fs.existsSync(custom), false);
  assert.equal(fs.existsSync(xdg), false);
  assert.equal(f.run("setup", "opencode", "--global").status, 0);
  assert.ok(fs.existsSync(path.join(custom, "skills", "planboard", "SKILL.md")));
  assert.equal(fs.existsSync(xdg), false, "explicit config directory takes precedence over XDG");
  assert.equal(fs.existsSync(path.join(f.home, ".config")), false);

  const g = fixture(t, { XDG_CONFIG_HOME: xdg });
  assert.equal(g.run("setup", "opencode", "--global").status, 0);
  assert.ok(fs.existsSync(path.join(xdg, "opencode", "skills", "planboard", "SKILL.md")));
  assert.equal(fs.existsSync(path.join(g.home, ".config")), false);
});

test("OpenCode ignores a relative XDG_CONFIG_HOME", (t) => {
  const f = fixture(t, { XDG_CONFIG_HOME: "relative-config" });
  assert.equal(f.run("setup", "opencode", "--global").status, 0);
  assert.ok(fs.existsSync(path.join(f.home, ".config", "opencode", "skills", "planboard", "SKILL.md")));
  assert.equal(fs.existsSync(path.join(f.project, "relative-config")), false);
});

test("setup defaults to Claude, advertises all hosts, and rejects unsupported options before writing", (t) => {
  const f = fixture(t);
  assert.equal(f.run("setup").status, 0);
  assert.ok(fs.existsSync(path.join(f.project, ".claude", "skills", "planboard", "SKILL.md")));
  const help = f.run("--help").stdout;
  for (const target of ["claude", "cursor", "codex", "opencode"]) {
    assert.ok(help.includes(`planboard setup ${target} [--global]`));
  }
  const unknown = f.run("setup", "unknown");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /claude.*cursor.*codex.*opencode/);
  for (const target of ["codex", "opencode"]) {
    for (const flag of ["--hook", "--agents-md"]) {
      assert.equal(f.run("setup", target, flag).status, 1);
    }
  }
  assert.equal(fs.existsSync(path.join(f.project, ".agents")), false);
  assert.equal(fs.existsSync(path.join(f.project, ".opencode")), false);
});

test("all packaged host skills teach explicit dispatch, leases and evidence gates", () => {
  for (const relative of ["skills/planboard/SKILL.md", "skills/codex/planboard/SKILL.md", "skills/cursor/planboard/SKILL.md", "skills/opencode/planboard/SKILL.md"]) {
    const skill = fs.readFileSync(path.join(root, relative), "utf8");
    for (const phrase of ["Record dispatch before", "--parent-pid", "--max-duration 300", "--coordinator", "--worker <id> --token <coordinator-token>", "separate from accepted/not_validated/pending/stale", "Planboard does", "does not", "No model API is built in"]) assert.ok(skill.includes(phrase), `${relative}: missing ${phrase}`);
  }
});
