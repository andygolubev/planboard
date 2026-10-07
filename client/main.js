// The board in the browser. One document, no iframe: the plan HTML comes from the
// server, this script adds selection, notes, diagrams, keyboard, live
// updates, the change-review graphics and the whiteboard overlay.
import mermaid from "mermaid";

import { renderChangesPanel, changeGroups } from "./changes.js";
import { STATUS_ORDER, ago, anchorKeyOf, clock, cssEscape, dayLabel, describeEvent as describeEv, esc, eventKey, fileSize } from "./util.js";
import { createWhiteboardHost } from "./whiteboard.js";
import { createDiagramViewer } from "./diagram-viewer.js";
import { numberedSections } from "./outline.js";
import { setupPanelResize } from "./resize.js";
import { anchorForHash, samePageHash } from "./links.js";
import { acceptanceBadge, createWorkflowHost, WORKFLOW_TABS } from "./workflow.js";

const bootEl = document.getElementById("planboard-state");
let state = JSON.parse(bootEl.textContent);
const KEY = state.key;
const API = `/boards/${KEY}/api`;
const LS = (k) => `pb:${KEY}:${k}`;

const $ = (sel, root = document) => root.querySelector(sel);
const boardEl = $("#board");
const rulerEl = $("#ruler");
const toolbarEl = $("#toolbar");
const collapseBtn = $("#collapseBtn");
const panelEl = $("#panel");
const panelScroll = $("#panelScroll");
const panelContext = $("#panelContext");
const composer = $("#composer");
const composerText = $("#composerText");
const composerHint = $("#composerHint");
const sendBtn = $("#sendBtn");
const addBtn = $("#addBtn");
const attachBtn = $("#attachBtn");
const attachInput = $("#attachInput");
const attachStrip = $("#attachStrip");
const progressEl = $("#progress");
const presenceEl = $("#presence");
const changesChip = $("#changesChip");
const tabsEl = $("#tabs");
const sheetHandle = $("#sheetHandle");
const sheetTitle = $("#sheetTitle");
const sheetBadge = $("#sheetBadge");
const helpOverlay = $("#helpOverlay");

let selection = { type: "board" };
let selectionLabel = "Plan";
let tab = "thread";
let since = state.since || null;
let sinceBasis = state.since_basis || "open";
let connected = false;
let mermaidCounter = 0;
let tempPin = null;
let pendingFiles = [];
const review = { index: -1 };
const beforeMode = new Set();
const expanded = new Set(loadJson("sectionDetails", []));
const taskExpanded = new Set(loadJson("sectionTasks", []));
const workflow = createWorkflowHost({ api, base: API, getState: () => state, getSince: () => since, notify: (message) => toast(message), onRefresh: async () => {
  if (await refreshState()) { paint(); renderTopbar(); renderPanel(); }
} });

function loadJson(key, fallback) {
  try {
    const v = localStorage.getItem(LS(key));
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key, value) {
  try {
    localStorage.setItem(LS(key), JSON.stringify(value));
  } catch {
    // private mode etc.
  }
}

// ---------------------------------------------------------------- helpers

const STATUS_LABEL = state.status_labels || {};
function statusLabel(s) {
  return s ? STATUS_LABEL[s] || s : "none";
}
function describeEvent(ev) {
  return describeEv(ev, statusLabel);
}

function itemById(id) {
  return state.items.find((i) => i.id === id);
}
function sectionById(id) {
  return state.sections.find((s) => s.id === id);
}

function labelFor(anchor) {
  if (!anchor || anchor.type === "board") return "Plan";
  switch (anchor.type) {
    case "item":
    case "text": {
      if (anchor.item) {
        const it = itemById(anchor.item);
        if (!it) return `item ${anchor.item} (no longer in the plan)`;
        const sec = it.section ? sectionById(it.section) : null;
        return `${sec ? sec.title + " › " : ""}${it.text}`;
      }
      if (anchor.section) {
        const sec = sectionById(anchor.section);
        return sec ? sec.title : anchor.section;
      }
      return "Plan";
    }
    case "section": {
      const sec = sectionById(anchor.section);
      return sec ? sec.title : anchor.section;
    }
    case "node":
      return `${anchor.diagram} › ${anchor.label || anchor.node}`;
    case "diagram":
      return `diagram ${anchor.diagram}`;
    case "image":
      return `image ${anchor.src.split("/").pop()}${typeof anchor.x === "number" ? ` @ ${Math.round(anchor.x * 100)}%, ${Math.round(anchor.y * 100)}%` : ""}`;
    default:
      return anchorKeyOf(anchor);
  }
}

async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: raw ? headers : body ? { "content-type": "application/json", ...headers } : headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error((json && json.error) || `${res.status}`);
  return json;
}

let refreshGeneration = 0;
let renderedBoardHTML = null;
async function refreshState() {
  const generation = ++refreshGeneration;
  try {
    const next = await api("GET", "/state");
    if (generation !== refreshGeneration) return false;
    state = next;
    // A workflow/notes refresh can supersede a simultaneous plan refresh.
    // Render the newest plan even when that newer request has a different type.
    if (renderedBoardHTML !== null && renderedBoardHTML !== state.html) renderBoard();
    return true;
  } catch (err) {
    console.warn("state refresh failed", err);
    return false;
  }
}

const isPhone = () => window.matchMedia("(max-width: 900px)").matches;

// ---------------------------------------------------------------- board

function renderBoard() {
  const scroll = boardEl.scrollTop;
  if (state.error) {
    boardEl.innerHTML = `<div class="board-error"><h2>Cannot show the plan</h2><p>${esc(state.error)}</p><p class="muted">${esc(state.path)}</p></div>`;
    return;
  }
  boardEl.innerHTML = `<article class="plan">${state.html}</article>`;
  renderedBoardHTML = state.html;
  boardEl.scrollTop = scroll;
  buildOutline();
  renderDiagrams();
  paint();
}

// Decorations, collapse and the ruler always go together.
function paint() {
  decorateBoard();
  applyCollapse();
  renderRuler();
  renderSheetHandle();
}

// The previous version of a diagram (as it was at the start of the review window).
function beforeSourceOf(diagramId) {
  const evs = (state.events_since || []).filter((e) => e.type === "diagram_changed" && e.diagram === diagramId && typeof e.from === "string");
  return evs.length ? evs[0].from : null;
}

async function renderDiagrams() {
  const dark = document.documentElement.dataset.theme === "dark";
  mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict", fontFamily: "inherit" });
  for (const fig of boardEl.querySelectorAll("figure.diagram")) await renderDiagram(fig);
  paint();
}

async function renderDiagram(fig) {
  const did = fig.dataset.diagram;
  let src = fig.querySelector(".mermaid-src")?.textContent || "";
  const before = beforeMode.has(did) ? beforeSourceOf(did) : null;
  fig.classList.toggle("showing-before", before !== null);
  if (before !== null) src = before;
  const canvas = fig.querySelector(".diagram-canvas");
  if (!canvas) return;
  const id = `pb-${KEY}-${++mermaidCounter}`;
  try {
    const { svg } = await mermaid.render(id, src);
    canvas.innerHTML = svg;
    const svgEl = canvas.querySelector("svg");
    if (svgEl) {
      svgEl.removeAttribute("height");
      svgEl.style.maxWidth = "100%";
    }
  } catch (err) {
    canvas.innerHTML = `<pre class="diagram-error">Mermaid: ${esc(err && err.message ? err.message : err)}\n\n${esc(src)}</pre>`;
    document.getElementById("d" + id)?.remove();
  }
  canvas.removeAttribute("aria-busy");
}

