// The Changes tab: how the plan moved since the last visit, drawn rather than
// listed. A before/now flow (two stacked status bars with bands between them),
// a timeline of when things moved, per-section progress deltas, and one row per
// changed element with status pills, word diffs and a before/after switch for
// diagrams. Everything here returns HTML strings; main.js wires the clicks.

import { STATUS_ORDER, ago, clock, dayLabel, esc, eventKey, renderWordDiff } from "./util.js";

const HATCH_ID = "pb-hatch";

// One row per item that exists now or existed at `since`: its status then and
// now. `before === null` means the item was added since; `now === null` means
// it was removed since. Derived from the event log after `since`, so it needs
// nothing from the agent.
export function statusRows(state, events) {
  const rows = new Map();
  for (const it of state.items || []) {
    if (!it.status) continue;
    rows.set(it.id, { id: it.id, text: it.text, section: it.section, before: it.status, now: it.status, changed: false });
  }
  const seenFirst = new Set();
  for (const ev of events) {
    if (!ev.item) continue;
    if (ev.type === "status" || ev.type === "added" || ev.type === "removed") {
      let row = rows.get(ev.item);
      if (!row) {
        row = { id: ev.item, text: ev.text || ev.item, section: ev.section || null, before: ev.type === "added" ? null : ev.status || ev.from || null, now: null, changed: true };
        rows.set(ev.item, row);
      }
      if (!seenFirst.has(ev.item)) {
        seenFirst.add(ev.item);
        row.before = ev.type === "added" ? null : ev.type === "status" ? ev.from || null : ev.status || null;
      }
      if (ev.type === "removed") row.now = null;
      row.changed = row.before !== row.now;
    }
  }
  // added and removed again within the window: nothing to show
  return [...rows.values()].filter((r) => !(r.before === null && r.now === null));
}

function segCounts(rows, pick) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  let none = 0;
  for (const r of rows) {
    const v = pick(r);
    if (v === null) none++;
    else if (counts[v] !== undefined) counts[v]++;
  }
  return { counts, none };
}

