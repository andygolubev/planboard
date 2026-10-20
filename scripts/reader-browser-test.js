// Exercise the real reader with disposable copies of a public, fictional plan.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-reader-browser-"));
const output = path.resolve(process.env.PLANBOARD_READER_OUTPUT || "test-results/reader");
fs.mkdirSync(output, { recursive: true });
const source = fs.readFileSync(new URL("../examples/golden-plan.md", import.meta.url), "utf8");
const plan = path.join(temp, "PLAN.md");
const other = path.join(temp, "SECOND.md");
const legacy = path.join(temp, "LEGACY.md");
fs.writeFileSync(plan, source);
fs.writeFileSync(other, source.replaceAll("Weekly report export", "Monthly report export"));
fs.writeFileSync(legacy, "# Legacy plan {#plan}\n\n## Mixed section {#mixed}\n\nA description.\n\n- [ ] First action {#first}\n\n### Context {#context}\n\nKeep this explanation between actions.\n\n- [ ] Second action {#second}\n");
process.env.PLANBOARD_HOME = path.join(temp, "home");
process.env.PLANBOARD_STATE_DIR = path.join(temp, "state");
process.env.PLANBOARD_NO_OPEN = "1";
process.env.PLANBOARD_IDLE_TIMEOUT_MS = "0";
const { serve } = await import("../src/server.js");
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
});
let server, browser, page;
const errors = [];
const waitActive = async id => page.waitForFunction(id => document.querySelector('#contentsLinks [aria-current="location"]')?.dataset.jumpSection === id, id);
const jump = async id => { await page.locator(`#contentsLinks [data-jump-section="${id}"]`).click(); await waitActive(id); };
const sectionTop = id => page.locator(`#sec-${id}`).evaluate(el => el.getBoundingClientRect().top - document.querySelector("#board").getBoundingClientRect().top);
const capture = async name => { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(output, name), animations: "disabled" }); };
const opened = () => page.locator("#board details").evaluateAll(groups => groups.map(el => el.open));

