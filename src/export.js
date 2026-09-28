// `planboard export`: the plan with every thread folded in as blockquotes under
// the item, heading, diagram or image it was about, plus the status history -
// one Markdown file for project records that reads without planboard.

import path from "node:path";

import { STATUS_LABEL } from "./plan.js";
import { anchorKey } from "./store.js";

const LIST_MARKER_RE = /^(\s*)([-*+]|\d+[.)])(\s+)/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

function pad(n) {
  return String(n).padStart(2, "0");
}

// Local time, minute precision: the export is read by a person on their own machine.
export function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function who(note) {
  return note.from === "agent" ? "Agent" : "User";
}

function quoteLines(text, prefix) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  return lines.map((l) => (l.trim() ? `${prefix} ${l}` : prefix));
}

function threadTitle(anchor, model) {
  switch (anchor.type) {
    case "node":
      return `Thread on node “${anchor.label || anchor.node}”`;
    case "image":
      return typeof anchor.x === "number" ? `Thread on image @ ${Math.round(anchor.x * 100)}%, ${Math.round(anchor.y * 100)}%` : "Thread on image";
    case "text": {
      return "Thread";
    }
    case "section": {
      const s = model.sections.find((x) => x.id === anchor.section);
      return s ? `Thread on “${s.title}”` : "Thread";
    }
    default:
      return "Thread";
  }
}

// One thread as blockquote lines, each prefixed with `indent>`.
export function renderThreadBlock(notes, { indent = "", title = "Thread", attachmentRef = () => null } = {}) {
  const p = `${indent}>`;
  const out = [`${p} **${title}** · ${notes.length} note${notes.length === 1 ? "" : "s"}`];
  for (const n of notes) {
    out.push(p);
    const meta = [`**${who(n)}**`, formatWhen(n.at)];
    if (n.depth && n.depth !== "normal") meta.push(`depth: ${n.depth}`);
    if (n.kind === "sketch") meta.push("whiteboard sketch");
    if (n.from === "user" && n.state && n.state !== "delivered") meta.push(n.state === "queued" ? "not sent yet" : "sent, not yet delivered");
    out.push(`${p} ${meta.join(" · ")}`);
    // the quoted plan text belongs to the user's note; replies inherit the anchor but not the quote
    const quote = n.from === "user" ? n.quote || (n.anchor && n.anchor.type === "text" ? n.anchor.quote : "") : "";
    if (quote) out.push(...quoteLines(quote, `${p} >`));
    out.push(...quoteLines(n.text, p));
    for (const f of n.attachments || []) {
      const ref = attachmentRef(f);
      if (!ref) continue;
      out.push(/\.(png|jpe?g|gif|webp)$/i.test(f) ? `${p} ![${f}](${ref})` : `${p} [${f}](${ref})`);
    }
  }
  return out;
}

