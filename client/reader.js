import { numberedSections, readingSection } from "./outline.js";
import { executionCounts } from "../src/progress.js";
import { esc } from "./util.js";

const GROUPS = { description: "Understand", decisions: "Decide", implementation: "Deliver", handoff: "Continue" };
const STANDARD = ["description", "requirements", "architecture", "decisions", "risks", "implementation", "apply", "results", "handoff", "timeline"];

// Reading position is independent of the item selected in the discussion panel.
export function createPlanReader({ board, contents, mobile, toolbar, expand, collapse, getState, load, save, onLayout }) {
  let active = null;
  let frame = null;
  let lastPosition = load("readerPosition", null);
  const savedDetails = load("readerDetails", {});
  const detailState = savedDetails && typeof savedDetails === "object" && !Array.isArray(savedDetails) ? savedDetails : {};
  const isVisible = el => !el.closest("details:not([open])") && el.getClientRects().length > 0;
  const headings = () => [...board.querySelectorAll(".section-head")].filter(isVisible);
  const details = () => [...board.querySelectorAll("details")];

  function position() {
    const visible = headings();
    const top = board.getBoundingClientRect().top;
    const id = readingSection(visible.map(el => ({ id: el.dataset.section, top: el.getBoundingClientRect().top })), {
      top, height: board.clientHeight, scrollTop: board.scrollTop, scrollHeight: board.scrollHeight,
    });
    const heading = visible.find(el => el.dataset.section === id);
    return heading ? { id, offset: top - heading.getBoundingClientRect().top } : null;
  }

  function restore(saved) {
    if (!saved || typeof saved.id !== "string" || !Number.isFinite(saved.offset)) return;
    const heading = [...board.querySelectorAll(".section-head")].find(el => el.dataset.section === saved.id);
    if (!heading) return;
    if (isVisible(heading)) {
      board.scrollTop += heading.getBoundingClientRect().top - board.getBoundingClientRect().top + saved.offset;
    } else {
      // If Collapse details removes the passage being read, stay at its visible
      // summary rather than jumping into an unrelated later section.
      let folded;
      for (let parent = heading.parentElement; parent && parent !== board; parent = parent.parentElement) {
        if (parent.matches("details:not([open])")) folded = parent;
      }
      const summary = folded?.querySelector(":scope > summary");
      if (summary) board.scrollTop += summary.getBoundingClientRect().top - board.getBoundingClientRect().top - 24;
    }
  }

  function highlight() {
    frame = null;
    const current = position();
    if (!current) return;
    lastPosition = current;
    save("readerPosition", current);
    active = current.id;
    for (const button of contents.querySelectorAll("[data-jump-section]")) {
      const selected = button.dataset.jumpSection === active;
      button.classList.toggle("active", selected);
      if (selected) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
    }
    mobile.value = active;
    // Keep the active entry visible in a long outline without moving the page.
    const selected = contents.querySelector('[aria-current="location"]');
    if (selected && contents.parentElement.clientHeight) {
      const nav = contents.parentElement;
      const bounds = nav.getBoundingClientRect();
      const rect = selected.getBoundingClientRect();
      if (rect.top < bounds.top + 8) nav.scrollTop -= bounds.top + 8 - rect.top;
      else if (rect.bottom > bounds.bottom - 8) nav.scrollTop += rect.bottom - bounds.bottom + 8;
    }
  }

  function schedule() {
    if (frame === null) frame = requestAnimationFrame(highlight);
  }

  function controls() {
    const groups = details();
    toolbar.hidden = !groups.length;
    expand.disabled = !groups.some(el => !el.open);
    collapse.disabled = !groups.some(el => el.open);
  }

  function rememberDetails() {
    for (const group of details()) detailState[group.dataset.readerDetail] = group.open;
    save("readerDetails", detailState);
    controls();
    onLayout();
    schedule();
  }

  function setDetails(open) {
    const saved = position();
    for (const group of details()) group.open = open;
    rememberDetails();
    restore(saved);
    highlight();
  }

  function jump(id, { history = true, smooth = true } = {}) {
    const heading = [...board.querySelectorAll(".section-head")].find(el => el.dataset.section === id);
    if (!heading) return false;
    for (let parent = heading.parentElement; parent && parent !== board; parent = parent.parentElement) {
      if (parent.matches("details")) parent.open = true;
    }
    const top = board.scrollTop + heading.getBoundingClientRect().top - board.getBoundingClientRect().top - 24;
    board.scrollTo({ top: Math.max(0, top), behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant" });
    if (history) window.history.pushState(null, "", `#${encodeURIComponent(heading.id)}`);
    schedule();
    return true;
  }

  function mount(plan, saved = lastPosition) {
    // Preserve the source order. Only author-written <details> may hide content.
    let section = null;
    for (const node of [...plan.childNodes]) {
      if (node.nodeType === 1 && node.matches('.section-head[data-level="2"]')) {
        section = document.createElement("section");
        section.className = "plan-section";
        section.dataset.outline = node.dataset.section;
        section.setAttribute("aria-labelledby", node.id);
        node.before(section);
      }
      if (section) section.append(node);
    }
    for (const section of plan.querySelectorAll(".plan-section")) {
      const thoughts = document.createElement("button");
      thoughts.type = "button";
      thoughts.className = "section-thoughts";
      thoughts.dataset.thoughts = section.dataset.outline;
      section.append(thoughts);
    }
    const occurrences = new Map();
    for (const group of details()) {
      group.classList.add("section-disclosure");
      const label = group.querySelector(":scope > summary")?.textContent.trim() || "Details";
      const base = JSON.stringify([group.closest("[data-outline]")?.dataset.outline || "plan", group.id || label]);
      const index = occurrences.get(base) || 0;
      occurrences.set(base, index + 1);
      const key = `${base}:${index}`;
      group.dataset.readerDetail = key;
      if (Object.hasOwn(detailState, key)) group.open = detailState[key] === true;
      const body = document.createElement("div");
      body.className = "disclosure-body";
      for (const node of [...group.childNodes]) {
        if (node.nodeType !== 1 || !node.matches("summary")) body.append(node);
      }
      group.append(body);
      group.addEventListener("toggle", () => { if (group.isConnected) rememberDetails(); });
    }
    render();
    restore(saved);
    highlight();
    resize.observe(plan);
  }

  function render() {
    const state = getState();
    const sections = numberedSections(state.sections || []);
    // Group only the canonical structure; arbitrary existing plans retain their outline.
    const standard = STANDARD.every(id => sections.some(s => s.id === id && s.level === 2));
    contents.innerHTML = sections.map(section => {
      const thread = state.threads?.[`section:${section.id}`];
      const counts = executionCounts(section.counts);
      const info = [section.number && counts.total ? `${counts.done}/${counts.total} actions done` : "",
        section.number && section.counts?.question ? `${section.counts.question} to decide` : "",
        thread ? `${thread.count} thought${thread.count === 1 ? "" : "s"}${thread.last_from === "agent" ? " · reply" : ""}` : ""].filter(Boolean).join(" · ");
      const group = standard && section.level === 2 ? GROUPS[section.id] : null;
      return `${group ? `<div class="contents-group">${group}</div>` : ""}<button type="button" class="contents-link" data-jump-section="${esc(section.id)}" style="--indent:${section.depth}"><span>${section.number ? `<span class="contents-number">${section.number}</span> ` : ""}${esc(section.displayTitle)}</span>${info ? `<small>${esc(info)}</small>` : ""}</button>`;
    }).join("");
    mobile.innerHTML = sections.map(s => `<option value="${esc(s.id)}">${s.number ? `${s.number} · ` : ""}${esc(s.displayTitle)}</option>`).join("");
    for (const button of board.querySelectorAll("[data-thoughts]")) {
      const thread = state.threads?.[`section:${button.dataset.thoughts}`];
      button.textContent = thread ? `${thread.count} thought${thread.count === 1 ? "" : "s"}${thread.last_from === "agent" ? " · Agent replied" : ""}` : "Discuss this section";
    }
    controls();
    highlight();
  }

  contents.addEventListener("click", event => {
    const button = event.target.closest("[data-jump-section]");
    if (button) jump(button.dataset.jumpSection);
  });
  mobile.addEventListener("change", () => jump(mobile.value));
  expand.addEventListener("click", () => setDetails(true));
  collapse.addEventListener("click", () => setDetails(false));
  board.addEventListener("scroll", schedule, { passive: true });
  const resize = new ResizeObserver(() => { onLayout(); schedule(); });
  resize.observe(board);
  function mainSection() {
    const id = position()?.id;
    const heading = headings().find(el => el.dataset.section === id);
    return heading?.closest("[data-outline]")?.dataset.outline || heading?.dataset.section;
  }
  return { mount(plan, saved) { resize.disconnect(); resize.observe(board); mount(plan, saved); }, render, jump, position, mainSection };
}

// These are references to canonical plain-text entries, not a second editable
// status record. Old plans without these anchors do not acquire invented facts.
export function renderNow(items = []) {
  const entry = id => items.find(item => item.id === id);
  if (!["now-outcome", "now-next", "now-verified"].some(entry)) return "";
  const questions = items.filter(item => item.status === "question");
  const fields = [
    ["Latest outcome", entry("now-outcome"), "No outcome recorded"],
    ["Next action · owner", entry("now-next"), "Not assigned"],
    ["Needs your input", questions[0], "No open questions recorded"],
    ["Last verified", entry("now-verified"), "Not recorded"],
  ];
  return `<aside class="plan-now" aria-label="Now"><div class="now-title">Now</div><div class="now-fields">${fields.map(([label, item, fallback]) => {
    const text = `${item?.text || fallback}${label === "Needs your input" && questions.length > 1 ? ` (+${questions.length - 1} more)` : ""}`;
    return `<div class="now-field"><span>${label}</span>${item ? `<a href="#${encodeURIComponent(item.id)}">${esc(text)}</a>` : `<p>${esc(text)}</p>`}</div>`;
  }).join("")}</div></aside>`;
}
