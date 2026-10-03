---
name: planboard
description: Review a Markdown plan with the user on a live Planboard board. Use when the user asks to open a board, discuss plan items, or handle Planboard notes.
---

# planboard for Codex

Make file changes only by default. Do not create commits or new Git branches,
and do not push changes, unless the user explicitly asks for that Git action.
A plan item, review note, or completed implementation is not permission to commit
or create a branch. Leave Git actions to the user unless explicitly requested.

Run `planboard --help` for the current command contract and plan conventions.
Use the plan named by the user; `planboard boards` lists known boards. Create a
new plan without a specified location with `planboard init`: the default is
.planboard/PLAN.md at the repository root, or under the current directory outside Git.
Honor an explicitly chosen path with `planboard init <path>`; keep existing plans
in place. In every command below, replace PLAN.md with the actual chosen plan path.
Edit its concrete tasks and keep existing item and heading {#id} anchors stable
so their threads stay attached.

Keep sections in their intended reading and execution order. Use one # title,
## for main sections, ### for subsections, and deeper levels only within their
parent; do not skip heading levels. Insert new sections under the correct parent
at the appropriate position. Do not reorder existing sections unless the user
asks or the change requires it. Contents numbering is automatic (1, 1.1, 1.1.1);
do not type numeric prefixes into headings or change stable {#id} anchors.

Open with `planboard PLAN.md`. If browser launch is unavailable, use
`planboard PLAN.md --no-open` and give the user the printed URL. The daemon and
browser must be able to reach each other; follow the environment's permissions
for starting the server, loopback access, and browser launch.

During an active review:

1. Run `planboard poll PLAN.md --timeout 30 --owner "Codex"`. Use the known
   model and effort in the label only if available; do not guess them.
2. Wait for that command's JSON. If the shell tool yields a session id, collect
   its output with the available session wait/input tool until it exits. Do not
   start another poll while it is running. A bounded foreground command works
   when resumable shell sessions are unavailable; shorten the timeout to fit
   the tool's limit. Do not detach the poll with `&` or assume automatic wakeups.
3. On `feedback`, read every note's thread and quick/normal/deep depth. Inspect
   attached images; use sketch feedback to update the plan's Mermaid source.
   Edit PLAN.md directly; the board refreshes on save. Use
   `planboard set PLAN.md <item-id> in_progress` when starting an item and
   `planboard set PLAN.md <item-id> done` after verifying it.
4. Reply to every note with
   `planboard reply PLAN.md --to <note-id> "<answer>"`, then poll again.
   Put detailed answers on the board; keep chat progress updates brief.
5. On `waiting`, re-poll while the requested review is active, checking user
   steering between calls. On `replaced` or `closed`, stop polling. Exit 3
   means another listener owns the board; use `--takeover` only for an intended
   handoff. Stop when the user ends the review. If the turn must end, explain
   that listening has stopped and how to resume; a skill does not keep Codex
   running after the turn ends.

For context, use `planboard show PLAN.md` and
`planboard thread PLAN.md <item-id>`. Export with
`planboard export PLAN.md` when the user wants a combined plan and discussion.