// Two stacked bars (then / now) sharing one scale, with a band per (then → now)
// pair between them: a small Sankey that shows at a glance how many items moved
// where. Unchanged items are drawn faint so the movement stands out.
export function renderFlow(rows, { statusLabel, sinceText }) {
  const total = rows.length;
  if (!total) return "";
  const W = 360;
  const X0 = 6;
  const BW = W - 12;
  const H1 = 14;
  const Y1 = 24;
  const Y2 = 90;
  const unit = BW / total;
  const order = (s) => (s === null ? STATUS_ORDER.length : STATUS_ORDER.indexOf(s));

  // Slots: each row gets an x-slot on both bars.
  const byBefore = [...rows].sort((a, b) => order(a.before) - order(b.before) || order(a.now) - order(b.now) || a.id.localeCompare(b.id));
  const byNow = [...rows].sort((a, b) => order(a.now) - order(b.now) || order(a.before) - order(b.before) || a.id.localeCompare(b.id));
  const slotB = new Map(byBefore.map((r, i) => [r.id, i]));
  const slotN = new Map(byNow.map((r, i) => [r.id, i]));

  const segs = (sorted, pick, y) => {
    const out = [];
    let start = 0;
    for (let i = 1; i <= sorted.length; i++) {
      if (i === sorted.length || pick(sorted[i]) !== pick(sorted[start])) {
        const s = pick(sorted[start]);
        const n = i - start;
        const x = X0 + start * unit;
        const w = n * unit;
        const cls = s === null ? "seg-none" : `seg-${s}`;
        const title = s === null ? `${n} not in the plan ${y === Y1 ? "yet" : "any more"}` : `${n} ${statusLabel(s)}`;
        out.push(`<rect class="fseg ${cls}" x="${x.toFixed(1)}" y="${y}" width="${Math.max(w - 1, 0.5).toFixed(1)}" height="${H1}" rx="2"${s === null ? ` fill="url(#${HATCH_ID})"` : ""}><title>${esc(title)}</title></rect>`);
        if (w >= 18) out.push(`<text class="fnum" x="${(x + w / 2).toFixed(1)}" y="${y + H1 - 3.5}" text-anchor="middle">${n}</text>`);
        start = i;
      }
    }
    return out.join("");
  };

  // Bands: group rows by (before, now), contiguous on both bars by construction.
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.before}→${r.now}`;
    if (!groups.has(k)) groups.set(k, { before: r.before, now: r.now, ids: [] });
    groups.get(k).ids.push(r.id);
  }
  const bands = [];
  for (const g of groups.values()) {
    const bs = g.ids.map((id) => slotB.get(id));
    const ns = g.ids.map((id) => slotN.get(id));
    const x0a = X0 + Math.min(...bs) * unit;
    const x0b = X0 + (Math.max(...bs) + 1) * unit - 1;
    const x1a = X0 + Math.min(...ns) * unit;
    const x1b = X0 + (Math.max(...ns) + 1) * unit - 1;
    const ya = Y1 + H1;
    const yb = Y2;
    const ym = (ya + yb) / 2;
    const same = g.before === g.now;
    const cls = same ? "band same" : g.now === null ? "band band-removed" : `band band-${g.now}${g.before === null ? " band-added" : ""}`;
    const label = same ? `${g.ids.length} stayed ${statusLabel(g.now)}` : g.before === null ? `${g.ids.length} added as ${statusLabel(g.now)}` : g.now === null ? `${g.ids.length} removed (was ${statusLabel(g.before)})` : `${g.ids.length}: ${statusLabel(g.before)} → ${statusLabel(g.now)}`;
    bands.push(
      `<path class="${cls}" d="M${x0a.toFixed(1)},${ya} C${x0a.toFixed(1)},${ym} ${x1a.toFixed(1)},${ym} ${x1a.toFixed(1)},${yb} L${x1b.toFixed(1)},${yb} C${x1b.toFixed(1)},${ym} ${x0b.toFixed(1)},${ym} ${x0b.toFixed(1)},${ya} Z"><title>${esc(label)}</title></path>`,
    );
  }
  // draw unchanged bands first so movement sits on top
  bands.sort((a, b) => (a.includes('"band same"') ? -1 : 1) - (b.includes('"band same"') ? -1 : 1));

  const svg = `<svg class="flow-svg" viewBox="0 0 ${W} ${Y2 + H1 + 18}" role="img" aria-label="Item statuses at your last visit and now, with bands showing what moved">
  <defs><pattern id="${HATCH_ID}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--paper)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted)" stroke-width="2"/></pattern></defs>
  <text class="flabel" x="${X0}" y="${Y1 - 8}">${esc(sinceText)}</text>
  <text class="flabel" x="${X0}" y="${Y2 + H1 + 12}">Now</text>
  ${bands.join("")}
  ${segs(byBefore, (r) => r.before, Y1)}
  ${segs(byNow, (r) => r.now, Y2)}
