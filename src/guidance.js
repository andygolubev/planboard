// Everything the agent is told, in one place. `planboard --help` is the contract;
// installable skills point here for the command contract, with harness-specific
// polling guidance where needed.

export const CONVENTIONS = `PLAN.md conventions
  - Headings are sections. Items are Markdown list items. Both may end with {#id}
    (letters, digits, - _ . :). Ids are the anchors that threads and the status
    log key on, so give every item and heading a short stable {#id} and never
    rename one when rewording.
  - An item's status is its checkbox: [ ] todo · [~] in progress · [x] done ·
    [!] blocked · [?] needs a decision from the user · [-] dropped.
    Plain bullets (no checkbox) are notes, not tracked items.
  - \`\`\`mermaid <id> fences become clickable diagrams (flowchart, sequence,
    state, class, ER...). Node ids in the diagram are what the user clicks on.
  - ![caption](relative/path.png) images render and can be pinned at a point.
  - Front matter (--- title: ... ---) is optional; the first # heading is the title.
  - Preserve section order and hierarchy: one # title, ## main sections, ###
    subsections. Do not skip levels. Insert new sections under the correct parent
    in the intended reading/execution order. Reorder only when requested or needed
    by the change. Contents numbering is automatic; do not number heading text
    manually or rename stable {#id} anchors.
  - Everything else is ordinary Markdown; raw HTML/SVG passes through.`;

export const DEPTH_GUIDE = `Note depth (the user picks it per note: quick · normal · deep)
  quick   answer from what you already know in one or two sentences; only trivial
          edits (a status flip, a one-line rewording); no investigation.
  normal  the default: read the thread and the relevant files, make the change,
          verify it, reply briefly.
  deep    take your time: research the code and docs, weigh alternatives, implement
          and verify thoroughly, and explain the reasoning and trade-offs in the reply
          (Markdown, a few short paragraphs or bullets). Depth is about how hard to
          work on that note, not which model runs: the model and effort are the
          settings of the session that runs \`planboard poll\` (configured in the agent harness).`;

export const WORKFLOW = `Review loop
  Make file changes only by default. Do not create commits or new Git branches,
  and do not push changes, unless the user explicitly asks for that Git action.
  A plan item, review note, or completed implementation is not permission to commit
  or create a branch. Leave Git actions to the user unless explicitly requested.
  Plan location: honor an explicit path or continue using an existing plan. For a new
  plan without a specified path, run \`planboard init\`: it creates .planboard/PLAN.md
  at the repository root (current directory outside Git). In commands below,
  PLAN.md means the chosen plan path; always pass that actual path.
  1. Write or update PLAN.md, then run \`planboard <PLAN.md>\` once to open the
     board (it prints the URL; re-running is harmless). The board re-renders
     live on every save, so keep editing the file - never regenerate HTML.
  2. Run \`planboard poll <PLAN.md> --owner "<your model>, effort <level>"\` and
     wait. Start it as a tracked background job when your harness has one (Claude
     Code: run_in_background) so you can keep working and are woken when notes
     arrive; otherwise use a bounded foreground poll (Codex, Cursor, OpenCode:
     \`--timeout 30\`) and re-run on {"status":"waiting"}.
     The board shows the owner label next to
     "agent is listening", so the user knows which model and effort will read
     their notes. The poll returns when the user sends notes: each note carries
     its anchor (item / section / diagram node / image / quoted text), its depth,
     the current item text and status, the whole thread on that item so far, and
     the paths of any attached files. Read the thread before answering.
  3. Act on each note at the depth it asks for: edit PLAN.md (rewrite the item,
     split it, add items, change a diagram), flip statuses with
     \`planboard set <PLAN.md> <item-id> <status>\` as work actually lands, and
     answer every note with \`planboard reply <PLAN.md> --to <note-id> "<answer>"\`
     (Markdown allowed; keep it short - the reply shows up next to the item on the
     board). Then poll again. Do not narrate the same content in chat: the board
     is the conversation.
  4. Attachments: a note may carry screenshots the user pasted or a whiteboard
     sketch ("kind": "sketch"). Look at every attached image with your image
     reader before answering. A sketch note's text lists what the user added,
     removed, moved or relabeled on the diagram; the .excalidraw file is the
     exact scene. Update the mermaid source in PLAN.md to match the intent.
  5. When implementing the plan, mark an item [~] when you start and [x] when
     it is done and verified; use [!] with a reply explaining the blocker and
     [?] when you need the user to decide. The user sees the board update as
     you work, like a whiteboard at a daily stand-up.
  Never rename ids. Prefer many small items over one vague one.`;

