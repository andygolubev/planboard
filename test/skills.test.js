import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { SKILL_MD, CODEX_SKILL_MD, CURSOR_SKILL_MD, OPENCODE_SKILL_MD } from "../src/guidance.js";

for (const [file, expected] of [
  ["skills/planboard/SKILL.md", SKILL_MD],
  ["skills/codex/planboard/SKILL.md", CODEX_SKILL_MD],
  ["skills/cursor/planboard/SKILL.md", CURSOR_SKILL_MD],
  ["skills/opencode/planboard/SKILL.md", OPENCODE_SKILL_MD],
]) {
  test(`${file} matches its exported guidance constant`, () => {
    assert.equal(
      fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
      expected,
      `${file} is out of sync. Run npm run sync-skills to regenerate the packaged files from the constants in src/guidance.js.`,
    );
  });
}
