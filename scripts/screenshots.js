// Capture the real UI using a disposable copy of the public example. The notes
// and status changes below are synthetic fixtures, never a user's review history.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { PLAN_TEMPLATE } from "../src/guidance.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-screenshots-"));
const plan = path.join(temp, "PLAN.md");
fs.copyFileSync(path.join(root, "examples", "golden-plan.md"), plan);
const template = path.join(temp, "New-task.md");
fs.writeFileSync(template, PLAN_TEMPLATE("New task template"));
process.env.PLANBOARD_HOME = path.join(temp, "home");
process.env.PLANBOARD_STATE_DIR = path.join(temp, "state");
process.env.PLANBOARD_NO_OPEN = "1";
process.env.PLANBOARD_IDLE_TIMEOUT_MS = "0";
const run = promisify(execFile);
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
process.env.PLANBOARD_PORT = String(port);
const { serve } = await import("../src/server.js");
let server, browser, listener;
const pollAbort = new AbortController();
const cli = async (...args) => (await run(process.execPath, [path.join(root, "bin", "planboard.js"), ...args], { timeout: 15000 })).stdout;

try {
  server = await serve({ host: "127.0.0.1", port });
  const opened = await cli(plan, "--no-open");
  assert.match(opened, /board: Weekly report export/);
  const board = server.boardFor(plan);
  server.boardFor(template);
  const executablePath = process.env.PLANBOARD_BROWSER || ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(fs.existsSync);
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce" });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(board.url);
  await page.locator(".plan-now").waitFor();
  await page.locator('figure.diagram svg').waitFor({ state: "attached" });
  // Give the review panel enough room for both the conversation and change flow.
  await page.locator('[data-resize-panel="right"]').focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
  assert.equal(board.store.notes.length, 0);
  assert.equal(board.store.events.length, 0);

  // Exercise the same open → note → poll → edit → reply loop installed for Codex.
  await page.locator('[data-thoughts="description"]').click();
  await page.locator("#composerText").fill("Can we deliver this without maintaining a second report calculation?");
  await page.locator("#addBtn").click();
  await page.locator("#sendBtn").click();
  const feedback = JSON.parse(await cli("poll", plan, "--timeout", "30", "--owner", "Review agent"));
  assert.equal(feedback.status, "feedback");
  assert.equal(feedback.notes[0].anchor.section, "description");
  await cli("set", plan, "export-query", "done");
  await cli("set", plan, "export-format", "blocked");
  const reply = "Yes. The export reuses the screen's query and permission check. Fixture totals now match; the adapter is waiting for the format decision.";
  fs.writeFileSync(plan, fs.readFileSync(plan, "utf8")
    .replace("Permission boundary checked in the example fixture; a working export is not yet verified.", "Permission and report-total checks passed in the example fixtures; the download is not yet verified.")
    .replace("Sam — finish the shared query comparison while Morgan chooses the file format.", "Morgan — choose the file format so Riley can implement the adapter.")
    .replace("| Match the screen | Unverified | Shared query connection is still in progress. |", "| Match the screen | Fixture totals match | Fictional local query comparison, 2026-10-18; no deployed result observed. |")
    .replace("| 2026-10-18 | Permission checks passed; query comparison started. | Fictional implementation review |", "| 2026-10-18 | Permission and query comparisons passed; adapter awaits the format decision. | Fictional implementation review |"));
  await cli("reply", plan, "--to", feedback.notes[0].id, reply);
  await page.getByText(reply, { exact: true }).waitFor();
  await page.locator(".plan-now").getByText(/Morgan — choose/).waitFor();
  assert.equal(JSON.parse(await cli("poll", plan, "--timeout", "0.1", "--owner", "Review agent")).status, "waiting");

  listener = run(process.execPath, [path.join(root, "bin", "planboard.js"), "poll", plan, "--timeout", "30", "--owner", "Review agent"], { signal: pollAbort.signal }).catch((err) => {
    if (err.name !== "AbortError") throw err;
  });
  await page.locator("#presence").filter({ hasText: "Review agent" }).waitFor();
  // Wait for the actual theme asset and fonts before capturing the real UI.
  const readyForCapture = async () => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      const background = getComputedStyle(document.body).backgroundImage;
      const url = background.match(/url\(["']?(.*?)["']?\)/)?.[1];
      if (url) {
        const image = new Image();
        image.src = url;
        await image.decode();
      }
    });
    await page.mouse.move(0, 0);
  };
  const jump = async (section) => {
    await page.locator(`#contentsLinks [data-jump-section="${section}"]`).click();
    await page.waitForFunction(id => document.querySelector('#contentsLinks [aria-current="location"]')?.dataset.jumpSection === id, section);
  };
  const capture = async (name) => {
    await readyForCapture();
    await page.screenshot({ path: path.join(root, "docs", name), type: "jpeg", quality: 90, animations: "disabled" });
  };
  await jump("plan");
  assert.equal(await page.locator(".plan-section").count(), 10);
  assert.equal(await page.locator(".contents-group").count(), 4);
  await capture("board.jpg");
  await page.locator("#themeToggle").click();
  await page.locator('html[data-theme="dark"]').waitFor();
  await page.locator('figure.diagram svg').waitFor({ state: "attached" });
  await jump("architecture");
  await page.locator("#architecture-notes > summary").click();
  await capture("board-dark.jpg");
  await page.locator("#themeToggle").click();
  await page.locator('html[data-theme="light"]').waitFor();
  await jump("implementation");
  await page.locator('[data-tab="changes"]').click();
  await page.locator("#panelScroll .change-row").first().waitFor();
  await capture("changes.jpg");
  assert.deepEqual(errors, [], "the board must render without browser exceptions");
  console.log("Captured docs/board.jpg, docs/board-dark.jpg, and docs/changes.jpg; browser rendering and CLI review loop passed.");
} finally {
  pollAbort.abort();
  if (listener) await listener;
  if (browser) await browser.close();
  if (server) await server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