export function helpText({ version }) {
  return `planboard ${version} - a whiteboard for agent plans.

Renders a Markdown plan as a live board in the browser. The user clicks an item,
heading, diagram node or image, writes a note, and sends; the agent receives the
notes with the item's thread through a long poll, edits the plan file, and
replies next to the item. Notes, replies and the status history persist beside
the plan, so the same board serves the whole project day after day.

Commands
  planboard <PLAN.md> [--no-open]      open (or re-open) the board; prints its URL
  planboard poll <PLAN.md> [--timeout <sec>] [--owner <label>] [--takeover]
                                       wait for notes; prints JSON (see below). --owner is shown on the board:
                                       use a descriptive label, e.g. --owner "Review agent"
  planboard reply <PLAN.md> [--to <note-id> | --item <id> | --section <id>] "<text>"
                                       answer on the board (Markdown; --file <path> or - for stdin)
  planboard set <PLAN.md> <item-id> <status>
                                       flip an item: todo | in_progress | done | blocked | question | dropped
  planboard show <PLAN.md> [--json]    print the plan as the board sees it: ids, statuses, note counts
  planboard thread <PLAN.md> <id|board>
                                       print the conversation on one item/section (or the whole board)
  planboard notes <PLAN.md> [--pending]
                                       list notes; --pending = sent but not yet delivered
  planboard export <PLAN.md> [--out <file>]
                                       the plan with every thread folded in under its item plus the status
                                       history, as one Markdown file (stdout unless --out) - for project records
  planboard lint <PLAN.md>             report items without ids, duplicate ids
  planboard init [path]                scaffold a plan; default: <repo>/.planboard/PLAN.md
                                       outside Git: <cwd>/.planboard/PLAN.md; explicit paths are honored
  planboard boards                     list boards the server knows
  planboard setup claude [--global] [--hook]
                                       install the Claude Code skill (project or ~/.claude); --hook adds a SessionStart hook
  planboard setup cursor [--global] [--agents-md]
                                       install the Cursor skill (.cursor/skills + project .cursor/rules; --agents-md appends to AGENTS.md)
  planboard setup codex [--global]
                                       install the Codex skill in .agents/skills (project or home); preserves AGENTS.md
  planboard setup opencode [--global]
                                       install the OpenCode skill in .opencode/skills (global: ~/.config/opencode/skills); preserves AGENTS.md and configuration
                                       global installs respect XDG_CONFIG_HOME and OPENCODE_CONFIG_DIR
  planboard server | stop              run the local server in the foreground | stop it

Poll output (JSON on stdout)
  { "status": "feedback", "notes": [ { "id", "at", "depth", "anchor", "text", "quote", "kind",
      "attachments": [ { "path", "type", "bytes" } ],
      "item": { "id", "text", "status", "section" }, "thread": [ ...earlier notes and replies... ] } ],
    "plan": { "path", "counts" }, "next_step": "..." }
  { "status": "waiting" }     only with --timeout, when nothing arrived in time
  Delivery is at-least-once: a poll that dies before printing leaves the notes
  pending, so re-running it is always safe. A second concurrent poll on the same
  plan is refused (exit 3) unless --takeover is passed.
  Claude Code: use a tracked background poll (run_in_background), or --timeout 540.
  Codex: use --timeout 30; if the shell yields a session id, collect that session
  until it exits before starting another poll.
  Cursor and OpenCode: use --timeout 30 in the foreground, within the shell tool's
  time limit. Collect any tracked command's output before starting another poll.
  Re-run on "waiting" during an active review; do not expect a detached process
  to wake an ended turn.
  Stop on "replaced" or "closed". Use --takeover only for an intended handoff.

State
  <stem>.board/ beside the plan holds notes.json (the conversation), events.jsonl
  (status history), snapshot.json and attachments/ (pasted screenshots, whiteboard
  sketches as PNG + .excalidraw); it is meant to be committed with the plan.
  planboard writes <stem>.board/.gitignore to keep the machine-local visits.json
  and the autosaved whiteboards/ working scenes out.

${CONVENTIONS}

${DEPTH_GUIDE}

${WORKFLOW}

Environment
  PLANBOARD_PORT (4747)  PLANBOARD_HOST (127.0.0.1; set 0.0.0.0 to reach it from another machine)
  PLANBOARD_HOME (~/.planboard)  PLANBOARD_STATE_DIR (keep <stem>.board/ dirs under one root instead of beside each plan)
  PLANBOARD_NO_OPEN=1 (never launch a browser)
`;
}