</svg>`;

  const b = segCounts(rows, (r) => r.before);
  const n = segCounts(rows, (r) => r.now);
  const legend = STATUS_ORDER.filter((s) => b.counts[s] || n.counts[s])
    .map((s) => {
      const d = n.counts[s] - b.counts[s];
      return `<span class="leg"><i class="dot-s st-${s}"></i>${esc(statusLabel(s))} <b>${n.counts[s]}</b>${d ? `<em class="${d > 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${d}</em>` : ""}</span>`;
    })
    .join("");
  const extra = [b.none ? `<span class="leg"><i class="dot-s st-hatch"></i>${b.none} added</span>` : "", n.none ? `<span class="leg"><i class="dot-s st-hatch"></i>${n.none} removed</span>` : ""].join("");
  return `<figure class="flow">${svg}<figcaption class="flow-legend">${legend}${extra}</figcaption></figure>`;
}

// When did things move: one dot per minute with changes, from `since` to now.
export function renderTimeline(events, since) {
  if (!events.length) return "";
  const now = Date.now();
  const times = events.map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t));
  let t0 = since ? Date.parse(since) : Math.min(...times);
  if (Number.isNaN(t0)) t0 = Math.min(...times);
  t0 = Math.min(t0, ...times);
  const span = Math.max(now - t0, 5 * 60000);
  const W = 360;
  const X0 = 8;
  const XW = W - 16;
  const Y = 16;
  const buckets = new Map();
  for (const ev of events) {
    const t = Date.parse(ev.at);
    if (Number.isNaN(t)) continue;
    const k = Math.floor(t / 60000);
    if (!buckets.has(k)) buckets.set(k, { t, events: [] });
    buckets.get(k).events.push(ev);
  }
  const dotClass = (evs) => {
    const last = evs[evs.length - 1];
    if (last.type === "status") return `st-${last.to}`;
    if (last.type === "added") return "st-added";
    if (last.type === "removed") return "st-removed";
    if (last.type.startsWith("diagram")) return "st-diagram";
    return "st-other";
  };
  const dots = [...buckets.values()]
    .map((b) => {
      const x = X0 + ((b.t - t0) / span) * XW;
      const r = Math.min(3.5 + b.events.length * 0.9, 8);
      return `<circle class="tdot ${dotClass(b.events)}" cx="${x.toFixed(1)}" cy="${Y}" r="${r.toFixed(1)}"><title>${esc(`${b.events.length} change${b.events.length === 1 ? "" : "s"} · ${clock(new Date(b.t).toISOString())}`)}</title></circle>`;
    })
    .join("");
  const startLabel = span > 36 * 3600000 ? dayLabel(new Date(t0).toISOString()) : clock(new Date(t0).toISOString());
  return `<svg class="timeline-svg" viewBox="0 0 ${W} 34" role="img" aria-label="When the changes happened">
  <line class="taxis" x1="${X0}" y1="${Y}" x2="${X0 + XW}" y2="${Y}"/>
  ${dots}
  <text class="flabel" x="${X0}" y="31">${esc(startLabel)}</text>
  <text class="flabel" x="${X0 + XW}" y="31" text-anchor="end">now</text>
