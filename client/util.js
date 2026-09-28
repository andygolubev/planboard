// Pure helpers shared by the board modules: escaping, time, anchors, word diff.

export const STATUS_ORDER = ["todo", "in_progress", "blocked", "question", "done", "dropped"];

export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function ago(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

export function clock(iso) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}

export function anchorKeyOf(a) {
  if (!a || !a.type) return "board";
  switch (a.type) {
    case "item":
      return `item:${a.item}`;
    case "section":
      return `section:${a.section}`;
    case "node":
      return `node:${a.diagram}/${a.node}`;
    case "diagram":
      return `diagram:${a.diagram}`;
    case "image":
      return `image:${a.src}`;
    case "text":
      return a.item ? `item:${a.item}` : a.section ? `section:${a.section}` : "board";
    default:
      return "board";
  }
}

// Which board element an event is about, as a thread key.
export function eventKey(ev) {
  return ev.item ? `item:${ev.item}` : ev.section ? `section:${ev.section}` : ev.diagram ? `diagram:${ev.diagram}` : "board";
}

// Word-level diff (LCS on whitespace-separated tokens), small inputs only.
export function wordDiff(a, b) {
  const A = String(a ?? "").split(/(\s+)/).filter((t) => t !== "");
  const B = String(b ?? "").split(/(\s+)/).filter((t) => t !== "");
  const n = A.length;
  const m = B.length;
  if (n * m > 40000) return [{ type: "del", text: String(a) }, { type: "ins", text: String(b) }];
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push("eq", A[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", A[i++]);
    else push("ins", B[j++]);
  }
  while (i < n) push("del", A[i++]);
  while (j < m) push("ins", B[j++]);
  return out;
}

export function renderWordDiff(a, b) {
  return wordDiff(a, b)
    .map((p) => (p.type === "eq" ? esc(p.text) : p.type === "del" ? `<del>${esc(p.text)}</del>` : `<ins>${esc(p.text)}</ins>`))
    .join("");
}

export function describeEvent(ev, statusLabel) {
  switch (ev.type) {
    case "status":
      return `${statusLabel(ev.from)} → ${statusLabel(ev.to)}`;
    case "added":
      return `added${ev.status ? ` (${statusLabel(ev.status)})` : ""}`;
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

export function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
