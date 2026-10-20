// Number the source outline, independent of where disclosures place its content.
export function numberedSections(sections) {
  const hasTitle = sections[0]?.level === 1 && sections.slice(1).every(s => s.level > 1);
  const stack = [];
  let rootCount = 0;
  return sections.map((section, index) => {
    if (hasTitle && index === 0) return { ...section, number: "", depth: 0, displayTitle: section.title };
    while (stack.length && stack.at(-1).level >= section.level) stack.pop();
    const parent = stack.at(-1);
    const count = parent ? ++parent.children : ++rootCount;
    const number = parent ? `${parent.number}.${count}` : String(count);
    const depth = stack.length;
    stack.push({ level: section.level, number, children: 0 });
    // Older plans may contain manually numbered headings. Avoid duplicate labels.
    const displayTitle = section.title.replace(/^(?:\d+(?:\.\d+)*[.)]|\d+(?:\.\d+)+)\s+/, "");
    return { ...section, number, depth, displayTitle };
  });
}

// Use the heading nearest the reading edge, including the final short section
// when the reader reaches the bottom of a long document.
export function readingSection(headings, { top, height, scrollTop, scrollHeight }) {
  if (!headings.length) return null;
  if (scrollTop > 0 && scrollHeight > height + 2 && scrollTop + height >= scrollHeight - 2) return headings.at(-1).id;
  let current = headings[0].id;
  for (const heading of headings) {
    if (heading.top > top + 32) break;
    current = heading.id;
  }
  return current;
}