function firstBlockChild(body) {
  return [...body.children].find((c) => /^(UL|OL|P|PRE|BLOCKQUOTE|TABLE|FIGURE|DIV)$/.test(c.tagName) && !c.classList.contains("deco")) || null;
}

function eventsByTarget() {
  const map = new Map();
  for (const ev of state.events_since || []) {
    const k = eventKey(ev);
    if (k === "board") continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(ev);
  }
  return map;
}

function decorateBoard() {
  for (const el of boardEl.querySelectorAll(".deco")) el.remove();
  for (const el of boardEl.querySelectorAll(".selected, .has-notes, .changed, .review-current")) el.classList.remove("selected", "has-notes", "changed", "review-current");

  const threads = state.threads || {};
  const changes = eventsByTarget();
  const selKey = anchorKeyOf(selection);
  const reviewKey = currentReviewKey();

  const badge = (t) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `deco note-badge${t.queued ? " queued" : ""}${t.pending ? " pending" : ""}${t.last_from === "agent" ? " agent-last" : ""}`;
    b.dataset.anchorKey = t.key;
    b.title = `${t.count} note${t.count === 1 ? "" : "s"}${t.pending ? ", waiting for the agent" : ""}${t.queued ? ", some not sent yet" : ""}${t.attachments ? `, ${t.attachments} attachment${t.attachments === 1 ? "" : "s"}` : ""}`;
    b.innerHTML = `${t.count}${t.attachments ? '<span class="clip">📎</span>' : ""}`;
    return b;
  };
  // The change tag draws the move: a dot in the old colour, an arrow, a dot in the new one.
  const changeTag = (evs) => {
    const last = evs[evs.length - 1];
    const s = document.createElement("span");
    s.className = `deco changed-tag ev-${last.type}`;
    s.title = evs.map((e) => `${describeEvent(e)} · ${clock(e.at)}`).join("\n");
    const statusEvs = evs.filter((e) => e.type === "status");
    if (statusEvs.length) {
      const from = statusEvs[0].from;
      const to = statusEvs[statusEvs.length - 1].to;
      s.innerHTML = `<i class="dot-s st-${esc(from || "none")}"></i><span class="arrow">→</span><i class="dot-s st-${esc(to || "none")}"></i> ${esc(statusLabel(to))} · ${esc(ago(last.at))}`;
    } else s.textContent = `${describeEvent(last)} · ${ago(last.at)}`;
    return s;
  };

  for (const li of boardEl.querySelectorAll("li[data-item]")) {
    const id = li.dataset.item;
    const body = li.querySelector(":scope > .item-body");
    if (!body) continue;
    const key = `item:${id}`;
    const task = state.workflow?.tasks?.find((task) => task.id === id);
    if (task?.managed || li.dataset.status === "done") {
      const validation = document.createElement("span");
      validation.className = "deco wf-inline-acceptance";
      validation.innerHTML = acceptanceBadge(task);
      body.insertBefore(validation, firstBlockChild(body));
    }
    const t = threads[key];
    const evs = changes.get(key);
    if (evs) {
      li.classList.add("changed");
      const last = evs.filter((e) => e.type === "status").pop();
      li.dataset.changedTo = last ? last.to : evs[evs.length - 1].type;
      body.insertBefore(changeTag(evs), firstBlockChild(body));
    }
    if (t) {
      li.classList.add("has-notes");
      body.insertBefore(badge(t), firstBlockChild(body));
    }
    if (key === selKey) li.classList.add("selected");
    if (key === reviewKey) li.classList.add("review-current");
  }
  for (const h of boardEl.querySelectorAll("[data-section]")) {
    const key = `section:${h.dataset.section}`;
    const t = threads[key];
    if (t) {
      h.classList.add("has-notes");
      h.appendChild(badge(t));
    }
    if (key === selKey) h.classList.add("selected");
    if (key === reviewKey) h.classList.add("review-current");
  }
  for (const fig of boardEl.querySelectorAll("figure.diagram")) {
    const did = fig.dataset.diagram;
    const key = `diagram:${did}`;
    const t = threads[key];
    const cap = fig.querySelector(".diagram-caption");
    const nodeKeys = Object.keys(threads).filter((k) => k.startsWith(`node:${did}/`));
    if (t || nodeKeys.length) fig.classList.add("has-notes");
    if (t && cap) cap.appendChild(badge(t));
    if (key === selKey) fig.classList.add("selected");
    if (key === reviewKey) fig.classList.add("review-current");
    const evs = changes.get(key);
    if (evs) {
      fig.classList.add("changed");
      if (cap) cap.appendChild(changeTag(evs));
      if (cap && beforeSourceOf(did) !== null) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `deco mini-btn toggle-before${beforeMode.has(did) ? " on" : ""}`;
        b.dataset.diagram = did;
        b.textContent = beforeMode.has(did) ? "Show current" : "Show before";
        cap.appendChild(b);
      }
    }
    if (fig.classList.contains("showing-before")) {
      const r = document.createElement("div");
      r.className = "deco before-ribbon";
      r.innerHTML = `Before your ${sinceBasis === "visit" ? "last visit" : "opening the board"} <button type="button" class="mini-btn toggle-before on" data-diagram="${esc(did)}">show current</button>`;
      fig.insertBefore(r, fig.firstChild);
    }
    for (const g of fig.querySelectorAll("g.node, g.cluster, .actor")) {
      const nid = diagramNodeId(g);
      if (!nid) continue;
      const nk = `node:${did}/${nid}`;
      if (nodeKeys.includes(nk)) g.classList.add("has-notes");
      if (nk === selKey) g.classList.add("selected");
    }
    if (cap) {
      const tools = document.createElement("span");
      tools.className = "deco diagram-tools";
      let html = "";
      if (nodeKeys.length) {
        html += `<span class="node-notes">${nodeKeys
          .map((k) => {
            const t2 = threads[k];
            const nid = k.slice(`node:${did}/`.length);
            return `<button type="button" class="node-chip" data-anchor-key="${esc(k)}" data-node="${esc(nid)}">${esc(t2.anchor.label || nid)} <b>${t2.count}</b></button>`;
          })
          .join(" ")}</span>`;
      }
      if (fig.querySelector(".diagram-canvas svg")) html += `<button type="button" class="mini-btn view-diagram-btn" data-diagram="${esc(did)}" title="View, zoom, copy or download this diagram">View</button>`;
      if (state.features && state.features.whiteboard) html += `<button type="button" class="mini-btn wb-btn" data-diagram="${esc(did)}" title="Redraw this diagram on an Excalidraw whiteboard; the edits come back as a note">✎ Whiteboard</button>`;
      tools.innerHTML = html;
      if (html) cap.appendChild(tools);
    }
  }
  for (const wrap of boardEl.querySelectorAll(".img-wrap")) {
    const src = wrap.dataset.image;
    const pins = wrap.querySelector(".img-pins");
    if (!pins) continue;
    pins.innerHTML = "";
    const notes = (state.notes || []).filter((n) => n.anchor && n.anchor.type === "image" && n.anchor.src === src && typeof n.anchor.x === "number");
    if (notes.length) wrap.classList.add("has-notes");
    notes.forEach((n, i) => {
      const p = document.createElement("button");
      p.type = "button";
      p.className = `pin${n.from === "agent" ? " agent" : ""}${anchorKeyOf(n.anchor) === selKey && selection.x === n.anchor.x && selection.y === n.anchor.y ? " selected" : ""}`;
      p.style.left = `${n.anchor.x * 100}%`;
      p.style.top = `${n.anchor.y * 100}%`;
      p.dataset.noteAnchor = JSON.stringify(n.anchor);
      p.title = n.text.slice(0, 120);
      p.textContent = i + 1;
      pins.appendChild(p);
    });
    if (tempPin && tempPin.src === src) {
      const p = document.createElement("span");
      p.className = "pin temp";
      p.style.left = `${tempPin.x * 100}%`;
      p.style.top = `${tempPin.y * 100}%`;
      p.textContent = "+";
      pins.appendChild(p);
    }
    if (`image:${src}` === selKey && !tempPin) wrap.classList.add("selected");
  }
}

