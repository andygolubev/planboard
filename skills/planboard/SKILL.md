---
name: planboard
description: Review a Markdown plan with the user on a live Planboard board. Use when the user asks to open a board, discuss plan items, or handle Planboard notes.
---

# planboard for Claude Code

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

1. Run `planboard poll PLAN.md --owner "Claude Code"` using Bash's tracked
   background facility (`run_in_background`) when available. Use the known
   model and effort in the label only if available; do not guess them.
2. Keep the returned task id and collect that task's output when it completes;
   read the JSON before starting another poll. Do not detach it with `&`.
   If background tasks are unavailable, use a foreground poll with
   `--timeout 540` and a Bash timeout longer than the poll, or shorten the poll
   to fit the tool's limit. A SessionStart hook only lists boards; it does not
   run the review loop.
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
   handoff. Stop when the user ends the review. Stop any tracked poll when ending
   the review. If the session or background task stops, explain that listening
   has stopped and how to resume; a skill cannot keep a closed session running.

For context, use `planboard show PLAN.md` and
`planboard thread PLAN.md <item-id>`. Export with
`planboard export PLAN.md` when the user wants a combined plan and discussion.

## Request

$ARGUMENTS

Use the request above when /planboard was invoked with arguments. Otherwise use
the plan named in the conversation; `planboard boards` lists known boards.
