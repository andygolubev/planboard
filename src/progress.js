// Execution progress excludes questions and cancelled work. Keep the original
// status counts in the API/history; this projection is only for progress displays.
export function executionCounts(counts = {}) {
  const { todo = 0, in_progress = 0, done = 0, blocked = 0 } = counts || {};
  return { todo, in_progress, done, blocked, total: todo + in_progress + done + blocked };
}