// ---- section outline and progressive disclosure --------------------------------
function buildOutline() {
  const plan = boardEl.querySelector(".plan");
  const nodes = [...plan.children];
  let card = null;
  let content = [];
  function finish() {
    if (!card) return;
    const id = card.dataset.outline;
    const summary = content[0]?.matches("p") ? content.shift() : null;
    if (summary) { summary.classList.add("section-summary"); card.append(summary); }
    const taskLists = content.filter(el => el.matches("ul, ol") && el.querySelector('li.item:not([data-status="none"])'));
    const tasks = content.filter((el, index) => taskLists.includes(el) || (el.matches(".section-head") && taskLists.includes(content[index + 1])));
    const details = content.filter(el => !tasks.includes(el));
    for (const [kind, elements, label] of [["details", details, "Solution details"], ["tasks", tasks, "Tasks"]]) {
      if (!elements.length) continue;
      const group = document.createElement("details");
      group.className = "section-disclosure";
      group.dataset.kind = kind;
      group.dataset.owner = id;
      const heading = document.createElement("summary");
      heading.textContent = label;
      const body = document.createElement("div");
      body.className = "disclosure-body";
      body.append(...elements);
      group.append(heading, body);
      group.open = (kind === "tasks" ? taskExpanded : expanded).has(id);
      group.addEventListener("toggle", () => {
        const ids = kind === "tasks" ? taskExpanded : expanded;
        if (group.open) ids.add(id); else ids.delete(id);
        saveJson(kind === "tasks" ? "sectionTasks" : "sectionDetails", [...ids]);
        updateOutlineControls();
        renderRuler();
      });
      card.append(group);
    }
    const thoughts = document.createElement("button");
    thoughts.type = "button";
    thoughts.className = "section-thoughts";
    thoughts.dataset.thoughts = id;
    card.append(thoughts);
  }
  for (const el of nodes) {
    if (el.matches(".section-head") && Number(el.dataset.level) === 2) {
      finish();
      card = document.createElement("section");
      card.className = "plan-section";
      card.dataset.outline = el.dataset.section;
      el.before(card);
      card.append(el);
      content = [];
    } else if (card) content.push(el);
  }
  finish();
}

function updateOutlineControls() {
  const groups = [...boardEl.querySelectorAll(".section-disclosure")];
  toolbarEl.hidden = !groups.length;
  collapseBtn.textContent = groups.length && groups.every(el => el.open) ? "Collapse all" : "Expand all";
  collapseBtn.dataset.mode = groups.every(el => el.open) ? "collapse" : "expand";
}

function applyCollapse() {
  $("#contentsLinks").innerHTML = numberedSections(state.sections || []).map(section => {
    const id = section.id;
    const thread = state.threads?.[`section:${id}`];
    const counts = section?.counts;
    const active = selection.type === "section" && selection.section === id;
    return `<button type="button" class="contents-link${active ? " active" : ""}" data-jump-section="${esc(id)}" style="--indent:${section.depth}" ${active ? 'aria-current="location"' : ''}><span>${section.number ? `<span class="contents-number">${section.number}</span> ` : ""}${esc(section.displayTitle)}</span><small>${counts?.total ? `${counts.done}/${counts.total}` : ""}${thread ? ` · ${thread.count} thought${thread.count === 1 ? "" : "s"}${thread.last_from === "agent" ? " · reply" : ""}` : ""}</small></button>`;
  }).join("");
  for (const button of boardEl.querySelectorAll("[data-thoughts]")) {
    const thread = state.threads?.[`section:${button.dataset.thoughts}`];
    button.textContent = thread ? `${thread.count} thought${thread.count === 1 ? "" : "s"}${thread.last_from === "agent" ? " · Agent replied" : ""}` : "Discuss this section";
  }
  for (const group of boardEl.querySelectorAll('.section-disclosure[data-kind="tasks"]')) {
    const items = [...group.querySelectorAll('li.item:not([data-status="none"])')];
    group.querySelector("summary").textContent = `Tasks · ${items.filter(el => el.dataset.status === "done").length}/${items.length} done`;
  }
  updateOutlineControls();
}

boardEl.addEventListener("click", ev => {
  const summary = ev.target.closest(".section-disclosure > summary");
  if (!summary) return;
  const group = summary.parentElement;
  if (!group.open && group.dataset.kind === "details") {
    for (const other of boardEl.querySelectorAll('.section-disclosure[data-kind="details"]')) {
      if (other !== group) other.open = false;
    }
  }
});

$("#contentsLinks").addEventListener("click", ev => {
  const button = ev.target.closest("[data-jump-section]");
  if (!button) return;
  select({ type: "section", section: button.dataset.jumpSection }, { focus: false, scrollTo: true });
});

collapseBtn.addEventListener("click", () => {
  const open = collapseBtn.dataset.mode === "expand";
  for (const group of boardEl.querySelectorAll(".section-disclosure")) group.open = open;
  updateOutlineControls();
  renderRuler();
});

// ---- ruler: where the changes and notes are along the whole plan -----------------------

function renderRuler() {
  const total = boardEl.scrollHeight;
  if (!total) return;
  const top0 = boardEl.getBoundingClientRect().top;
  const changes = eventsByTarget();
  const marks = [];
  for (const el of boardEl.querySelectorAll("li.item.changed, figure.diagram.changed, li.item.has-notes, figure.diagram.has-notes, .section-head.has-notes")) {
    if (!el.getClientRects().length) continue;
    const y = el.getBoundingClientRect().top - top0 + boardEl.scrollTop;
    const key = el.dataset.item ? `item:${el.dataset.item}` : el.dataset.diagram ? `diagram:${el.dataset.diagram}` : `section:${el.dataset.section}`;
    const evs = changes.get(key);
    let cls = "tick";
    if (evs) {
      const last = evs[evs.length - 1];
      cls += last.type === "status" ? ` st-${last.to}` : last.type === "added" ? " st-added" : " st-other";
    } else cls += " notes";
    const t = (state.threads || {})[key];
    if (t && (t.pending || t.queued)) cls += " pending";
    if (key === anchorKeyOf(selection)) cls += " sel";
    marks.push(`<i class="${cls}" style="top:${((100 * y) / total).toFixed(2)}%" data-anchor-key="${esc(key)}" title="${esc(labelFor(anchorFromKey(key)))}"></i>`);
  }
  rulerEl.innerHTML = `<i class="viewport"></i>${marks.join("")}`;
  rulerEl.classList.toggle("empty", !marks.length);
  updateRulerViewport();
}
function updateRulerViewport() {
  const vp = rulerEl.querySelector(".viewport");
  if (!vp) return;
  const total = boardEl.scrollHeight || 1;
  vp.style.top = `${(100 * boardEl.scrollTop) / total}%`;
  vp.style.height = `${(100 * boardEl.clientHeight) / total}%`;
}
boardEl.addEventListener("scroll", () => requestAnimationFrame(updateRulerViewport), { passive: true });
window.addEventListener("resize", () => requestAnimationFrame(renderRuler));
setupPanelResize($("#layout"), { load: loadJson, save: saveJson, onResize: () => requestAnimationFrame(renderRuler) });
window.matchMedia("(max-width: 900px)").addEventListener("change", () => {
  renderTopbar();
  if (!isPhone()) openSheet(false);
});
rulerEl.addEventListener("click", (ev) => {
  const t = ev.target.closest(".tick");
  if (t) select(anchorFromKey(t.dataset.anchorKey), { focus: false, scrollTo: true });
});

