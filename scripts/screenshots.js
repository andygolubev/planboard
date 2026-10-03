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

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-screenshots-"));
const plan = path.join(temp, "PLAN.md");
fs.copyFileSync(path.join(root, "PLAN.md"), plan);
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
  assert.match(opened, /board: Community garden launch/);
  const board = server.boardFor(plan);
  browser = await chromium.launch({
    ...(process.env.PLANBOARD_BROWSER ? { executablePath: process.env.PLANBOARD_BROWSER } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, colorScheme: "light" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(board.url);
  await page.locator('.section-disclosure[data-owner="site"][data-kind="tasks"] > summary').click();
  await page.locator('[data-item="site-soil"]').waitFor();
  await page.locator('figure.diagram svg').waitFor({ state: "attached" });
  // Give the review panel enough room for both the conversation and change flow.
  await page.locator('[data-resize-panel="right"]').focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
  assert.equal(board.store.notes.length, 0);
  assert.equal(board.store.events.length, 0);

  // Exercise the same open → note → poll → edit → reply loop installed for Codex.
  await page.locator('[data-item="site-soil"]').click();
  await page.locator("#composerText").fill("Can we label the beds before planting day?");
  await page.locator("#addBtn").click();
  await page.locator("#sendBtn").click();
  const feedback = JSON.parse(await cli("poll", plan, "--timeout", "30", "--owner", "Review agent"));
  assert.equal(feedback.status, "feedback");
  assert.equal(feedback.notes[0].item.id, "site-soil");
  await cli("set", plan, "site-soil", "done");
  await cli("reply", plan, "--to", feedback.notes[0].id, "The soil is ready and each bed now has a label. The water station is next.");
  await cli("set", plan, "site-water", "in_progress");
  await page.getByText("The soil is ready and each bed now has a label. The water station is next.", { exact: true }).waitFor();
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
  await readyForCapture();
  await page.screenshot({ path: path.join(root, "docs", "board.jpg"), type: "jpeg", quality: 90 });
  await page.locator("#themeToggle").click();
  await page.locator('html[data-theme="dark"]').waitFor();
  await readyForCapture();
  await page.screenshot({ path: path.join(root, "docs", "board-dark.jpg"), type: "jpeg", quality: 90 });
  await page.locator("#themeToggle").click();
  await page.locator('html[data-theme="light"]').waitFor();
  await page.locator('[data-tab="changes"]').click();
  await page.locator("#panelScroll .change-row").first().waitFor();
  await readyForCapture();
  await page.screenshot({ path: path.join(root, "docs", "changes.jpg"), type: "jpeg", quality: 90 });
  assert.deepEqual(errors, [], "the board must render without browser exceptions");
  console.log("Captured docs/board.jpg, docs/board-dark.jpg, and docs/changes.jpg; browser rendering and CLI review loop passed.");
} finally {
  pollAbort.abort();
  if (listener) await listener;
  if (browser) await browser.close();
  if (server) await server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