function findFenceEnd(lines, openIdx) {
  const open = FENCE_RE.exec(lines[openIdx] || "");
  const marker = open ? open[1] : "```";
  for (let i = openIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith(marker[0].repeat(marker.length)) && /^[`~]+\s*$/.test(t)) return i;
  }
  return openIdx;
}

function describeChange(ev) {
  const t = (s) => (s ? STATUS_LABEL[s] || s : "none");
  switch (ev.type) {
    case "status":
      return `${t(ev.from)} → ${t(ev.to)}`;
    case "added":
      return `added${ev.status ? ` as ${t(ev.status)}` : ""}`;
    case "removed":
      return "removed";
    case "reworded":
      return `reworded: “${ev.from}” → “${ev.to}”`;
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

export function exportMarkdown({ source, model, store, planPath, version = "", at = new Date() }) {
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const planDir = path.dirname(planPath);
  const attachmentRef = (f) => {
    const p = store.attachmentPath ? store.attachmentPath(f) : null;
    return p ? path.relative(planDir, p).split(path.sep).join("/") : null;
  };
  const inserts = new Map(); // 0-based line index -> lines to insert after it
  const addAfter = (idx, block) => {
    if (!inserts.has(idx)) inserts.set(idx, []);
    inserts.get(idx).push(...block);
  };

  // Group notes by thread key, keep each thread's own anchor (first note's).
  const threads = new Map();
  for (const n of store.notes) {
    const key = anchorKey(n.anchor);
    if (!threads.has(key)) threads.set(key, { anchor: n.anchor, notes: [] });
    threads.get(key).notes.push(n);
  }

  const orphans = [];
  const boardNotes = [];
  for (const [key, t] of threads) {
    const a = t.anchor;
    if (key === "board") {
      boardNotes.push(...t.notes);
      continue;
    }
    const kind = key.slice(0, key.indexOf(":"));
    const idPart = key.slice(key.indexOf(":") + 1);
    if (kind === "item") {
      const item = model.items.find((i) => i.id === idPart);
      if (!item || !item.line) {
        orphans.push(t);
        continue;
      }
      const idx = item.line - 1;
      const m = LIST_MARKER_RE.exec(lines[idx] || "");
      const indent = m ? m[1] + " ".repeat(m[2].length + m[3].length) : "  ";
      addAfter(idx, renderThreadBlock(t.notes, { indent, title: "Thread", attachmentRef }));
    } else if (kind === "section") {
      const s = model.sections.find((x) => x.id === idPart);
      if (!s || !s.line) {
        orphans.push(t);
        continue;
      }
      addAfter(s.line - 1, ["", ...renderThreadBlock(t.notes, { title: threadTitle({ type: "section", section: idPart }, model), attachmentRef })]);
    } else if (kind === "diagram" || kind === "node") {
      const did = kind === "node" ? idPart.slice(0, idPart.indexOf("/")) : idPart;
      const d = model.diagrams.find((x) => x.id === did);
      if (!d || !d.line) {
        orphans.push(t);
        continue;
      }
      const end = findFenceEnd(lines, d.line - 1);
      addAfter(end, ["", ...renderThreadBlock(t.notes, { title: kind === "node" ? threadTitle(a, model) : `Thread on diagram “${did}”`, attachmentRef })]);
    } else if (kind === "image") {
      const im = model.images.find((x) => x.src === idPart);
      if (!im || !im.line) {
        orphans.push(t);
        continue;
      }
      // pins: one block per distinct point, in note order
      const byPoint = new Map();
      for (const n of t.notes) {
        const pk = typeof n.anchor.x === "number" ? `${n.anchor.x},${n.anchor.y}` : "";
        if (!byPoint.has(pk)) byPoint.set(pk, []);
        byPoint.get(pk).push(n);
      }
      const block = [""];
      for (const [, notes] of byPoint) block.push(...renderThreadBlock(notes, { title: threadTitle(notes[0].anchor, model), attachmentRef }), "");
      block.pop();
      addAfter(im.line - 1, block);
    } else orphans.push(t);
  }

  // Assemble: header comment after the front matter, inserts in place, appendices.
  const out = [];
  const fm = model.frontMatterLines || 0;
  const header = `<!-- Exported by planboard${version ? ` ${version}` : ""} on ${formatWhen(at.toISOString())} from ${path.basename(planPath)}. Threads are the blockquotes under the items, headings, diagrams and images they were about; the status history is at the end. -->`;
  for (let i = 0; i < lines.length; i++) {
    if (i === fm) {
      if (fm > 0) out.push("");
      out.push(header);
      if (lines[i].trim() !== "") out.push("");
    }
    out.push(lines[i]);
    const extra = inserts.get(i);
    if (extra) out.push(...extra);
  }
  if (fm >= lines.length) out.push(header);
  while (out.length && out[out.length - 1].trim() === "") out.pop();

  if (boardNotes.length) {
    out.push("", "## Notes on the whole plan", "", ...renderThreadBlock(boardNotes, { title: "Thread", attachmentRef }));
  }
  if (orphans.length) {
    out.push("", "## Threads on elements no longer in the plan", "");
    for (const t of orphans) {
      out.push(...renderThreadBlock(t.notes, { title: `Thread on ${anchorKey(t.anchor)}`, attachmentRef }), "");
    }
    out.pop();
  }
  if (store.events.length) {
    out.push("", "## Status history", "");
    let day = "";
    for (const ev of store.events) {
      const d = formatWhen(ev.at).slice(0, 10);
      if (d !== day) {
        if (day) out.push("");
        out.push(`**${d}**`, "");
        day = d;
      }
      const target = ev.item
        ? `${(model.items.find((i) => i.id === ev.item) || {}).text || ev.text || ev.item} (\`${ev.item}\`)`
        : ev.section
          ? `${(model.sections.find((s) => s.id === ev.section) || {}).title || ev.text || ev.section} (\`${ev.section}\`)`
          : ev.diagram
            ? `diagram \`${ev.diagram}\``
            : "plan";
      out.push(`- ${formatWhen(ev.at).slice(11)} · ${target}: ${describeChange(ev)}`);
    }
  }
  return out.join("\n") + "\n";
}