// Mermaid renders a flowchart node as <g class="node" id="flowchart-A-0">; state
// and class diagrams follow the same <kind>-<id>-<n> pattern. Clusters and
// sequence actors carry their name instead. (After lavish-axi's mermaid-node.js.)
function diagramNodeId(g) {
  if (!g) return null;
  if (g.classList.contains("cluster")) {
    const label = g.querySelector(".cluster-label, .nodeLabel, text")?.textContent?.trim();
    return label ? `cluster:${label}` : g.id || null;
  }
  if (g.classList.contains("actor")) {
    return g.getAttribute("name") || g.textContent?.trim() || null;
  }
  // Mermaid 11 prefixes every node id with the render id we passed (pb-<key>-<n>-).
  const id = (g.id || "").replace(/^pb-[a-f0-9]{12}-\d+-/, "");
  const m = /^[A-Za-z]+-(.+)-\d+$/.exec(id);
  if (m) return m[1];
  return id || null;
}

function diagramNodeLabel(g) {
  const el = g.querySelector(".nodeLabel, .cluster-label, .label, foreignObject span, text");
  if (!el) return "";
  const clone = el.cloneNode(true);
  for (const br of clone.querySelectorAll("br")) br.replaceWith(document.createTextNode(" "));
  return (clone.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
}

function nodeElement(fig, nid) {
  for (const g of fig.querySelectorAll("g.node, g.cluster, .actor")) if (diagramNodeId(g) === nid) return g;
  return null;
}

// ---------------------------------------------------------------- selection

function select(anchor, { focus = true, scrollTo = false } = {}) {
  selection = anchor || { type: "board" };
  selectionLabel = labelFor(selection);
  if (selection.type !== "image") tempPin = null;
  revealAnchor(selection);
  paint();
  renderPanel();
  if (scrollTo) {
    const el = elementForAnchor(selection);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  if (isPhone() && selection.type !== "board") openSheet(true);
  // on a phone the sheet opens on the thread; the keyboard should not pop up until the user taps the box
  if (focus && !isPhone()) composerText.focus({ preventScroll: true });
}

// A selected element inside a folded section unfolds it.
function revealAnchor(a) {
  const el = elementForAnchor(a);
  if (!el) return;
  for (let parent = el.parentElement; parent && parent !== boardEl; parent = parent.parentElement) {
    if (parent.matches("details.section-disclosure")) parent.open = true;
  }
}

function elementForAnchor(a) {
  if (!a) return null;
  switch (a.type) {
    case "item":
    case "text":
      if (a.item) return boardEl.querySelector(`li[data-item="${cssEscape(a.item)}"]`);
      if (a.section) return boardEl.querySelector(`[data-section="${cssEscape(a.section)}"]`);
      return null;
    case "section":
      return boardEl.querySelector(`[data-section="${cssEscape(a.section)}"]`);
    case "node":
    case "diagram":
      return boardEl.querySelector(`figure.diagram[data-diagram="${cssEscape(a.diagram)}"]`);
    case "image":
      return boardEl.querySelector(`.img-wrap[data-image="${cssEscape(a.src)}"]`);
    default:
      return null;
  }
}

function anchorFromKey(key) {
  if (!key || key === "board") return { type: "board" };
  const [type, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  switch (type) {
    case "item":
      return { type: "item", item: rest };
    case "section":
      return { type: "section", section: rest };
    case "diagram":
      return { type: "diagram", diagram: rest };
    case "image":
      return { type: "image", src: rest };
    case "node": {
      const i = rest.indexOf("/");
      const t = (state.threads || {})[key];
      return { type: "node", diagram: rest.slice(0, i), node: rest.slice(i + 1), label: t && t.anchor ? t.anchor.label : undefined };
    }
    default:
      return { type: "board" };
  }
}

boardEl.addEventListener("click", (ev) => {
  const t = ev.target;
  if (!(t instanceof Element)) return;
  if (t.closest(".section-disclosure > summary")) return;
  const thoughts = t.closest("[data-thoughts]");
  if (thoughts) {
    select({ type: "section", section: thoughts.dataset.thoughts });
    setTab("thread");
    return;
  }
  const beforeBtn = t.closest(".toggle-before");
  if (beforeBtn) {
    ev.preventDefault();
    toggleBefore(beforeBtn.dataset.diagram);
    return;
  }
  const viewBtn = t.closest(".view-diagram-btn");
  if (viewBtn) {
    ev.preventDefault();
    openDiagramViewer(viewBtn.dataset.diagram);
    return;
  }
  const wbBtn = t.closest(".wb-btn");
  if (wbBtn) {
    ev.preventDefault();
    openWhiteboard(wbBtn.dataset.diagram);
    return;
  }
  const badgeEl = t.closest(".note-badge, .node-chip");
  if (badgeEl) {
    ev.preventDefault();
    select(anchorFromKey(badgeEl.dataset.anchorKey));
    setTab("thread");
    return;
  }
  const pin = t.closest(".pin[data-note-anchor]");
  if (pin) {
    ev.preventDefault();
    const a = JSON.parse(pin.dataset.noteAnchor);
    tempPin = null;
    select(a);
    return;
  }
  if (t.closest("a[href]")) return; // links keep working
  const fig = t.closest("figure.diagram");
  if (fig) {
    const g = t.closest("g.node, g.cluster, .actor");
    if (g && fig.contains(g)) {
      const nid = diagramNodeId(g);
      if (nid) {
        select({ type: "node", diagram: fig.dataset.diagram, node: nid, label: diagramNodeLabel(g) || nid });
        return;
      }
    }
    select({ type: "diagram", diagram: fig.dataset.diagram });
    return;
  }
  const img = t.closest(".img-wrap");
  if (img) {
    const rect = img.querySelector("img")?.getBoundingClientRect();
    if (rect && rect.width && rect.height) {
      const x = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
      tempPin = { src: img.dataset.image, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
      select({ type: "image", src: img.dataset.image, x: tempPin.x, y: tempPin.y });
      return;
    }
  }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && boardEl.contains(sel.anchorNode)) return; // handled on mouseup
  const li = t.closest("li[data-item]");
  if (li) {
    select({ type: "item", item: li.dataset.item });
    return;
  }
  const head = t.closest("[data-section]");
  if (head) {
    select({ type: "section", section: head.dataset.section });
    return;
  }
  const block = t.closest(".block[data-section-of], .block");
  if (block) {
    const section = block.dataset.sectionOf || null;
    const quote = (block.innerText || "").trim().replace(/\s+/g, " ").slice(0, 240);
    select({ type: "text", section, quote });
    return;
  }
  select({ type: "board" });
});

boardEl.addEventListener("mouseup", () => {
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim().replace(/\s+/g, " ");
    if (!text || !boardEl.contains(sel.anchorNode)) return;
    const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    const li = node && node.closest("li[data-item]");
    const block = node && node.closest("[data-section-of]");
    const head = node && node.closest("[data-section]");
    const anchor = { type: "text", quote: text.slice(0, 1000) };
    if (li) anchor.item = li.dataset.item;
    else if (block) anchor.section = block.dataset.sectionOf;
    else if (head) anchor.section = head.dataset.section;
    select(anchor, { focus: false });
  }, 0);
});

// Hover a node chip → the node lights up; hover a node → its chip lights up.
boardEl.addEventListener("mouseover", (ev) => {
  const t = ev.target;
  if (!(t instanceof Element)) return;
  const chip = t.closest(".node-chip");
  if (chip) {
    const fig = chip.closest("figure.diagram");
    const g = fig && nodeElement(fig, chip.dataset.node);
    if (g) g.classList.add("hover");
    chip.classList.add("hover");
    return;
  }
  const g = t.closest("g.node, g.cluster, .actor");
  if (g) {
    const fig = g.closest("figure.diagram");
    const nid = diagramNodeId(g);
    const c = fig && nid ? fig.querySelector(`.node-chip[data-node="${cssEscape(nid)}"]`) : null;
    if (c) c.classList.add("hover");
    g.classList.add("hover");
  }
});
boardEl.addEventListener("mouseout", (ev) => {
  const t = ev.target;
  if (!(t instanceof Element)) return;
  const chip = t.closest(".node-chip");
  const g = chip ? null : t.closest("g.node, g.cluster, .actor");
  if (!chip && !g) return;
  const fig = (chip || g).closest("figure.diagram");
  if (!fig) return;
  for (const el of fig.querySelectorAll(".hover")) el.classList.remove("hover");
});

function toggleBefore(did) {
  if (beforeMode.has(did)) beforeMode.delete(did);
  else beforeMode.add(did);
  const fig = boardEl.querySelector(`figure.diagram[data-diagram="${cssEscape(did)}"]`);
  if (fig) renderDiagram(fig).then(() => paint());
  else paint();
  renderPanel();
}

// ---------------------------------------------------------------- keyboard

function visibleItems() {
  return [...boardEl.querySelectorAll('li.item:not([data-status="none"])')].filter((el) => el.getClientRects().length);
}

function moveItem(delta) {
  const items = visibleItems();
  if (!items.length) return;
  const curId = selection.type === "item" || (selection.type === "text" && selection.item) ? selection.item : null;
  const cur = curId ? items.findIndex((el) => el.dataset.item === curId) : -1;
  let next = cur < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, cur + delta));
  const el = items[next];
  select({ type: "item", item: el.dataset.item }, { focus: false });
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function isTyping(el) {
  return el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable);
}

