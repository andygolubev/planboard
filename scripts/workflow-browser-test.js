// End-to-end acceptance journey against a disposable, synthetic workspace.
// The browser uses the real UI and the workers use the public HTTP protocol.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "planboard-workflow-browser-"));
const output = path.resolve(process.env.PLANBOARD_BROWSER_OUTPUT || "test-results/workflow");
fs.mkdirSync(output, { recursive: true });
const plan = path.join(temp, "PLAN.md");
fs.mkdirSync(path.join(temp, "app"));
fs.writeFileSync(path.join(temp, "app/backend.txt"), "backend fixture\n");
fs.writeFileSync(path.join(temp, "app/ui.txt"), "ui fixture\n");
fs.writeFileSync(path.join(temp, "requirements.md"), "# Combined experience {#REQ-1}\nWorkers deliver a usable, validated combined output.\n\n## Scenario: use both outputs {#SC-1}\nBackend and UI work together.\n");
fs.writeFileSync(plan, "# Workflow acceptance journey {#plan}\n\n## Delivery {#delivery}\n\n- [ ] Backend adapter {#backend}\n- [ ] Browser interface {#ui}\n- [ ] Combined integration {#integration}\n- [x] Legacy completed task {#legacy}\n");
process.env.PLANBOARD_HOME = path.join(temp, "home");
process.env.PLANBOARD_STATE_DIR = path.join(temp, "state");
process.env.PLANBOARD_NO_OPEN = "1";
process.env.PLANBOARD_IDLE_TIMEOUT_MS = "0";
const { serve } = await import("../src/server.js");
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
});
const config = { schema_version: 1, workspace: ".", objective: "Deliver a validated combined experience", sources: [{ path: "requirements.md", kind: "requirements" }],
  tasks: Object.fromEntries(["backend", "ui", "integration"].map((id) => [id, { requirements: ["REQ-1"], criteria: [{ id: `AC-${id}`, text: `${id} works` }], depends_on: id === "integration" ? ["backend", "ui"] : [], integration_of: id === "integration" ? ["backend", "ui"] : [], scope: [id === "integration" ? "app" : `app/${id}.txt`], checks: [`CHECK-${id}`], outputs: ["patch"] }])),
  checks: Object.fromEntries(["backend", "ui", "integration"].map((id) => [`CHECK-${id}`, { method: "manual", required: true, criteria: [`AC-${id}`] }])) };