export function openNextStep(planPath) {
  return (
    `The board is open. Now run \`planboard poll ${planPath} --owner "<your model>, effort <level>"\` and wait for the user's notes ` +
    `(it blocks until they press Send; use a tracked command when supported, or --timeout 30 and re-run on "waiting" during the active review). ` +
    `Keep editing ${planPath} as the plan evolves - the board re-renders on save. ` +
    `Answer each note with \`planboard reply ${planPath} --to <note-id> "..."\`, flip statuses with \`planboard set ${planPath} <item-id> <status>\`, then poll again.`
  );
}

export function feedbackNextStep(planPath, notes) {
  const ids = notes.map((n) => n.id).join(", ");
  const depths = new Set(notes.map((n) => n.depth || "normal"));
  const hints = [];
  if (depths.has("quick")) hints.push("quick notes: answer in one or two sentences from what you know, trivial edits only, no investigation");
  if (depths.has("deep")) hints.push("deep notes: research properly, weigh alternatives, implement and verify, and explain the reasoning in the reply");
  if (notes.some((n) => n.attachments && n.attachments.length)) hints.push("some notes carry attachments: look at each attached image (its path is in the note) before answering");
  if (notes.some((n) => n.kind === "sketch")) hints.push("a sketch note is the user's whiteboard edit of a diagram: its text lists what moved, the PNG shows it, the .excalidraw file is the exact scene - change the mermaid source in the plan to match");
  return (
    `Modify files only; do not create commits, create branches, or push unless the user explicitly requests that Git action. ` +
    `Handle every note (${ids}): read its thread, edit ${planPath} where the plan should change, ` +
    `flip statuses with \`planboard set ${planPath} <item-id> <status>\`, and reply to each with ` +
    `\`planboard reply ${planPath} --to <note-id> "<short answer>"\` so the answer appears next to the item. ` +
    (hints.length ? `Depth and attachments: ${hints.join("; ")}. ` : "") +
    `Then run \`planboard poll ${planPath} --owner "<your model>, effort <level>"\` again (Codex, Cursor, OpenCode: --timeout 30; collect any tracked command's output before re-polling). Do not repeat the answers in chat.`
  );
}

export const PLAN_TEMPLATE = (title) => `---
title: ${title}
---

# ${title} {#plan}

Goal: one paragraph on what this plan achieves and how you will know it is done.

## Context {#context}

- Current state, constraints, and the decision that started this work.

## Milestone 1 {#m1}

- [ ] First concrete, verifiable item {#m1-first}
- [ ] Second item {#m1-second}
  - [ ] Sub-item, if the parent needs breaking down {#m1-second-a}
- [?] Something the user must decide {#m1-decide}

## Architecture {#arch}

\`\`\`mermaid arch
flowchart LR
  A[Component A] --> B[Component B]
  B --> C[(Store)]
\`\`\`

## Risks and open questions {#risks}

- [!] A known blocker, with who or what unblocks it {#risk-1}

<!--
Conventions: [ ] todo · [~] in progress · [x] done · [!] blocked · [?] decision · [-] dropped.
Every item and heading ends with {#id}; ids never change once discussed.
Run: planboard <path-to-this-file>  (open)   planboard poll <path-to-this-file>  (wait for notes)
-->
`;