document.addEventListener("keydown", (ev) => {
  if (document.body.classList.contains("diagram-viewer-open")) return;
  if (isTyping(ev.target)) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (document.body.classList.contains("wb-open")) {
    if (ev.key === "Escape") wb.close();
    return;
  }
  switch (ev.key) {
    case "j":
      ev.preventDefault();
      moveItem(1);
      break;
    case "k":
      ev.preventDefault();
      moveItem(-1);
      break;
    case "Enter": {
      if (ev.target.closest?.("button, a, summary, [role=tab]")) return;
      if (selection.type === "board") return;
      ev.preventDefault();
      setTab("thread");
      if (isPhone()) openSheet(true);
      composerText.focus({ preventScroll: true });
      break;
    }
    case "Escape":
      if (!helpOverlay.hidden) helpOverlay.hidden = true;
      else if (document.body.classList.contains("sheet-open")) openSheet(false);
      else select({ type: "board" }, { focus: false });
      break;
    case "n":
      ev.preventDefault();
      reviewStep(1);
      break;
    case "p":
      ev.preventDefault();
      reviewStep(-1);
      break;
    case "1":
      setTab("thread");
      break;
    case "2":
      setTab("activity");
      break;
    case "3":
      setTab("changes");
      break;
    case "4":
      setTab("requirements");
      break;
    case "5":
      setTab("execution");
      break;
    case "6":
      setTab("validation");
      break;
    case "7":
      setTab("resume");
      break;
    case "?":
      helpOverlay.hidden = !helpOverlay.hidden;
      break;
    default:
      break;
  }
});
$("#helpBtn").addEventListener("click", () => (helpOverlay.hidden = !helpOverlay.hidden));
$("#helpClose").addEventListener("click", () => (helpOverlay.hidden = true));
helpOverlay.addEventListener("click", (ev) => {
  if (ev.target === helpOverlay) helpOverlay.hidden = true;
});

// ---------------------------------------------------------------- review walk-through

function currentReviewKey() {
  if (review.index < 0) return null;
  const groups = changeGroups(state, state.events_since || []);
  return groups[review.index] ? groups[review.index].key : null;
}

