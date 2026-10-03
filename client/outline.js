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