// Cursor reads project rules from .cursor/rules/*.mdc and Agent Skills from
// .cursor/skills/<name>/SKILL.md. The rule is a pointer, like the skill.
export const CURSOR_RULE_MDC = `---
description: planboard - review and drive the project plan on a live board with the user. Use when the user mentions the plan, the board or planboard, asks to discuss or track a plan item by item, or when a task is long enough that progress should be visible outside the chat.
alwaysApply: false
---

# planboard

A Markdown plan (PLAN.md with checkbox statuses and {#id} anchors) rendered as a live board.
The user clicks items, diagram nodes or images and leaves notes; you receive them with
\`planboard poll\`, edit the plan file, and answer with \`planboard reply\`.

Current guidance lives in the CLI, not in this file:

- \`planboard --help\` for the commands, the PLAN.md conventions, note depths and the review loop
- \`planboard show <PLAN.md>\` to see a plan the way the board does, with ids and note counts
- \`planboard thread <PLAN.md> <id>\` to read what was already discussed about an item
- \`planboard export <PLAN.md>\` to write the plan with all threads as one Markdown file

For new plans without an explicit path, run \`planboard init\` to create
.planboard/PLAN.md at the repository root (current directory outside Git). Honor
explicit paths and keep existing plans in place. Replace PLAN.md below with the
actual chosen plan path.

Make file changes only by default. Do not create commits or new Git branches,
and do not push changes, unless the user explicitly asks for that Git action.
A plan item, review note, or completed implementation is not permission to commit
or create a branch. Leave Git actions to the user unless explicitly requested.

Use the planboard skill for the full review loop. Poll with
\`planboard poll PLAN.md --timeout 30 --owner "Cursor"\` in the foreground, shortening
the timeout if needed to fit the terminal tool's limit. Collect any tracked command's
output before starting another poll. On \`feedback\`, read each note's thread, depth
and attachments, edit the plan, update statuses, and reply to every note. Re-poll on
\`waiting\` during the active review; stop on \`replaced\`, \`closed\`, or when the user
ends the review. A detached process does not keep an ended turn listening.
`;

export const AGENTS_MD_SECTION = `
## planboard

This project reviews its Markdown plan on a live board with the user.
Make file changes only by default. Do not create commits or new Git branches,
and do not push changes, unless the user explicitly asks for that Git action.
A plan item, review note, or completed implementation is not permission to commit
or create a branch. Leave Git actions to the user unless explicitly requested.
For a new plan, use \`planboard init\` to create .planboard/PLAN.md at the repository
root. Honor explicitly chosen paths and keep existing plans in their current location.
In the commands below, replace PLAN.md with the actual chosen path.
Keep sections in their intended reading and execution order. Use one # title,
## for main sections, ### for subsections, and deeper levels only within their
parent; do not skip heading levels. Insert new sections under the correct parent
at the appropriate position. Do not reorder existing sections unless the user
asks or the change requires it. Contents numbering is automatic (1, 1.1, 1.1.1);
do not type numeric prefixes into headings or change stable {#id} anchors.
Run \`planboard --help\` for the conventions and the loop; \`planboard show PLAN.md\` shows the
plan with ids and note counts; \`planboard poll PLAN.md --owner "<model>, effort <level>"\`
waits for the user's notes; answer with \`planboard reply\`, flip statuses with \`planboard set\`;
\`planboard export PLAN.md\` writes the plan with all threads for project records.
`;