function reviewStep(delta) {
  const groups = changeGroups(state, state.events_since || []);
  if (!groups.length) {
    toast(`Nothing changed ${sinceBasis === "visit" && since ? "since your last visit" : "since you opened the board"}`);
    return;
  }
  review.index = review.index < 0 ? (delta > 0 ? 0 : groups.length - 1) : (review.index + delta + groups.length) % groups.length;
  const g = groups[review.index];
  tab = "changes";
  updateTabs();
  select(anchorFromKey(g.key), { focus: false, scrollTo: true });
  const row = panelScroll.querySelector(`.change-row[data-change-index="${review.index}"]`);
  if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ---------------------------------------------------------------- panel

function setTab(name) {
  if (!tabsEl.querySelector(`[data-tab="${name}"]`)) return;
  tab = name;
  updateTabs();
  if (isPhone()) openSheet(true);
  renderPanel();
}
function updateTabs() {
  tabsEl.setAttribute("role", "tablist");
  tabsEl.setAttribute("aria-label", "Board views");
  panelScroll.setAttribute("role", "tabpanel");
  panelScroll.tabIndex = 0;
  panelScroll.setAttribute("aria-labelledby", `tab-${tab}`);
  for (const b of tabsEl.querySelectorAll(".tab")) {
    const active = b.dataset.tab === tab;
    b.classList.toggle("active", active);
    b.id = `tab-${b.dataset.tab}`;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", "panelScroll");
    b.setAttribute("aria-selected", String(active));
    b.tabIndex = active ? 0 : -1;
    if (active) b.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
tabsEl.addEventListener("click", (ev) => {
  const b = ev.target.closest(".tab");
  if (b) setTab(b.dataset.tab);
});
tabsEl.addEventListener("keydown", (ev) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key)) return;
  ev.preventDefault();
  const buttons = [...tabsEl.querySelectorAll(".tab")];
  const index = buttons.findIndex((b) => b.dataset.tab === tab);
  const next = ev.key === "Home" ? 0 : ev.key === "End" ? buttons.length - 1 : (index + (ev.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
  setTab(buttons[next].dataset.tab);
  buttons[next].focus();
});

function renderContext() {
  const a = selection;
  const parts = [];
  const isBoard = !a || a.type === "board";
  parts.push(`<div class="ctx-row"><span class="ctx-kind">${esc(kindLabel(a))}</span>${isBoard ? "" : `<button type="button" class="ctx-clear" id="ctxClear" title="Back to the plan (Esc)">×</button>`}</div>`);
  if (!isBoard) parts.push(`<div class="ctx-label" title="${esc(selectionLabel)}">${esc(selectionLabel)}</div>`);
  if (a.type === "item" || (a.type === "text" && a.item)) {
    const it = itemById(a.item);
    if (it) {
      const opts = Object.keys(STATUS_LABEL)
        .map((s) => `<option value="${s}"${it.status === s ? " selected" : ""}>${esc(STATUS_LABEL[s])}</option>`)
        .join("");
      const evs = (state.events_since || []).filter((e) => e.item === it.id && e.type === "status");
      const moved = evs.length ? `<span class="ctx-moved" title="${esc(evs.map((e) => `${describeEvent(e)} · ${clock(e.at)}`).join("\n"))}"><i class="dot-s st-${esc(evs[0].from || "none")}"></i>→<i class="dot-s st-${esc(evs[evs.length - 1].to || "none")}"></i> ${esc(ago(evs[evs.length - 1].at))}</span>` : "";
      parts.push(
        `<div class="ctx-meta"><span class="status-pill status-${it.status || "none"}">${esc(statusLabel(it.status))}</span>` +
          (it.status ? `<label class="ctx-set">set <select id="ctxStatus">${opts}</select></label>` : "") +
          moved +
          `<span class="muted">line ${it.line}</span></div>`,
      );
    }
  }
  if (a.type === "diagram" || a.type === "node") {
    parts.push(`<div class="ctx-meta"><button type="button" class="mini-btn view-diagram-btn" data-diagram="${esc(a.diagram)}" title="View, zoom, copy or download this diagram">View diagram</button>${state.features?.whiteboard ? `<button type="button" class="mini-btn wb-btn" data-diagram="${esc(a.diagram)}">✎ Open whiteboard</button>` : ""}</div>`);
  }
  if (a.type === "text" && a.quote) parts.push(`<blockquote class="ctx-quote">${esc(a.quote)}</blockquote>`);
  panelContext.innerHTML = parts.join("");
  $("#ctxClear")?.addEventListener("click", () => select({ type: "board" }));
  $("#ctxStatus")?.addEventListener("change", async (ev) => {
    try {
      await api("POST", "/status", { item: a.item, status: ev.target.value });
    } catch (err) {
      alert(`Could not change status: ${err.message}`);
    }
  });
  panelContext.querySelector(".wb-btn")?.addEventListener("click", (ev) => openWhiteboard(ev.currentTarget.dataset.diagram));
  panelContext.querySelector(".view-diagram-btn")?.addEventListener("click", (ev) => openDiagramViewer(ev.currentTarget.dataset.diagram));
  composerText.placeholder = isBoard ? "Note on the plan… (Enter adds, ⌘/Ctrl+Enter adds and sends)" : `Note on: ${selectionLabel}`;
}

function kindLabel(a) {
  switch (a.type) {
    case "item":
      return "Item";
    case "section":
      return "Section";
    case "node":
      return "Diagram node";
    case "diagram":
      return "Diagram";
    case "image":
      return "Image";
    case "text":
      return "Selected text";
    default:
      return "Plan";
  }
}

function attachmentHtml(n) {
  if (!n.attachments || !n.attachments.length) return "";
  const base = state.attachment_base || `/boards/${KEY}/attachment/`;
  return `<div class="bubble-files">${n.attachments
    .map((f) => {
      const url = base + encodeURIComponent(f);
      if (/\.(png|jpe?g|gif|webp)$/i.test(f)) return `<a class="file-img" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(f)} - open full size"><img src="${esc(url)}" alt="${esc(f)}" loading="lazy"></a>`;
      return `<a class="file-chip" href="${esc(url)}" target="_blank" rel="noopener" download>${esc(f)}</a>`;
    })
    .join("")}</div>`;
}

function noteBubble(n, { showAnchor = false } = {}) {
  const mine = n.from === "user";
  const stateTag =
    mine && n.state === "queued"
      ? `<button type="button" class="bubble-remove" data-remove="${esc(n.id)}" title="Remove this note">×</button><span class="bubble-state">not sent</span>`
      : mine && n.state === "sent"
        ? `<span class="bubble-state pending">waiting for agent</span>`
        : "";
  const depthTag = mine && n.depth && n.depth !== "normal" ? `<span class="depth-tag ${esc(n.depth)}" title="You asked for a ${esc(n.depth)} answer">${esc(n.depth)}</span>` : "";
  const kindTag = n.kind === "sketch" ? `<span class="kind-tag" title="Drawn on the whiteboard">✎ sketch</span>` : "";
  const anchorChip = showAnchor && anchorKeyOf(n.anchor) !== "board" ? `<button type="button" class="anchor-chip" data-anchor='${esc(JSON.stringify(n.anchor))}'>${esc(n.label || labelFor(n.anchor))}</button>` : "";
  const body = n.text ? `<div class="bubble-text md">${n.html || esc(n.text).replace(/\n/g, "<br>")}</div>` : "";
  const quoteText = mine ? n.quote || (n.anchor && n.anchor.type === "text" ? n.anchor.quote : "") : "";
  const quote = quoteText ? `<blockquote class="bubble-quote">${esc(quoteText)}</blockquote>` : "";
  return `<div class="bubble ${mine ? "mine" : "agent"} state-${esc(n.state)}${n.kind === "sketch" ? " sketch" : ""}" data-note="${esc(n.id)}">
    <div class="bubble-head">${anchorChip}<span class="bubble-who">${mine ? "you" : "agent"}</span>${depthTag}${kindTag}<time datetime="${esc(n.at)}" title="${esc(n.at)}">${clock(n.at)}</time>${stateTag}</div>
    ${quote}${body}${attachmentHtml(n)}
  </div>`;
}

function renderThread() {
  const key = anchorKeyOf(selection);
  const notes = (state.notes || []).filter((n) => anchorKeyOf(n.anchor) === key);
  if (!notes.length) {
    panelScroll.innerHTML = `<div class="empty">${key === "board" ? "No notes on the plan yet. Click an item, heading, diagram node or image on the board to talk about it, or write here to discuss the plan." : "Nothing said about this yet. Write the first note below."}</div>`;
    return;
  }
  panelScroll.innerHTML = notes.map((n) => noteBubble(n)).join("");
  panelScroll.scrollTop = panelScroll.scrollHeight;
}

function renderActivity(target = panelScroll) {
  const entries = [];
  for (const n of state.notes || []) entries.push({ at: n.at, kind: "note", n });
  for (const ev of state.recent_events || []) entries.push({ at: ev.at, kind: "event", ev });
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (!entries.length) {
    target.innerHTML = `<div class="empty">No discussion activity yet.</div>`;
    return;
  }
  let day = "";
  const html = [];
  for (const e of entries) {
    const d = new Date(e.at).toDateString();
    if (d !== day) {
      day = d;
      html.push(`<div class="day-sep"><span>${esc(dayLabel(e.at))}</span></div>`);
    }
    if (e.kind === "note") {
      html.push(noteBubble(e.n, { showAnchor: true }));
      continue;
    }
    const ev = e.ev;
    const key = eventKey(ev);
    const label = ev.item ? (itemById(ev.item) || {}).text || ev.text || ev.item : ev.section ? (sectionById(ev.section) || {}).title || ev.text || ev.section : ev.diagram || "";
    const dot = ev.type === "status" ? `st-${ev.to}` : ev.type === "added" ? "st-added" : ev.type === "removed" ? "st-removed" : ev.type.startsWith("diagram") ? "st-diagram" : "st-other";
    html.push(`<div class="event ev-${esc(ev.type)}"><i class="ev-dot ${esc(dot)}"></i><time title="${esc(ev.at)}">${clock(ev.at)}</time><button type="button" class="anchor-chip" data-anchor-key="${esc(key)}">${esc(label)}</button><span class="event-text">${esc(describeEvent(ev))}</span></div>`);
  }
  target.innerHTML = `<h3>Discussion & plan activity</h3><div class="activity">${html.join("")}</div>`;
}

function renderChanges(target = panelScroll) {
  target.innerHTML = renderChangesPanel({ state, events: state.events_since || [], since, sinceBasis, statusLabel, review, beforeMode });
}

function renderPanel() {
  renderContext();
  updateTabs();
  composer.hidden = WORKFLOW_TABS.includes(tab);
  if (tab === "thread") { workflow.detach(); renderThread(); }
  else if (!state.workflow?.enabled && ["activity", "changes"].includes(tab)) {
    workflow.detach();
    if (tab === "activity") { renderActivity(); panelScroll.scrollTop = panelScroll.scrollHeight; }
    else renderChanges();
  }
  else {
    let host = panelScroll.querySelector(`[data-workflow-view="${tab}"]`);
    if (!host) {
      panelScroll.innerHTML = `<div data-workflow-view="${tab}"></div>${["activity", "changes"].includes(tab) ? '<div class="wf-legacy"></div>' : ""}`;
      host = panelScroll.querySelector("[data-workflow-view]");
      panelScroll.scrollTop = 0;
    }
    const legacy = panelScroll.querySelector(".wf-legacy");
    if (tab === "activity") renderActivity(legacy);
    if (tab === "changes") renderChanges(legacy);
    workflow.mount(host, tab);
  }
  const queued = (state.notes || []).filter((n) => n.state === "queued").length;
  sendBtn.disabled = queued === 0;
  sendBtn.textContent = queued ? `Send ${queued}` : "Send";
  composerHint.textContent = queued ? `${queued} note${queued === 1 ? "" : "s"} not sent yet` : "";
  renderSheetHandle();
}

panelScroll.addEventListener("click", async (ev) => {
  const t = ev.target;
  if (!(t instanceof Element)) return;
  const rm = t.closest("[data-remove]");
  if (rm) {
    try {
      await api("DELETE", `/notes/${encodeURIComponent(rm.dataset.remove)}`);
      await refreshState();
      renderPanel();
      paint();
    } catch (err) {
      alert(`Could not remove: ${err.message}`);
    }
    return;
  }
  const rev = t.closest("[data-review]");
  if (rev) {
    reviewStep(rev.dataset.review === "next" ? 1 : -1);
    return;
  }
  const beforeBtn = t.closest(".toggle-before");
  if (beforeBtn) {
    toggleBefore(beforeBtn.dataset.diagram);
    return;
  }
  const row = t.closest(".change-row");
  if (row && !t.closest("a")) {
    review.index = Number(row.dataset.changeIndex);
    select(anchorFromKey(row.dataset.anchorKey), { focus: false, scrollTo: true });
    return;
  }
  const delta = t.closest(".sec-delta");
  if (delta) {
    select(anchorFromKey(delta.dataset.anchorKey), { focus: false, scrollTo: true });
    return;
  }
  const chip = t.closest(".anchor-chip");
  if (chip) {
    const anchor = chip.dataset.anchor ? JSON.parse(chip.dataset.anchor) : anchorFromKey(chip.dataset.anchorKey);
    select(anchor, { focus: false, scrollTo: true });
    if (tab === "activity") setTab("thread");
  }
});

// ---------------------------------------------------------------- composer

function renderAttachStrip() {
  attachStrip.hidden = !pendingFiles.length;
  attachStrip.innerHTML = pendingFiles
    .map(
      (f) =>
        `<span class="attach-thumb" title="${esc(f.file)} · ${esc(fileSize(f.bytes))}"><img src="${esc(f.url)}" alt=""><button type="button" class="attach-remove" data-file="${esc(f.file)}" title="Remove">×</button></span>`,
    )
    .join("");
}
attachStrip.addEventListener("click", async (ev) => {
  const b = ev.target.closest(".attach-remove");
  if (!b) return;
  pendingFiles = pendingFiles.filter((f) => f.file !== b.dataset.file);
  renderAttachStrip();
  api("DELETE", `/attachments/${encodeURIComponent(b.dataset.file)}`).catch(() => {});
});

async function uploadFiles(files) {
  const accepted = state.attachment_types || ["image/png", "image/jpeg", "image/gif", "image/webp"];
  for (const file of files) {
    if (!accepted.includes(file.type)) {
      toast(`Not an image: ${file.name || file.type || "file"}`);
      continue;
    }
    if (file.size > 12 * 1024 * 1024) {
      toast(`Too large (max 12 MB): ${file.name || "image"}`);
      continue;
    }
    try {
      const r = await api("POST", "/attachments", file, { raw: true, headers: { "content-type": file.type } });
      pendingFiles.push(r.attachment);
      renderAttachStrip();
    } catch (err) {
      toast(`Upload failed: ${err.message}`);
    }
  }
}
attachBtn.addEventListener("click", () => attachInput.click());
attachInput.addEventListener("change", async () => {
  await uploadFiles([...attachInput.files]);
  attachInput.value = "";
  composerText.focus();
});
composerText.addEventListener("paste", (ev) => {
  const files = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  ev.preventDefault();
  uploadFiles(files);
});
for (const type of ["dragenter", "dragover"]) {
  composer.addEventListener(type, (ev) => {
    if ([...(ev.dataTransfer?.types || [])].includes("Files")) {
      ev.preventDefault();
      composer.classList.add("dragging");
    }
  });
}
composer.addEventListener("dragleave", () => composer.classList.remove("dragging"));
composer.addEventListener("drop", (ev) => {
  composer.classList.remove("dragging");
  const files = [...(ev.dataTransfer?.files || [])];
  if (!files.length) return;
  ev.preventDefault();
  uploadFiles(files);
});

async function addNote({ send = false } = {}) {
  const text = composerText.value.trim();
  if (!text && !pendingFiles.length) {
    if (send) await sendQueued();
    return;
  }
  addBtn.disabled = true;
  try {
    const quote = selection.type === "text" ? selection.quote : undefined;
    await api("POST", "/notes", { anchor: selection, text, quote, attachments: pendingFiles.map((f) => f.file) });
    composerText.value = "";
    tempPin = null;
    pendingFiles = [];
    renderAttachStrip();
    await refreshState();
    renderPanel();
    paint();
    if (send) await sendQueued();
  } catch (err) {
    alert(`Could not add the note: ${err.message}`);
  } finally {
    addBtn.disabled = false;
    composerText.focus();
  }
}

async function sendQueued() {
  try {
    await api("POST", "/send", {});
    await refreshState();
    renderPanel();
    paint();
  } catch (err) {
    alert(`Could not send: ${err.message}`);
  }
}

composer.addEventListener("submit", (ev) => {
  ev.preventDefault();
  addNote();
});
sendBtn.addEventListener("click", () => sendQueued());
composerText.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    addNote({ send: ev.metaKey || ev.ctrlKey });
  } else if (ev.key === "Escape") {
    composerText.blur();
  }
});

// ---------------------------------------------------------------- top bar

function renderTopbar() {
  $("#boardTitle").textContent = state.title;
  document.title = `${state.title} · planboard`;
  const c = state.counts;
  if (c && c.total) {
    const parts = [`${c.done}/${c.total} done`];
    if (c.in_progress) parts.push(`${c.in_progress} in progress`);
    if (c.blocked) parts.push(`${c.blocked} blocked`);
    if (c.question) parts.push(`${c.question} to decide`);
    const segs = STATUS_ORDER.filter((s) => c[s])
      .map((s) => `<i class="seg seg-${s}" style="width:${(100 * c[s]) / c.total}%" title="${c[s]} ${esc(statusLabel(s))}"></i>`)
      .join("");
    progressEl.innerHTML = `<span class="bar stacked" title="${esc(parts.join(" · "))}">${segs}</span><span class="progress-text">${esc(parts.join(" · "))}</span>`;
  } else progressEl.innerHTML = `<span class="muted">no tracked items yet</span>`;
  const n = (state.events_since || []).length;
  if (n) {
    changesChip.hidden = false;
    const long = sinceBasis === "visit" && since ? `${n} change${n === 1 ? "" : "s"} since your last visit (${ago(since)})` : `${n} change${n === 1 ? "" : "s"} since you opened the board`;
    changesChip.textContent = `${n} change${n === 1 ? "" : "s"}`;
    changesChip.title = long;
  } else changesChip.hidden = true;
  renderPresence();
}
changesChip.addEventListener("click", () => {
  setTab("changes");
  if (isPhone()) openSheet(true);
});

function renderPresence() {
  const p = state.presence || "waiting";
  const owner = state.poll_owner && p !== "waiting" ? ` · ${state.poll_owner}` : "";
  const text = !connected ? "disconnected – reconnecting…" : p === "listening" ? `agent is listening${owner}` : p === "working" ? `agent is working on your notes…${owner}` : "no agent listening";
  presenceEl.innerHTML = `<span class="dot ${connected ? p : "offline"}"></span><span class="presence-text">${esc(text)}</span>`;
  presenceEl.title = state.poll_owner ? `listener: ${state.poll_owner}` : "no planboard poll is attached - the agent is not waiting for notes";
}

// ---------------------------------------------------------------- phone: bottom sheet

function openSheet(open) {
  document.body.classList.toggle("sheet-open", open);
  sheetHandle.setAttribute("aria-expanded", String(open));
}
sheetHandle.addEventListener("click", () => openSheet(!document.body.classList.contains("sheet-open")));
function renderSheetHandle() {
  sheetTitle.textContent = WORKFLOW_TABS.includes(tab) ? `${tab[0].toUpperCase()}${tab.slice(1)}` : selectionLabel;
  const queued = (state.notes || []).filter((n) => n.state === "queued").length;
  const pending = (state.notes || []).filter((n) => n.state === "sent").length;
  const n = queued || pending;
  sheetBadge.hidden = !n;
  sheetBadge.textContent = n ? `${n}` : "";
  sheetBadge.className = `sheet-badge${queued ? " queued" : pending ? " pending" : ""}`;
}

// ---------------------------------------------------------------- diagram viewer / whiteboard

const diagramViewer = createDiagramViewer();
function openDiagramViewer(diagramId) {
  const fig = boardEl.querySelector(`figure.diagram[data-diagram="${cssEscape(diagramId)}"]`);
  const svg = fig?.querySelector(".diagram-canvas svg");
  if (!svg) return toast("The diagram is not ready to view. Check its rendering in the plan.");
  try {
    diagramViewer.open({ svg, diagramId, before: fig.classList.contains("showing-before") });
  } catch (error) {
    toast(error.message);
  }
}

const wb = createWhiteboardHost({
  overlay: $("#wbOverlay"),
  frame: $("#wbFrame"),
  titleEl: $("#wbTitle"),
  errorEl: $("#wbError"),
  closeBtn: $("#wbClose"),
  api,
  onQueued: async (note, diagramId) => {
    await refreshState();
    select({ type: "diagram", diagram: diagramId }, { focus: false });
    setTab("thread");
    toast("Sketch added to the diagram's thread - press Send when you are ready", { type: "diagram", diagram: diagramId });
    void note;
  },
});

function openWhiteboard(diagramId) {
  const fig = boardEl.querySelector(`figure.diagram[data-diagram="${cssEscape(diagramId)}"]`);
  const source = fig?.querySelector(".mermaid-src")?.textContent || "";
  const d = (state.diagrams || []).find((x) => x.id === diagramId);
  wb.open({ diagramId, source, sourceHash: d ? d.hash : "" });
}

// ---------------------------------------------------------------- live channel

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/boards/${KEY}/events`);
  let retry = connect.retry || 0;
  ws.addEventListener("open", async () => {
    connected = true;
    connect.retry = 0;
    if (retry > 0) {
      await refreshState();
      renderBoard();
      renderTopbar();
      renderPanel();
    } else renderPresence();
  });
  ws.addEventListener("message", async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "plan") {
      const ok = await refreshState();
      if (!ok) return;
      selectionLabel = labelFor(selection);
      renderBoard();
      renderTopbar();
      renderPanel();
      flash(msg.events || []);
      for (const ev2 of msg.events || []) {
        if (ev2.type === "diagram_changed" && typeof ev2.to === "string") {
          const d = (state.diagrams || []).find((x) => x.id === ev2.diagram);
          wb.sourceChanged(ev2.diagram, ev2.to, d ? d.hash : "");
        }
      }
    } else if (msg.type === "workflow") {
      if (!(await refreshState())) return;
      paint();
      renderTopbar();
      renderPanel();
    } else if (msg.type === "notes") {
      const ok = await refreshState();
      if (!ok) return;
      renderTopbar();
      renderPanel();
      paint();
      if (msg.reason === "reply") {
        for (const id of msg.ids || []) {
          const note = (state.notes || []).find((n) => n.id === id);
          if (note && anchorKeyOf(note.anchor) !== anchorKeyOf(selection)) toast(`Agent replied on: ${note.label || labelFor(note.anchor)}`, note.anchor);
        }
      }
    } else if (msg.type === "presence" || msg.type === "hello") {
      state.presence = msg.presence;
      state.poll_owner = msg.owner || null;
      renderPresence();
    }
  });
  ws.addEventListener("close", () => {
    connected = false;
    renderPresence();
    connect.retry = Math.min((connect.retry || 0) + 1, 8);
    setTimeout(connect, Math.min(1000 * 2 ** (connect.retry - 1), 10000));
  });
  ws.addEventListener("error", () => ws.close());
}