</svg>`;
}

// Per-section progress then → now, only for sections where something moved.
export function renderSectionDeltas(state, rows) {
  const sections = (state.sections || []).filter((s) => s.counts && s.counts.total > 0);
  if (!sections.length) return "";
  const parentOf = new Map(sections.map((s) => [s.id, s.parent]));
  const isWithin = (secId, target) => {
    let cur = secId;
    let guard = 0;
    while (cur && guard++ < 20) {
      if (cur === target) return true;
      cur = parentOf.get(cur) || null;
    }
    return false;
  };
  const out = [];
  for (const s of sections) {
    const mine = rows.filter((r) => r.section && isWithin(r.section, s.id));
    if (!mine.some((r) => r.changed)) continue;
    const nowRows = mine.filter((r) => r.now !== null);
    const total = nowRows.length || 1;
    const kept = nowRows.filter((r) => r.now === "done" && r.before === "done").length;
    const newly = nowRows.filter((r) => r.now === "done" && r.before !== "done").length;
    const undone = nowRows.filter((r) => r.before === "done" && r.now !== "done").length;
    const doneBefore = mine.filter((r) => r.before === "done").length;
    const doneNow = kept + newly;
    const started = nowRows.filter((r) => r.now === "in_progress").length;
    const moved = mine.filter((r) => r.changed).length;
    const title = `${moved} item${moved === 1 ? "" : "s"} moved in this section: ${doneNow - doneBefore >= 0 ? "+" : ""}${doneNow - doneBefore} done${started ? `, ${started} in progress` : ""}`;
    out.push(
      `<button type="button" class="sec-delta" data-anchor-key="section:${esc(s.id)}" title="${esc(title)}">
        <span class="sd-title">${esc(s.title)}</span>
        <span class="sd-bar"><i class="sd-kept" style="width:${(100 * kept) / total}%"></i><i class="sd-new" style="width:${(100 * newly) / total}%"></i>${undone ? `<i class="sd-undone" style="width:${(100 * undone) / total}%"></i>` : ""}<i class="sd-prog" style="width:${(100 * started) / total}%"></i></span>
        <span class="sd-num">${doneBefore} → <b>${doneNow}</b> / ${nowRows.length}${started ? ` <span class="prog">+${started} started</span>` : ""}</span>
      </button>`,
    );
  }
  return out.length ? `<div class="sec-deltas">${out.join("")}</div>` : "";
}

// Events grouped per element, in document order, so a walk-through follows the board.
export function changeGroups(state, events) {
  const groups = new Map();
  const lineOf = (key) => {
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const found = kind === "item" ? (state.items || []).find((i) => i.id === id) : kind === "section" ? (state.sections || []).find((s) => s.id === id) : kind === "diagram" ? (state.diagrams || []).find((d) => d.id === id) : null;
    return found && found.line ? found.line : Number.MAX_SAFE_INTEGER;
  };
  for (const ev of events) {
    const key = eventKey(ev);
    if (!groups.has(key)) groups.set(key, { key, events: [], line: lineOf(key) });
    groups.get(key).events.push(ev);
  }
  return [...groups.values()].sort((a, b) => a.line - b.line || a.events[0].at.localeCompare(b.events[0].at));
}

export function groupLabel(group, state) {
  const last = group.events[group.events.length - 1];
  if (last.item) return ((state.items || []).find((i) => i.id === last.item) || {}).text || last.text || last.item;
  if (last.section) return ((state.sections || []).find((s) => s.id === last.section) || {}).title || last.text || last.section;
  if (last.diagram) return `diagram ${last.diagram}`;
  return "plan";
}

function pill(status, statusLabel) {
  return `<span class="pill st-${esc(status || "none")}">${esc(statusLabel(status))}</span>`;
}

// The graphics for one group: a chain of status pills, added/removed tags, a
// word diff for rewordings, a before/after switch for diagrams.
export function renderGroupBody(group, { statusLabel, beforeMode }) {
  const parts = [];
  const statusEvents = group.events.filter((e) => e.type === "status");
  if (statusEvents.length) {
    const chain = [statusEvents[0].from, ...statusEvents.map((e) => e.to)];
    // collapse A → B → A style noise into distinct steps but keep order
    parts.push(`<div class="pill-chain">${chain.map((s) => pill(s, statusLabel)).join('<span class="arrow">→</span>')}</div>`);
  }
  for (const ev of group.events) {
    switch (ev.type) {
      case "added":
        parts.push(`<div class="ev-line"><span class="tag tag-added">added</span>${ev.status ? pill(ev.status, statusLabel) : ""}</div>`);
        break;
      case "removed":
        parts.push(`<div class="ev-line"><span class="tag tag-removed">removed</span>${ev.status ? pill(ev.status, statusLabel) : ""}</div>`);
        break;
      case "reworded":
        parts.push(`<div class="rewording">${renderWordDiff(ev.from, ev.to)}</div>`);
        break;
      case "diagram_changed": {
        const on = beforeMode && beforeMode.has(ev.diagram);
        parts.push(
          `<div class="ev-line"><span class="tag tag-diagram">diagram changed</span>${typeof ev.from === "string" ? `<button type="button" class="mini-btn toggle-before${on ? " on" : ""}" data-diagram="${esc(ev.diagram)}">${on ? "Show current" : "Show before"}</button>` : ""}</div>`,
        );
        break;
      }
      case "diagram_added":
        parts.push(`<div class="ev-line"><span class="tag tag-added">diagram added</span></div>`);
        break;
      case "diagram_removed":
        parts.push(`<div class="ev-line"><span class="tag tag-removed">diagram removed</span></div>`);
        break;
      case "section_added":
        parts.push(`<div class="ev-line"><span class="tag tag-added">section added</span></div>`);
        break;
      case "section_removed":
        parts.push(`<div class="ev-line"><span class="tag tag-removed">section removed</span></div>`);
        break;
      default:
        break;
    }
  }
  return parts.join("");
}

export function renderChangeRows(groups, state, { statusLabel, currentIndex, beforeMode }) {
  return groups
    .map((g, i) => {
      const last = g.events[g.events.length - 1];
      const removed = g.events.some((e) => e.type === "removed" || e.type === "section_removed" || e.type === "diagram_removed") && !g.events.some((e) => e.type === "added");
      const sec = last.item ? ((state.items || []).find((it) => it.id === last.item) || {}).section : null;
      const secTitle = sec ? ((state.sections || []).find((s) => s.id === sec) || {}).title : "";
      return `<div class="change-row${i === currentIndex ? " current" : ""}" data-change-index="${i}" data-anchor-key="${esc(g.key)}">
        <div class="cr-head"><span class="cr-idx">${i + 1}</span><button type="button" class="anchor-chip cr-label${removed ? " removed" : ""}" data-anchor-key="${esc(g.key)}" title="${esc(groupLabel(g, state))}">${esc(groupLabel(g, state))}</button><time title="${esc(last.at)}">${ago(last.at)}</time></div>
        ${secTitle ? `<div class="cr-sec">${esc(secTitle)}</div>` : ""}
        <div class="cr-body">${renderGroupBody(g, { statusLabel, beforeMode })}</div>
      </div>`;
    })
    .join("");
}

export function summarize(events) {
  const counts = { done: 0, in_progress: 0, blocked: 0, question: 0, added: 0, removed: 0, reworded: 0, diagram: 0 };
  for (const ev of events) {
    if (ev.type === "status" && counts[ev.to] !== undefined) counts[ev.to]++;
    else if (ev.type === "added") counts.added++;
    else if (ev.type === "removed") counts.removed++;
    else if (ev.type === "reworded") counts.reworded++;
    else if (ev.type.startsWith("diagram")) counts.diagram++;
  }
  return [
    counts.done && `${counts.done} done`,
    counts.in_progress && `${counts.in_progress} started`,
    counts.blocked && `${counts.blocked} blocked`,
    counts.question && `${counts.question} need a decision`,
    counts.added && `${counts.added} added`,
    counts.removed && `${counts.removed} removed`,
    counts.reworded && `${counts.reworded} reworded`,
    counts.diagram && `${counts.diagram} diagram edit${counts.diagram === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function renderChangesPanel({ state, events, since, sinceBasis, statusLabel, review, beforeMode }) {
  const sinceText = sinceBasis === "visit" && since ? `since your last visit (${ago(since)}, ${clock(since)})` : "since you opened the board";
  if (!events.length) {
    return `<div class="empty">Nothing changed ${esc(sinceText)}.<br><span class="muted">Changes appear here as the agent edits the plan; the flow chart shows how items moved between statuses.</span></div>`;
  }
  const groups = changeGroups(state, events);
  const rows = statusRows(state, events);
  const idx = review.index >= 0 && review.index < groups.length ? review.index : -1;
  const head = `<div class="changes-summary">
    <div class="cs-head"><span><b>${events.length} change${events.length === 1 ? "" : "s"}</b> ${esc(sinceText)}</span>
      <span class="review-nav"><button type="button" class="mini-btn" data-review="prev" title="Previous change (p)">‹</button><span class="review-pos">${idx >= 0 ? idx + 1 : "–"} / ${groups.length}</span><button type="button" class="mini-btn" data-review="next" title="Next change (n)">›</button></span></div>
    <div class="muted cs-sum">${esc(summarize(events))}</div>
  </div>`;
  const flowLabel = sinceBasis === "visit" && since ? `At your last visit (${clock(since)})` : "When you opened the board";
  return [
    head,
    renderFlow(rows, { statusLabel, sinceText: flowLabel }),
    `<div class="timeline">${renderTimeline(events, since)}</div>`,
    renderSectionDeltas(state, rows),
    `<div class="change-list">${renderChangeRows(groups, state, { statusLabel, currentIndex: idx, beforeMode })}</div>`,
  ].join("");
}
