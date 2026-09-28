---
name: planboard
description: Review and drive a project plan on a live whiteboard-style board with the user. Use when the user asks for a plan, wants to discuss or track a plan item by item, says "open the board" or "planboard", or when a task is long enough that progress should be visible outside the chat.
---

# planboard

A Markdown plan (PLAN.md with checkbox items and {#id} anchors) rendered as a live
board. The user clicks items, diagram nodes or images and leaves notes; you receive
them with `planboard poll`, edit the plan file, and answer with `planboard reply`.

Current guidance lives in the CLI, not in this file:

- `planboard --help` for the commands, the PLAN.md conventions, note depths and the review loop
- `planboard show <PLAN.md>` to see a plan the way the board does, with ids and note counts
- `planboard thread <PLAN.md> <id>` to read what was already discussed about an item
- `planboard export <PLAN.md>` to write the plan with all threads as one Markdown file

Typical session: `planboard init PLAN.md` (or edit an existing one) → `planboard PLAN.md`
→ `planboard poll PLAN.md --owner "<model>, effort <level>"` → act, `planboard set` /
`planboard reply` → poll again. Run the poll as a tracked background command (Claude Code:
run_in_background) so you keep working and are woken when notes arrive; if you must run it in
the foreground, pass `--timeout 540` and re-run on `{"status":"waiting"}`. The owner label is
shown on the board, so the user knows which model and effort will read their notes. Each note
carries a depth (quick · normal · deep) that says how hard to work on it, and may carry
attachments (screenshots, whiteboard sketches) - look at them before answering.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked /planboard explicitly: create or
update the plan they mean, open the board, and start polling. If it is empty, infer
which plan from the conversation (`planboard boards` lists known ones).
