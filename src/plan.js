// PLAN.md -> board model + HTML.
//
// The plan is ordinary Markdown with three conventions:
//   - list items that start with a task marker carry a status:
//       [ ] todo   [~] in progress   [x] done   [!] blocked   [?] needs decision   [-] dropped
//   - items, headings and ```mermaid fences may end with `{#id}` (Pandoc attribute
//     syntax) - a stable anchor that threads and the status log key on;
//   - ```mermaid fences become clickable diagrams, images become pin-able figures.
// Everything else renders as the Markdown it is; raw HTML/SVG passes through.

import MarkdownIt from "markdown-it";

export const STATUS_BY_CHAR = {
  " ": "todo",
  x: "done",
  X: "done",
  "~": "in_progress",
  "/": "in_progress",
  "!": "blocked",
  "?": "question",
  "-": "dropped",
};
export const CHAR_BY_STATUS = {
  todo: " ",
  in_progress: "~",
  done: "x",
  blocked: "!",
  question: "?",
  dropped: "-",
};
export const STATUSES = Object.keys(CHAR_BY_STATUS);
export const STATUS_LABEL = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  blocked: "Blocked",
  question: "Needs decision",
  dropped: "Dropped",
};
export const STATUS_ALIASES = {
  todo: "todo",
  open: "todo",
  " ": "todo",
  doing: "in_progress",
  wip: "in_progress",
  progress: "in_progress",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  "~": "in_progress",
  "/": "in_progress",
  done: "done",
  complete: "done",
  completed: "done",
  x: "done",
  blocked: "blocked",
  "!": "blocked",
  question: "question",
  decision: "question",
  "?": "question",
  dropped: "dropped",
  cancelled: "dropped",
  canceled: "dropped",
  "-": "dropped",
};

const TASK_RE = /^\[([ xX~/!?-])\](?:\s+|$)/;
const ID_RE = /\s*\{#([A-Za-z0-9][A-Za-z0-9_.:-]*)\}\s*$/;
const LIST_LINE_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX~/!?-])\]/;

export function normalizeStatus(value) {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  return STATUS_ALIASES[key] || STATUS_ALIASES[String(value ?? "").trim()] || null;
}

export function slugify(text) {
  const s = String(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || "x";
}

// A leading `---` block of `key: value` lines. Kept deliberately simple: the
// plan's title and a few knobs, not a YAML document.
export function splitFrontMatter(source) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!m) return { meta: {}, body: source, offset: 0 };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (mm) meta[mm[1]] = mm[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: source.slice(m[0].length), offset: m[0].split("\n").length - 1 };
}

function createMd() {
  return new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
}

function plainText(inline) {
  if (!inline || !inline.children) return (inline && inline.content) || "";
  let out = "";
  for (const child of inline.children) {
    if (child.type === "text" || child.type === "code_inline") out += child.content;
    else if (child.type === "softbreak" || child.type === "hardbreak") out += " ";
    else if (child.type === "image") out += child.content;
  }
  return out.replace(/\s+/g, " ").trim();
}

function firstTextChild(inline) {
  return inline && inline.children ? inline.children.find((c) => c.type === "text") : null;
}

function lastTextChild(inline) {
  if (!inline || !inline.children) return null;
  for (let i = inline.children.length - 1; i >= 0; i--) {
    const c = inline.children[i];
    if (c.type === "text") return c;
    if (c.type !== "softbreak" && c.type !== "hardbreak") return null;
  }
  return null;
}

// Pull a trailing `{#id}` out of the inline's last text child. Returns the id or null.
function extractId(inline) {
  const last = lastTextChild(inline);
  if (!last) return null;
  const m = ID_RE.exec(last.content);
  if (!m) return null;
  last.content = last.content.slice(0, m.index);
  return m[1];
}

function extractTaskMarker(inline) {
  const first = firstTextChild(inline);
  if (!first || inline.children[0] !== first) return null;
  const m = TASK_RE.exec(first.content);
  if (!m) return null;
  first.content = first.content.slice(m[0].length);
  return STATUS_BY_CHAR[m[1]] || null;
}