function flash(events) {
  for (const ev of events) {
    const el = ev.item ? boardEl.querySelector(`li[data-item="${cssEscape(ev.item)}"]`) : ev.section ? boardEl.querySelector(`[data-section="${cssEscape(ev.section)}"]`) : ev.diagram ? boardEl.querySelector(`figure.diagram[data-diagram="${cssEscape(ev.diagram)}"]`) : null;
    if (!el) continue;
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1800);
  }
}

let toastTimer = null;
function toast(text, anchor) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("button");
    el.id = "toast";
    el.type = "button";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.hidden = false;
  el.onclick = () => {
    el.hidden = true;
    if (anchor) {
      select(anchor, { focus: false, scrollTo: true });
      setTab("thread");
    }
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

// ---------------------------------------------------------------- visits

async function touchVisit() {
  try {
    const v = await api("POST", "/seen", {});
    const basis = v.since ? "visit" : "open";
    const next = v.since || v.visit_started;
    if (next !== since || basis !== sinceBasis) {
      since = next;
      sinceBasis = basis;
      await refreshState();
      renderTopbar();
      paint();
      if (tab === "changes") renderPanel();
    }
  } catch {
    // offline; ignore
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") touchVisit();
});
setInterval(() => {
  if (document.visibilityState === "visible") touchVisit();
}, 60000);

// ---------------------------------------------------------------- boot

function followHash() {
  const anchor = anchorForHash(location.hash, state);
  if (!anchor) return;
  select(anchor, { focus: false, scrollTo: true });
}
document.addEventListener("click", event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
  const hash = samePageHash(link.getAttribute("href"), location.href);
  if (!hash || !anchorForHash(hash, state)) return;
  event.preventDefault();
  event.stopPropagation();
  if (location.hash !== hash) history.pushState(null, "", hash);
  followHash();
}, true);
window.addEventListener("hashchange", followHash);
window.addEventListener("popstate", followHash);

window.addEventListener("planboard:themechange", () => renderDiagrams());

renderBoard();
renderTopbar();
renderPanel();
followHash();
connect();
touchVisit();
