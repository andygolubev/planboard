// Derive the status log from successive parses of the plan, so the agent does not
// have to declare what it changed (contrast: lavish-axi's opt-in revisions legend).

import crypto from "node:crypto";

function hash(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 12);
}

// Diagram sources are kept in the snapshot (they are small) so a
// `diagram_changed` event can carry the previous version and the board can show
// before/after when the user reviews changes.
export function snapshotOf(model) {
  return {
    items: model.items.map((i) => ({ id: i.id, status: i.status, text: i.text, section: i.section })),
    sections: model.sections.map((s) => ({ id: s.id, title: s.title })),
    diagrams: model.diagrams.map((d) => ({ id: d.id, hash: hash(d.source), source: d.source })),
  };
}

// Events are what the board shows as "what moved": status flips first, then
// additions, removals, rewordings, and diagram edits. `prev === null` is the
// first sighting of a plan and produces no events - there is nothing to compare.
export function diffSnapshots(prev, next, at = new Date().toISOString()) {
  if (!prev) return [];
  const events = [];
  const prevItems = new Map(prev.items.map((i) => [i.id, i]));
  const nextItems = new Map(next.items.map((i) => [i.id, i]));

  for (const [id, item] of nextItems) {
    const before = prevItems.get(id);
    if (!before) {
      events.push({ at, type: "added", item: id, status: item.status, text: item.text, section: item.section });
      continue;
    }
    if (before.status !== item.status) {
      events.push({ at, type: "status", item: id, from: before.status, to: item.status, text: item.text, section: item.section });
    }
    if (before.text !== item.text) {
      events.push({ at, type: "reworded", item: id, from: before.text, to: item.text, section: item.section });
    }
  }
  for (const [id, item] of prevItems) {
    if (!nextItems.has(id)) events.push({ at, type: "removed", item: id, status: item.status, text: item.text, section: item.section });
  }

  const prevSections = new Map(prev.sections.map((s) => [s.id, s]));
  const nextSections = new Map(next.sections.map((s) => [s.id, s]));
  for (const [id, s] of nextSections) if (!prevSections.has(id)) events.push({ at, type: "section_added", section: id, text: s.title });
  for (const [id, s] of prevSections) if (!nextSections.has(id)) events.push({ at, type: "section_removed", section: id, text: s.title });

  const prevDiagrams = new Map(prev.diagrams.map((d) => [d.id, d]));
  for (const d of next.diagrams) {
    const before = prevDiagrams.get(d.id);
    if (!before) events.push({ at, type: "diagram_added", diagram: d.id });
    else if (before.hash !== d.hash) {
      const ev = { at, type: "diagram_changed", diagram: d.id };
      if (typeof before.source === "string") ev.from = before.source;
      if (typeof d.source === "string") ev.to = d.source;
      events.push(ev);
    }
  }
  for (const d of prev.diagrams) if (!next.diagrams.some((n) => n.id === d.id)) events.push({ at, type: "diagram_removed", diagram: d.id });

  return events;
}

export function describeEvent(ev, labels = {}) {
  const t = (s) => (s ? labels[s] || s : "none");
  switch (ev.type) {
    case "status":
      return `${t(ev.from)} → ${t(ev.to)}`;
    case "added":
      return `added${ev.status ? ` (${t(ev.status)})` : ""}`;
    case "removed":
      return "removed";
    case "reworded":
      return "reworded";
    case "section_added":
      return "section added";
    case "section_removed":
      return "section removed";
    case "diagram_added":
      return "diagram added";
    case "diagram_changed":
      return "diagram changed";
    case "diagram_removed":
      return "diagram removed";
    default:
      return ev.type;
  }
}