// Share the board workflow, but keep each host's command lifecycle and invocation
// syntax explicit. Packaged SKILL.md files mirror these installer payloads.
function reviewSkill(host, polling, request = "", listenerEnd = `If the turn must end, explain
   that listening has stopped and how to resume; a skill does not keep ${host}
   running after the turn ends.`) {
  return `---
name: planboard
description: Review a Markdown plan with the user on a live Planboard board. Use when the user asks to open a board, discuss plan items, or handle Planboard notes.
---

# planboard for ${host}

Make file changes only by default. Do not create commits or new Git branches,
and do not push changes, unless the user explicitly asks for that Git action.
A plan item, review note, or completed implementation is not permission to commit
or create a branch. Leave Git actions to the user unless explicitly requested.

Run \`planboard --help\` for the current command contract and plan conventions.
Use the plan named by the user; \`planboard boards\` lists known boards. Create a
new plan without a specified location with \`planboard init\`: the default is
.planboard/PLAN.md at the repository root, or under the current directory outside Git.
Honor an explicitly chosen path with \`planboard init <path>\`; keep existing plans
in place. In every command below, replace PLAN.md with the actual chosen plan path.
Edit its concrete tasks and keep existing item and heading {#id} anchors stable
so their threads stay attached.

Keep sections in their intended reading and execution order. Use one # title,
## for main sections, ### for subsections, and deeper levels only within their
parent; do not skip heading levels. Insert new sections under the correct parent
at the appropriate position. Do not reorder existing sections unless the user
asks or the change requires it. Contents numbering is automatic (1, 1.1, 1.1.1);
do not type numeric prefixes into headings or change stable {#id} anchors.

Open with \`planboard PLAN.md\`. If browser launch is unavailable, use
\`planboard PLAN.md --no-open\` and give the user the printed URL. The daemon and
browser must be able to reach each other; follow the environment's permissions
for starting the server, loopback access, and browser launch.

During an active review:

${polling}
3. On \`feedback\`, read every note's thread and quick/normal/deep depth. Inspect
   attached images; use sketch feedback to update the plan's Mermaid source.
   Edit PLAN.md directly; the board refreshes on save. Use
   \`planboard set PLAN.md <item-id> in_progress\` when starting an item and
   \`planboard set PLAN.md <item-id> done\` after verifying it.
4. Reply to every note with
   \`planboard reply PLAN.md --to <note-id> "<answer>"\`, then poll again.
   Put detailed answers on the board; keep chat progress updates brief.
5. On \`waiting\`, re-poll while the requested review is active, checking user
   steering between calls. On \`replaced\` or \`closed\`, stop polling. Exit 3
   means another listener owns the board; use \`--takeover\` only for an intended
   handoff. Stop when the user ends the review. ${listenerEnd}

For context, use \`planboard show PLAN.md\` and
\`planboard thread PLAN.md <item-id>\`. Export with
\`planboard export PLAN.md\` when the user wants a combined plan and discussion.
${request}`;
}

export const SKILL_MD = reviewSkill("Claude Code", `1. Run \`planboard poll PLAN.md --owner "Claude Code"\` using Bash's tracked
   background facility (\`run_in_background\`) when available. Use the known
   model and effort in the label only if available; do not guess them.
2. Keep the returned task id and collect that task's output when it completes;
   read the JSON before starting another poll. Do not detach it with \`&\`.
   If background tasks are unavailable, use a foreground poll with
   \`--timeout 540\` and a Bash timeout longer than the poll, or shorten the poll
   to fit the tool's limit. A SessionStart hook only lists boards; it does not
   run the review loop.`, `
## Request

$ARGUMENTS

Use the request above when /planboard was invoked with arguments. Otherwise use
the plan named in the conversation; \`planboard boards\` lists known boards.
`, `Stop any tracked poll when ending
   the review. If the session or background task stops, explain that listening
   has stopped and how to resume; a skill cannot keep a closed session running.`);

export const CODEX_SKILL_MD = reviewSkill("Codex", `1. Run \`planboard poll PLAN.md --timeout 30 --owner "Codex"\`. Use the known
   model and effort in the label only if available; do not guess them.
2. Wait for that command's JSON. If the shell tool yields a session id, collect
   its output with the available session wait/input tool until it exits. Do not
   start another poll while it is running. A bounded foreground command works
   when resumable shell sessions are unavailable; shorten the timeout to fit
   the tool's limit. Do not detach the poll with \`&\` or assume automatic wakeups.`);

export const CURSOR_SKILL_MD = reviewSkill("Cursor", `1. Run \`planboard poll PLAN.md --timeout 30 --owner "Cursor"\` in the terminal
   tool. Use the known model and effort in the label only if available; do not
   guess them.
2. Use a foreground command and keep the poll timeout shorter than the terminal
   tool's limit. If the tool returns a tracked command or terminal handle,
   collect that command's output until it exits before starting another poll.
   Read its JSON result. Do not detach the poll with \`&\` or assume that a
   background terminal will wake the agent after its turn ends.`);

export const OPENCODE_SKILL_MD = reviewSkill("OpenCode", `1. Run \`planboard poll PLAN.md --timeout 30 --owner "OpenCode"\` with the
   \`bash\` tool. Use the known model and effort in the label only if available;
   do not guess them.
2. Use a foreground command with a tool timeout longer than the poll; shorten
   the poll if needed to fit the tool's limit. Wait for its JSON and completion
   before starting another poll. If your environment returns a tracked command
   handle, collect its output until it exits. Do not detach the poll with \`&\`
   or assume a background process will wake an ended turn.`, `
OpenCode loads this skill through its native \`skill\` tool. Use the user's
conversation to choose the plan. Skill, shell, and edit permissions remain under
the session's control; the skill does not grant additional access.
`);