let server, browser, page, board, origin, apiBase, sequence = 0;
const errors = [];
const call = async (family, action, data = {}) => {
  const response = await fetch(`${apiBase}/workflow/${family}/${action}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ idempotency_key: `browser-${++sequence}`, ...data }) });
  const result = await response.json(); assert.ok(response.ok, `${family}/${action}: ${JSON.stringify(result)}`); return result;
};
const check = async (job, worker, outcome) => {
  const claim = await call("validate", "start", { job: job.id, worker: worker.id, worker_token: worker.worker_token });
  return call("validate", "result", { job: job.id, token: claim.token, outcome, summary: outcome === "failed" ? "Combined screen loses the backend response" : "Observed the expected combined behavior", evidence: [{ name: `${job.task}-${outcome}.txt`, text: `Synthetic acceptance evidence: ${outcome}` }], criteria: [{ id: `AC-${job.task}`, outcome, reference: `${job.task}-${outcome}.txt` }] });
};
const capture = async (name) => { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(output, name), fullPage: true, animations: "disabled" }); };
const tab = async (name) => { await page.getByRole("tab", { name, exact: true }).click(); };

try {
  server = await serve({ host: "127.0.0.1", port, openPlan: plan });
  board = server.boardFor(plan); origin = `http://127.0.0.1:${port}`; apiBase = `${board.url}/api`;
  const configured = await call("spec", "configure", { config }); assert.deepEqual(configured.issues, []);
  const register = (label, host) => call("worker", "register", { label, host, workspace: temp });
  const coordinator = await register("Coordinator", "codex");
  const lease = await call("worker", "coordinator", { worker: coordinator.id, worker_token: coordinator.worker_token });
  const owner = { worker: coordinator.id, token: lease.token };
  const backend = await register("Backend worker", "claude");
  const ui = await register("UI worker", "cursor");
  const reviewer = await register("Independent reviewer", "opencode");
  const candidates = [];
  for (const [id, worker] of [["backend", backend], ["ui", ui]]) {
    const run = await call("run", "create", { task: id, ...owner });
    const claim = await call("worker", "claim", { run: run.id, worker: worker.id, worker_token: worker.worker_token });
    candidates.push(await call("run", "submit", { attempt: claim.id, token: claim.token, summary: `${id} candidate` }));
  }
  const executablePath = process.env.PLANBOARD_BROWSER || ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  page = await browser.newPage({ viewport: { width: 1550, height: 1050 }, colorScheme: "light" });
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(board.url);
  await page.locator('[data-resize-panel="right"]').focus();
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowLeft");
  await page.locator('.section-disclosure[data-kind="tasks"] > summary').click();
  await page.locator('[data-item="legacy"] .wf-badge').getByText("Not validated", { exact: true }).waitFor();
  await tab("Requirements");
  await page.getByLabel("Requirement", { exact: true }).selectOption("REQ-1");
  await page.getByText("Assignments & evidence", { exact: true }).waitFor();
  await tab("Execution"); await page.getByText("Backend worker · claude", { exact: true }).first().waitFor();
  await tab("Validation");
  await page.locator('[data-wf-artifact]').first().getByText("Validation pending", { exact: true }).waitFor();
  // Independent results arrive over HTTP and the existing page receives them live.
  for (const candidate of candidates) await check(candidate.jobs[0], reviewer, "passed");
  await page.locator('[data-wf-artifact]').first().getByText("Validated", { exact: true }).waitFor();
  const combined = await call("run", "integrate", { task: "integration", artifacts: candidates.map((c) => c.artifact.id), summary: "Combined integration candidate", ...owner });
  const failed = await check(combined.jobs[0], reviewer, "failed");
  await page.locator(`[data-wf-artifact="${combined.artifact.id}"]`).getByText("failed", { exact: true }).waitFor();
  assert.equal(failed.gate.acceptance, "pending");
  await capture("failed-integration.png");
  const downloadReady = page.waitForEvent("download");
  await page.locator(`[data-wf-artifact="${combined.artifact.id}"] .wf-evidence`).click();
  const download = await downloadReady;
  assert.equal(download.suggestedFilename(), "integration-failed.txt");
  assert.match(fs.readFileSync(await download.path(), "utf8"), /Synthetic acceptance evidence: failed/);
  // The user can queue another check directly, but it does not manufacture evidence.
  await page.locator(`[data-wf-artifact="${combined.artifact.id}"]`).getByRole("button", { name: "Retry check" }).click();
  await page.locator(`[data-wf-artifact="${combined.artifact.id}"]`).getByText("queued", { exact: true }).waitFor();
  for (let i = 0; i < 8; i++) await call("spec", "refresh");
  await tab("Activity");
  await page.getByRole("button", { name: "Load older events" }).waitFor();
  const count = await page.locator(".wf-event").count();
  await page.getByRole("button", { name: "Load older events" }).click();
  await page.waitForFunction((old) => document.querySelectorAll(".wf-event").length > old, count);
  await page.getByLabel("Task", { exact: true }).selectOption("integration");
  await page.getByLabel("Outcome", { exact: true }).selectOption("failed");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.locator(".wf-event").filter({ hasText: "failed" }).first().waitFor();
  assert.equal(await page.locator(".wf-event").count(), 1);
  // A live update must retain unapplied filter values and keyboard focus.
  const fromTime = page.getByLabel("From time", { exact: true });
  await fromTime.fill("2026-01-01T12:00"); await fromTime.focus();
  await call("spec", "refresh");
  await page.waitForFunction(() => document.activeElement?.name === "from" && document.querySelector('input[name="from"]')?.value === "2026-01-01T12:00");
  await tab("Changes");
  await page.getByLabel("From revision", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Compare revisions" }).click();
  await page.getByText("Plan source changed", { exact: true }).waitFor();
  // Hold a real response until after a tab change: it must not overwrite the
  // new requirements view when the old resume request eventually resolves.
  let releaseResume;
  const resumeGate = new Promise((resolve) => { releaseResume = resolve; });
  let observedResume;
  const resumeObserved = new Promise((resolve) => { observedResume = resolve; });
  await page.route("**/workflow/resume*", async (route) => {
    const response = await route.fetch(); observedResume(); await resumeGate; await route.fulfill({ response });
  });
  await tab("Resume"); await resumeObserved; await tab("Requirements");
  releaseResume();
  await page.unrouteAll({ behavior: "wait" });
  assert.equal(await page.locator("[data-workflow-view]").getAttribute("data-workflow-view"), "requirements");
  await page.getByRole("heading", { name: "Requirements", exact: true }).waitFor();
  const repair = await call("run", "create", { task: "integration", repair_of: failed.result.id, ...owner });
  const claim = await call("worker", "claim", { run: repair.id, worker: backend.id, worker_token: backend.worker_token });
  const fixed = await call("run", "submit", { attempt: claim.id, token: claim.token, integrated: candidates.map((c) => c.artifact.id), summary: "Repaired integration candidate" });
  const accepted = await check(fixed.jobs[0], reviewer, "passed"); assert.equal(accepted.gate.acceptance, "accepted");
  await tab("Resume"); await page.getByText("Validated (3)", { exact: true }).waitFor();
  await capture("repaired-resume.png");
  // Restart the actual server, then revisit the persisted board in a new page.
  await page.close(); await server.close();
  server = await serve({ host: "127.0.0.1", port, openPlan: plan }); board = server.boardFor(plan);
  page = await browser.newPage({ viewport: { width: 1550, height: 1050 }, colorScheme: "light" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(board.url); await tab("Resume");
  await page.getByText("Validated (3)", { exact: true }).waitFor();
  await page.getByText("runtime.restarted", { exact: true }).first().waitFor();
  await capture("restart-resume.png");
  // Editing an upstream file invalidates both its result and integrated output.
  fs.writeFileSync(path.join(temp, "app/backend.txt"), "changed after validation\n");
  await call("spec", "refresh"); await tab("Validation");
  await page.locator(`[data-wf-artifact="${fixed.artifact.id}"]`).getByText("Stale artifact", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#sheetHandle").click();
  await page.keyboard.press("4");
  await page.getByLabel("Requirement", { exact: true }).selectOption("REQ-1");
  await page.waitForFunction(() => document.querySelector("#panel").getBoundingClientRect().top < 350);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await capture("mobile-requirements.png");
  await page.keyboard.press("1");
  await page.locator("#composerText").fill("Review the stale backend evidence.");
  await page.locator("#addBtn").click();
  await page.getByText("Review the stale backend evidence.", { exact: true }).waitFor();
  await page.locator("#sendBtn").click();
  assert.equal(board.store.notes.at(-1).state, "sent");
  assert.deepEqual(errors, [], "Browser must render without exceptions");
  console.log(`Workflow browser journey passed. Screenshots: ${output}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await capture("failure.png").catch(() => {});
    console.error("Browser exceptions:", errors);
    console.error("Visible panel:", await page.locator("#panelScroll").innerText().catch(() => "unavailable"));
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
