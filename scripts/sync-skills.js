import fs from "node:fs";
import { SKILL_MD, CODEX_SKILL_MD, CURSOR_SKILL_MD, OPENCODE_SKILL_MD } from "../src/guidance.js";

fs.writeFileSync(new URL("../skills/planboard/SKILL.md", import.meta.url), SKILL_MD);
fs.writeFileSync(new URL("../skills/codex/planboard/SKILL.md", import.meta.url), CODEX_SKILL_MD);
fs.writeFileSync(new URL("../skills/cursor/planboard/SKILL.md", import.meta.url), CURSOR_SKILL_MD);
fs.writeFileSync(new URL("../skills/opencode/planboard/SKILL.md", import.meta.url), OPENCODE_SKILL_MD);
