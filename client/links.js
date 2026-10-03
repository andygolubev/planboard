export function anchorForHash(hash, state) {
  let id;
  try { id = decodeURIComponent(hash.replace(/^#/, "")); } catch { return null; }
  if (!id) return null;
  const targets = [["sections", "section", "section", "sec-"], ["items", "item", "item", "item-"], ["diagrams", "diagram", "diagram", "diagram-"]];
  // Exact stable IDs take precedence over legacy DOM ID prefixes.
  for (const [key, type, field] of targets) {
    if ((state[key] || []).some(value => value.id === id)) return { type, [field]: id };
  }
  for (const [key, type, field, prefix] of targets) {
    const raw = id.startsWith(prefix) ? id.slice(prefix.length) : null;
    if (raw && (state[key] || []).some(value => value.id === raw)) return { type, [field]: raw };
  }
  return null;
}

export function samePageHash(href, currentUrl) {
  try {
    const current = new URL(currentUrl);
    const target = new URL(href, current);
    return target.origin === current.origin && target.pathname.replace(/\/$/, "") === current.pathname.replace(/\/$/, "") && target.search === current.search ? target.hash : null;
  } catch { return null; }
}