function uniqueId(base, used) {
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

function claimId(explicit, fallback, used, warnings, line, what) {
  if (explicit && used.has(explicit)) {
    warnings.push({ level: "error", line, message: `duplicate id "${explicit}" on this ${what}; rendered as "${explicit}-2" - make it unique` });
  }
  return uniqueId(explicit || fallback, used);
}

// Walk the token stream once, building the model and stamping tokens with the
// metadata the renderer rules need (`token.meta`).
function analyze(tokens, { offset, meta }) {
  const sections = [];
  const items = [];
  const diagrams = [];
  const images = [];
  const warnings = [];
  const used = new Set();
  const usedDiagramIds = new Set();
  const sectionStack = [];
  const itemStack = [];
  let listDepth = 0;
  let diagramCount = 0;
  const line = (tok) => (tok.map ? tok.map[0] + 1 + offset : null);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case "heading_open": {
        const level = Number(tok.tag.slice(1));
        const inline = tokens[i + 1];
        const explicit = extractId(inline);
        const title = plainText(inline);
        while (sectionStack.length && sectionStack[sectionStack.length - 1].level >= level) sectionStack.pop();
        const parent = sectionStack.length ? sectionStack[sectionStack.length - 1] : null;
        const id = claimId(explicit, slugify(title), used, warnings, line(tok), "heading");
        const section = {
          id,
          autoId: !explicit,
          level,
          title,
          line: line(tok),
          parent: parent ? parent.id : null,
          counts: emptyCounts(),
        };
        sections.push(section);
        sectionStack.push(section);
        tok.meta = { section };
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open":
        listDepth++;
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        listDepth--;
        break;
      case "list_item_open": {
        // The item's own text is the first inline inside its first paragraph.
        let inline = null;
        if (tokens[i + 1] && tokens[i + 1].type === "paragraph_open" && tokens[i + 2] && tokens[i + 2].type === "inline") {
          inline = tokens[i + 2];
        }
        const status = inline ? extractTaskMarker(inline) : null;
        const explicit = inline ? extractId(inline) : null;
        const text = inline ? plainText(inline) : "";
        const section = sectionStack.length ? sectionStack[sectionStack.length - 1] : null;
        const parentItem = itemStack.length ? itemStack[itemStack.length - 1] : null;
        const id = claimId(explicit, `${section ? section.id + "--" : ""}${slugify(text)}`, used, warnings, line(tok), "item");
        const item = {
          id,
          autoId: !explicit,
          status,
          text,
          line: line(tok),
          section: section ? section.id : null,
          parent: parentItem ? parentItem.id : null,
          depth: itemStack.length,
        };
        items.push(item);
        if (status) {
          if (section) section.counts[status]++, section.counts.total++;
        }
        itemStack.push(item);
        tok.meta = { item };
        break;
      }
      case "list_item_close":
        itemStack.pop();
        break;
      case "fence": {
        const info = tok.info.trim();
        if (/^mermaid(\s|$|\{)/.test(info)) {
          const idMatch = /\{#([A-Za-z0-9][A-Za-z0-9_.:-]*)\}/.exec(info);
          const words = info.replace(/\{#[^}]*\}/, "").trim().split(/\s+/);
          const explicit = idMatch ? idMatch[1] : words[1] || null;
          diagramCount++;
          const id = claimId(explicit, `diagram-${diagramCount}`, usedDiagramIds, warnings, line(tok), "diagram");
          const section = sectionStack.length ? sectionStack[sectionStack.length - 1] : null;
          const diagram = {
            id,
            autoId: !explicit,
            source: tok.content.replace(/\s+$/, ""),
            line: line(tok),
            section: section ? section.id : null,
          };
          diagrams.push(diagram);
          tok.meta = { diagram };
        }
        break;
      }
      case "paragraph_open":
      case "blockquote_open":
      case "table_open":
      case "html_block": {
        if (listDepth === 0) {
          const section = sectionStack.length ? sectionStack[sectionStack.length - 1] : null;
          tok.meta = { block: { section: section ? section.id : null, line: line(tok) } };
        }
        break;
      }
      case "inline": {
        if (!tok.children) break;
        for (const child of tok.children) {
          if (child.type !== "image") continue;
          const src = child.attrGet("src") || "";
          const section = sectionStack.length ? sectionStack[sectionStack.length - 1] : null;
          const image = { src, alt: child.content || "", line: line(tok), section: section ? section.id : null };
          images.push(image);
          child.meta = { image };
        }
        break;
      }
      default:
        break;
    }
  }

  const counts = emptyCounts();
  for (const item of items) {
    if (!item.status) continue;
    counts[item.status]++;
    counts.total++;
  }
  // Roll nested sections up into their parents so an h2 shows its h3s' progress too.
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i];
    if (!s.parent) continue;
    const parent = sections.find((p) => p.id === s.parent);
    if (!parent) continue;
    for (const k of Object.keys(s.counts)) parent.counts[k] += s.counts[k];
  }

  for (const item of items) {
    if (item.status && item.autoId) {
      warnings.push({ level: "warn", line: item.line, message: `item "${truncate(item.text, 50)}" has no {#id}; using "${item.id}"` });
    }
  }
  for (const d of diagrams) {
    if (d.autoId) warnings.push({ level: "info", line: d.line, message: `diagram has no id; using "${d.id}" (add {#id} to the fence info)` });
  }

  const title = meta.title || (sections.find((s) => s.level === 1) || {}).title || "Plan";
  return { title, meta, sections, items, diagrams, images, counts, warnings };
}

export function emptyCounts() {
  return { total: 0, todo: 0, in_progress: 0, done: 0, blocked: 0, question: 0, dropped: 0 };
}

function truncate(text, n) {
  const s = String(text || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isRelativeUrl(src) {
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|data:)/i.test(src);
}

function installRules(md, env) {
  const defaults = { ...md.renderer.rules };
  const rules = md.renderer.rules;

  rules.heading_open = (tokens, idx, options, _env, self) => {
    const s = tokens[idx].meta && tokens[idx].meta.section;
    if (!s) return self.renderToken(tokens, idx, options);
    const complete = s.counts.total > 0 && s.counts.done === s.counts.total;
    return `<${tokens[idx].tag} class="section-head${complete ? " sec-complete" : ""}" id="sec-${escapeHtml(s.id)}" data-section="${escapeHtml(s.id)}" data-level="${tokens[idx].tag.slice(1)}" data-line="${s.line ?? ""}"><span class="sec-title">`;
  };
  rules.heading_close = (tokens, idx, options, _env, self) => {
    const open = tokens[idx - 2];
    const s = open && open.meta && open.meta.section;
    if (!s) return self.renderToken(tokens, idx, options);
    const c = s.counts;
    const seg = (k) => (c[k] ? `<i class="seg seg-${k}" style="width:${(100 * c[k]) / c.total}%"></i>` : "");
    const title = [`${c.done} of ${c.total} done`, c.in_progress ? `${c.in_progress} in progress` : "", c.blocked ? `${c.blocked} blocked` : "", c.question ? `${c.question} to decide` : ""].filter(Boolean).join(", ");
    const progress =
      c.total > 0
        ? `<span class="sec-progress" title="${escapeHtml(title)}"><span class="sec-bar">${seg("done")}${seg("in_progress")}${seg("blocked")}${seg("question")}</span>${c.done}/${c.total}</span>`
        : "";
    const done = c.total > 0 && c.done === c.total;
    return `</span>${progress}</${tokens[idx].tag}>\n`.replace(/^<\/span>/, done ? '</span><span class="sec-done-mark" title="Everything in this section is done">✓</span>' : "</span>");
  };
  rules.list_item_open = (tokens, idx, options, _env, self) => {
    const item = tokens[idx].meta && tokens[idx].meta.item;
    if (!item) return self.renderToken(tokens, idx, options);
    const status = item.status || "none";
    const label = item.status ? STATUS_LABEL[item.status] : "";
    return `<li class="item status-${status}" data-item="${escapeHtml(item.id)}" data-status="${status}" data-line="${item.line ?? ""}"><span class="item-mark" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"></span><div class="item-body">`;
  };
  rules.list_item_close = (tokens, idx, options, _env, self) => {
    // find the matching open token to know whether we wrapped it
    let depth = 0;
    for (let j = idx - 1; j >= 0; j--) {
      const t = tokens[j];
      if (t.type === "list_item_close") depth++;
      else if (t.type === "list_item_open") {
        if (depth === 0) return t.meta && t.meta.item ? "</div></li>\n" : self.renderToken(tokens, idx, options);
        depth--;
      }
    }
    return self.renderToken(tokens, idx, options);
  };
  rules.fence = (tokens, idx, options, _env, self) => {
    const d = tokens[idx].meta && tokens[idx].meta.diagram;
    if (!d) return defaults.fence ? defaults.fence(tokens, idx, options, _env, self) : self.renderToken(tokens, idx, options);
    return `<figure class="diagram" data-diagram="${escapeHtml(d.id)}" data-line="${d.line ?? ""}"><pre class="mermaid-src" hidden>${escapeHtml(d.source)}</pre><div class="diagram-canvas" aria-busy="true"></div><figcaption class="diagram-caption">${escapeHtml(d.id)}</figcaption></figure>\n`;
  };
  rules.image = (tokens, idx, options, _env, self) => {
    const tok = tokens[idx];
    const src = tok.attrGet("src") || "";
    const image = tok.meta && tok.meta.image;
    const served = env.assetBase && isRelativeUrl(src) ? env.assetBase + src.split("/").map(encodeURIComponent).join("/") : src;
    const alt = self.renderInlineAsText(tok.children || [], options, _env);
    const title = tok.attrGet("title");
    return `<span class="img-wrap" data-image="${escapeHtml(src)}" data-line="${image ? image.line ?? "" : ""}"><img src="${escapeHtml(served)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy"><span class="img-pins"></span></span>`;
  };
  for (const type of ["paragraph_open", "blockquote_open", "table_open"]) {
    rules[type] = (tokens, idx, options, _env, self) => {
      const block = tokens[idx].meta && tokens[idx].meta.block;
      if (block) {
        tokens[idx].attrSet("class", "block");
        tokens[idx].attrSet("data-block", String(block.line ?? ""));
        if (block.section) tokens[idx].attrSet("data-section-of", block.section);
      }
      return self.renderToken(tokens, idx, options);
    };
  }
}

export function parsePlan(source, options = {}) {
  const { meta, body, offset } = splitFrontMatter(String(source ?? ""));
  const md = createMd();
  const env = { assetBase: options.assetBase || "" };
  const tokens = md.parse(body, env);
  const model = analyze(tokens, { offset, meta });
  installRules(md, env);
  model.html = md.renderer.render(tokens, md.options, env);
  model.frontMatterLines = offset;
  return model;
}

// Change one item's checkbox character in place. Returns the new source and the
// change, or throws when the id is unknown or the line no longer looks like a task.
export function setItemStatus(source, itemId, status) {
  const to = normalizeStatus(status);
  if (!to) throw new Error(`unknown status "${status}" (use ${STATUSES.join(", ")})`);
  const model = parsePlan(source);
  const item = model.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`no item with id "${itemId}"`);
  if (!item.line) throw new Error(`item "${itemId}" has no source line`);
  const lines = String(source).split("\n");
  const idx = item.line - 1;
  const m = LIST_LINE_RE.exec(lines[idx] || "");
  if (!m) throw new Error(`line ${item.line} is not a task item: ${JSON.stringify(lines[idx])}`);
  const from = STATUS_BY_CHAR[m[2]] || null;
  lines[idx] = lines[idx].replace(LIST_LINE_RE, `$1[${CHAR_BY_STATUS[to]}]`);
  return { source: lines.join("\n"), item, from, to };
}

export function lint(model) {
  const warnings = [...model.warnings];
  if (!model.sections.some((s) => s.level === 1) && !model.meta.title) {
    warnings.push({ level: "info", line: 1, message: "no `# Title` heading or front-matter title; the board is called \"Plan\"" });
  }
  return warnings.sort((a, b) => (a.line || 0) - (b.line || 0));
}

// Markdown for agent replies and note text - no raw HTML, links auto-detected.
const replyMd = new MarkdownIt({ html: false, linkify: true, breaks: true });
export function renderMarkdown(text) {
  return replyMd.render(String(text ?? ""));
}

export function findAnchorTarget(model, anchor) {
  if (!anchor) return null;
  switch (anchor.type) {
    case "item":
      return model.items.find((i) => i.id === anchor.item) || null;
    case "section":
      return model.sections.find((s) => s.id === anchor.section) || null;
    case "node":
    case "diagram":
      return model.diagrams.find((d) => d.id === anchor.diagram) || null;
    case "image":
      return model.images.find((im) => im.src === anchor.src) || null;
    default:
      return null;
  }
}
