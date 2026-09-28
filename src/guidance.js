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
  1. Write or update PLAN.md, then run \`planboard <PLAN.md>\` once to open the
     board (it prints the URL; re-running is harmless). The board re-renders
     live on every save, so keep editing the file - never regenerate HTML.
  2. Run \`planboard poll <PLAN.md> --owner "<your model>, effort <level>"\` and
     wait. Start it as a tracked background job when your harness has one (Claude
     Code: run_in_background) so you can keep working and are woken when notes
     arrive; otherwise use a bounded foreground poll (Codex: \`--timeout 30\`) and re-run
     on {"status":"waiting"}. The board shows the owner label next to
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
  planboard init [PLAN.md]             scaffold a plan file with the conventions
  planboard boards                     list boards the server knows
  planboard setup claude [--global] [--hook]
                                       install the Claude Code skill (project or ~/.claude); --hook adds a SessionStart hook
  planboard setup cursor [--global] [--agents-md]
                                       install the same guidance for Cursor (.cursor/skills + .cursor/rules; --agents-md appends to AGENTS.md)
  planboard setup codex [--global]
                                       install the Codex skill in .agents/skills (project or home); preserves AGENTS.md
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
  until it exits before starting another poll. Re-run on "waiting" during an
  active review; do not expect a detached process to wake an ended turn.

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
    `Handle every note (${ids}): read its thread, edit ${planPath} where the plan should change, ` +
    `flip statuses with \`planboard set ${planPath} <item-id> <status>\`, and reply to each with ` +
    `\`planboard reply ${planPath} --to <note-id> "<short answer>"\` so the answer appears next to the item. ` +
    (hints.length ? `Depth and attachments: ${hints.join("; ")}. ` : "") +
    `Then run \`planboard poll ${planPath} --owner "<your model>, effort <level>"\` again (Codex: --timeout 30, collect any yielded shell session before re-polling). Do not repeat the answers in chat.`
  );
}

export const SKILL_MD = `---
name: planboard
description: Review and drive a project plan on a live whiteboard-style board with the user. Use when the user asks for a plan, wants to discuss or track a plan item by item, says "open the board" or "planboard", or when a task is long enough that progress should be visible outside the chat.
---

# planboard

A Markdown plan (PLAN.md with checkbox items and {#id} anchors) rendered as a live
board. The user clicks items, diagram nodes or images and leaves notes; you receive
them with \`planboard poll\`, edit the plan file, and answer with \`planboard reply\`.

Current guidance lives in the CLI, not in this file:

- \`planboard --help\` for the commands, the PLAN.md conventions, note depths and the review loop
- \`planboard show <PLAN.md>\` to see a plan the way the board does, with ids and note counts
- \`planboard thread <PLAN.md> <id>\` to read what was already discussed about an item
- \`planboard export <PLAN.md>\` to write the plan with all threads as one Markdown file

Typical session: \`planboard init PLAN.md\` (or edit an existing one) → \`planboard PLAN.md\`
→ \`planboard poll PLAN.md --owner "<model>, effort <level>"\` → act, \`planboard set\` /
\`planboard reply\` → poll again. Run the poll as a tracked background command (Claude Code:
run_in_background) so you keep working and are woken when notes arrive; if you must run it in
the foreground, pass \`--timeout 540\` and re-run on \`{"status":"waiting"}\`. The owner label is
shown on the board, so the user knows which model and effort will read their notes. Each note
carries a depth (quick · normal · deep) that says how hard to work on it, and may carry
attachments (screenshots, whiteboard sketches) - look at them before answering.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked /planboard explicitly: create or
update the plan they mean, open the board, and start polling. If it is empty, infer
which plan from the conversation (\`planboard boards\` lists known ones).
`;

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
Run: planboard PLAN.md  (open)   planboard poll PLAN.md  (wait for notes)
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

Typical session: \`planboard init PLAN.md\` (or edit an existing one) → \`planboard PLAN.md\`
→ \`planboard poll PLAN.md --owner "<model>, effort <level>"\` → act, \`planboard set\` /
\`planboard reply\` → poll again. If your tool limits command duration, pass \`--timeout 540\`
and re-run on \`{"status":"waiting"}\`. Notes carry a depth (quick · normal · deep) and may
carry attachments (screenshots, whiteboard sketches) - look at them before answering.
`;

export const AGENTS_MD_SECTION = `
## planboard

This project keeps its plan in PLAN.md and reviews it on a live board with the user.
Run \`planboard --help\` for the conventions and the loop; \`planboard show PLAN.md\` shows the
plan with ids and note counts; \`planboard poll PLAN.md --owner "<model>, effort <level>"\`
waits for the user's notes; answer with \`planboard reply\`, flip statuses with \`planboard set\`;
\`planboard export PLAN.md\` writes the plan with all threads for project records.
`;

// Codex discovers .agents/skills at project and home scope. Keep its terminal
// lifecycle separate from Claude Code's background jobs and argument expansion.
export const CODEX_SKILL_MD = `---
name: planboard
description: Review a Markdown plan with the user on a live Planboard board. Use when the user asks to open a board, discuss plan items, or handle Planboard notes.
---

# planboard for Codex

Run \`planboard --help\` for the current command contract and plan conventions.
Use the plan named by the user; \`planboard boards\` lists known boards. Create a
missing plan with \`planboard init PLAN.md\`, then edit its concrete tasks. Keep
existing item and heading {#id} anchors stable so their threads stay attached.

Open with \`planboard PLAN.md\`. If browser launch is unavailable, use
\`planboard PLAN.md --no-open\` and give the user the printed URL. The daemon and
browser must be able to reach each other; follow the environment's permissions
for starting the server, loopback access, and browser launch.

During an active review:

1. Run \`planboard poll PLAN.md --timeout 30 --owner "Codex"\`. Use the known
   model and effort in the label only if available; do not guess them.
2. Wait for that command's JSON. If the shell tool yields a session id, collect
   its output with the available session wait/input tool until it exits. Do not
   start another poll while it is running. A bounded foreground command works
   when resumable shell sessions are unavailable; shorten the timeout to fit
   the tool's limit. Do not detach the poll with \`&\` or assume automatic wakeups.
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
   handoff. Stop when the user ends the review. If the turn must end, explain
   that listening has stopped and how to resume; a skill does not keep Codex
   running after the turn ends.

For context, use \`planboard show PLAN.md\` and
\`planboard thread PLAN.md <item-id>\`. Export with
\`planboard export PLAN.md\` when the user wants a combined plan and discussion.
`;