try {
  server = await serve({ host: "127.0.0.1", port, openPlan: plan });
  const board = server.boardFor(plan);
  const second = server.boardFor(other);
  const old = server.boardFor(legacy);
  const executablePath = process.env.PLANBOARD_BROWSER || ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(fs.existsSync);
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  page = await browser.newPage({ viewport: { width: 1550, height: 1000 }, reducedMotion: "reduce", colorScheme: "light" });
  page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(board.url);
  await page.locator("figure.diagram svg").waitFor({ state: "attached" });
  assert.equal(await page.locator(".plan-section").count(), 10);
  assert.equal(await page.locator(".contents-group").count(), 4);
  assert.equal(await page.locator("#board details").count(), 3, "no automatic task or section accordions");
  for (const id of ["file-format", "export-access", "export-query", "export-format", "preview-check"]) {
    assert.equal(await page.locator(`[data-item="${id}"]`).isVisible(), true, `${id} remains visible without expansion`);
  }
  assert.match(await page.locator(".plan-now").innerText(), /Sam — finish/);
  assert.match(await page.locator("#sec-implementation .sec-progress").innerText(), /1\/3 actions/);
  assert.equal(await page.locator("#sec-decisions .sec-progress").count(), 0);
  await capture("overview.png");

  const panelBefore = await page.locator("#panelContext").innerText();
  await jump("implementation");
  assert.ok(Math.abs(await sectionTop("implementation") - 24) < 2);
  assert.equal(await page.locator("#panelContext").innerText(), panelBefore, "outline navigation does not change discussion selection");
  const before = await sectionTop("implementation");
  await page.locator("#expandBtn").click();
  assert.deepEqual(await opened(), [true, true, true], "Expand all includes nested supporting detail");
  assert.ok(Math.abs(await sectionTop("implementation") - before) < 2, "expansion preserves reading position");
  await page.locator("#collapseBtn").click();
  assert.deepEqual(await opened(), [false, false, false]);
  assert.ok(Math.abs(await sectionTop("implementation") - before) < 2, "collapsing preserves reading position");
  assert.equal(await page.locator('[data-item="export-format"]').isVisible(), true);

  await jump("architecture");
  await page.locator("#architecture-notes > summary").click();
  await jump("implementation");
  await page.locator("#implementation-evidence > summary").click();
  assert.deepEqual(await opened(), [true, false, true], "opening another detail leaves the first open");

  // Manual scrolling must update the outline while discussion remains unchanged.
  await page.locator("#sec-apply").evaluate(el => {
    const board = document.querySelector("#board");
    board.scrollTop += el.getBoundingClientRect().top - board.getBoundingClientRect().top - 24;
  });
  await waitActive("apply");
  await capture("apply.png");
  await page.evaluate(() => history.replaceState(null, "", location.pathname));
  await page.reload();
  await page.locator("figure.diagram svg").waitFor({ state: "attached" });
  await waitActive("apply");
  assert.deepEqual(await opened(), [true, false, true], "reload restores disclosure state");

  // A file update keeps the current section and its offset, and refreshes Now.
  const applyBefore = await sectionTop("apply");
  fs.writeFileSync(plan, source.replace("Reuse the report query and permission check.", `${"Extra design context. ".repeat(80)}\n\nReuse the report query and permission check.`).replace("Sam — finish the shared query comparison", "Riley — finish the shared query comparison"));
  await page.locator(".plan-now").getByText(/Riley — finish/).waitFor();
  await page.locator("figure.diagram svg").waitFor({ state: "attached" });
  await waitActive("apply");
  assert.ok(Math.abs(await sectionTop("apply") - applyBefore) < 3, "live edits preserve the reading anchor");
  assert.deepEqual(await opened(), [true, false, true]);

  await page.locator("#boardSwitcher").selectOption(second.key);
  await page.waitForURL(`${second.url}#sec-apply`);
  await waitActive("apply");
  assert.deepEqual(await opened(), [false, false, false], "another plan has independent detail state");
  await page.locator("#boardSwitcher").selectOption(board.key);
  await page.waitForURL(`${board.url}#sec-apply`);
  await waitActive("apply");
  assert.deepEqual(await opened(), [true, false, true]);

  await jump("download-adapter");
  await page.locator("#boardSwitcher").selectOption(second.key);
  await page.waitForURL(`${second.url}#sec-implementation`);
  await waitActive("implementation");
  await page.locator("#boardSwitcher").selectOption(board.key);
  await page.waitForURL(`${board.url}#sec-implementation`);
  await waitActive("implementation");

  // Deep links reveal nested supporting content, without losing existing anchors.
  await page.goto(`${board.url}#query-contract-heading`);
  await waitActive("query-contract-heading");
  assert.deepEqual(await opened(), [true, true, true]);
  await page.locator("#collapseBtn").click();
  await waitActive("architecture");
  assert.ok(Math.abs(await page.locator("#architecture-notes > summary").evaluate(el => el.getBoundingClientRect().top - document.querySelector("#board").getBoundingClientRect().top) - 24) < 2);
  await page.locator("#expandBtn").click();
  await page.goto(`${board.url}#export-query`);
  await page.locator('[data-item="export-query"].selected').waitFor();
  await page.locator("#composerText").fill("Keep the comparison evidence with this action.");
  await page.locator("#addBtn").click();
  await page.locator("#panelScroll").getByText("Keep the comparison evidence with this action.", { exact: true }).waitFor();
  assert.equal(board.store.notes.at(-1).anchor.item, "export-query");

  await jump("decisions");
  await page.locator("#themeToggle").click();
  await page.locator('html[data-theme="dark"]').waitFor();
  await capture("decisions-dark.png");
  await page.locator("#board").evaluate(el => { el.scrollTop = el.scrollHeight; });
  await waitActive("timeline");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#contentsLinks").isVisible(), false);
  await page.locator("#sectionSelect").selectOption("requirements");
  await waitActive("requirements");
  assert.equal(await page.locator("body").evaluate(el => el.classList.contains("sheet-open")), false, "section navigation does not open the phone notes sheet");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture("mobile.png");
  await page.locator("#collapseBtn").click();
  await page.locator("#expandBtn").click();
  assert.deepEqual(await opened(), [true, true, true]);
  await page.locator("#collapseBtn").click();
  assert.deepEqual(await opened(), [false, false, false]);

  await page.setViewportSize({ width: 1550, height: 1000 });
  await page.goto(old.url);
  await page.locator(".plan-section").waitFor();
  assert.equal(await page.locator("#toolbar").isVisible(), false);
  assert.equal(await page.locator(".plan-now").count(), 0);
  const text = await page.locator(".plan-section").innerText();
  assert.ok(text.indexOf("First action") < text.indexOf("Keep this explanation"));
  assert.ok(text.indexOf("Keep this explanation") < text.indexOf("Second action"), "legacy source order survives rendering");
  await page.goto(`${board.url}#now-outcome`);
  await page.locator('[data-item="now-outcome"].selected').waitFor();
  assert.equal(await page.locator("#panelContext .status-pill").count(), 0, "plain text has no execution status in its discussion");
  await page.goto(`${board.url}#file-format`);
  await page.locator('[data-item="file-format"].selected').waitFor();
  assert.equal(await page.locator("#ctxStatus").count(), 0, "questions do not offer task states as answers");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await jump("architecture");
  assert.deepEqual(errors, [], "reader and review must render without browser exceptions");
  console.log(`Reader browser journey passed. Screenshots: ${output}`);
} catch (error) {
  if (page && !page.isClosed()) await capture("failure.png").catch(() => {});
  console.error("Browser exceptions:", errors);
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
