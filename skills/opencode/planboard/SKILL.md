---
name: planboard
description: Review a Markdown plan with the user on a live Planboard board. Use when the user asks to open a board, discuss plan items, or handle Planboard notes.
---

# planboard for OpenCode

Run `planboard --help` for the current command contract and plan conventions.
Use the plan named by the user; `planboard boards` lists known boards. Create a
new plan without a specified location with `planboard init`: the default is
.planboard/PLAN.md at the repository root, or under the current directory outside Git.
Honor an explicitly chosen path with `planboard init <path>`; keep existing plans
in place. In every command below, replace PLAN.md with the actual chosen plan path.
Edit its concrete tasks and keep existing item and heading {#id} anchors stable
so their threads stay attached.

Open with `planboard PLAN.md`. If browser launch is unavailable, use
`planboard PLAN.md --no-open` and give the user the printed URL. The daemon and
browser must be able to reach each other; follow the environment's permissions
for starting the server, loopback access, and browser launch.

During an active review:

1. Run `planboard poll PLAN.md --timeout 30 --owner "OpenCode"` with the
   `bash` tool. Use the known model and effort in the label only if available;
   do not guess them.
2. Use a foreground command with a tool timeout longer than the poll; shorten
   the poll if needed to fit the tool's limit. Wait for its JSON and completion
   before starting another poll. If your environment returns a tracked command
   handle, collect its output until it exits. Do not detach the poll with `&`
   or assume a background process will wake an ended turn.
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
   that listening has stopped and how to resume; a skill does not keep OpenCode
   running after the turn ends.

For context, use `planboard show PLAN.md` and
`planboard thread PLAN.md <item-id>`. Export with
`planboard export PLAN.md` when the user wants a combined plan and discussion.

OpenCode loads this skill through its native `skill` tool. Use the user's
conversation to choose the plan. Skill, shell, and edit permissions remain under
the session's control; the skill does not grant additional access.
