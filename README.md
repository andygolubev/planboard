# planboard

A whiteboard for AI-agent plans.

The plan is a Markdown file the agent edits. planboard renders it as a live board in the
browser: you click an item, a heading, a node in a diagram or a spot on an image, write a
note, and press **Send**. The agent receives the notes - with everything already said about
that item - through a long poll, edits the plan, flips statuses as work lands, and answers
next to the item. Notes, replies and the status history persist beside the plan, so the same
board serves the whole project day after day. The plan is the conversation; the chat log is not.

![planboard showing the fictional community garden example](docs/board.jpg)

## Why

Reviewing a long plan in a chat transcript means scrolling up and down, re-reading, and
holding the chain of thought in your head. A whiteboard does that for you: every item shows
its status, every discussion hangs off the thing it is about, and "what moved since
yesterday" is a glance. planboard is that whiteboard, built for one person and their coding
agent.

It is modelled on [lavish-axi](https://github.com/kunchenguid/lavish-axi) - an
agent-operated review loop for HTML artifacts - but keeps the plan in Markdown, tracks item
status, threads the conversation per item, and remembers across days. See
`THIRD-PARTY-NOTICES.md` for what was borrowed.

## Install

```sh
git clone <this repo> planboard && cd planboard
npm install && npm run build     # browser bundle (Mermaid, ~3 MB) + the Excalidraw whiteboard frame (~8 MB, from lavish-axi)
npm link                          # puts `planboard` on your PATH
planboard setup claude --global   # installs the /planboard skill for Claude Code
planboard setup codex             # installs the planboard skill for Codex in .agents/skills
planboard setup cursor            # installs the Cursor skill and project rule (.cursor/skills + .cursor/rules)
planboard setup opencode          # installs the OpenCode skill in .opencode/skills
```

Node 22 or newer. Everything runs locally; the only network use is your browser talking to
`127.0.0.1:4747`. The whiteboard frame is copied from the `lavish-axi` dev dependency at build
time; without it the board simply has no whiteboard button.

## The plan file

Run `planboard init` to create `.planboard/PLAN.md` at the repository root, even
from a subdirectory. Outside Git, it uses `.planboard/PLAN.md` in the current
directory. The folder is created automatically. To choose another location, run
`planboard init docs/launch.md`; explicit relative paths resolve from the current
directory, and absolute paths are also supported. Existing plans stay where they are.

Open the default plan with `planboard .planboard/PLAN.md` from the repository root.
In the examples below, replace `PLAN.md` with your actual plan path.
Notes and history live beside the plan by default, so the default plan uses
`.planboard/PLAN.board/`. `PLANBOARD_STATE_DIR` still overrides the history location.

Ordinary Markdown plus three conventions:

````markdown
# Auth rollout {#plan}

## Phase 1 {#p1}

- [x] Login endpoint {#p1-login}
- [~] Rate limiting on /token {#p1-rate}
  - [ ] Bucket config {#p1-rate-cfg}
- [!] Audit log - blocked on the logging vendor {#p1-audit}
- [?] Keep basic auth for legacy clients? {#p1-legacy}
- [-] Dropped: per-tenant keys {#p1-tenant}

```mermaid arch
flowchart LR
  C[Client] --> G[Gateway] --> A[Auth service]
```

![Login mock](mocks/login.png)
````

| Convention | Meaning |
| --- | --- |
| `[ ]` `[~]` `[x]` `[!]` `[?]` `[-]` | to do · in progress · done · blocked · needs a decision · dropped |
| `{#id}` at the end of an item, heading or fence info | the stable anchor threads and history key on; never rename one |
| ```` ```mermaid <id> ```` | a clickable diagram; you can note on a single node |
| `![…](relative/path.png)` | an image you can pin a note to at a point |

Plain bullets without a checkbox are notes, not tracked items. Raw HTML/SVG passes through.
`planboard lint PLAN.md` reports items without ids and duplicate ids; `planboard init` scaffolds
a plan with the conventions in a comment.

## The loop

```
you                                  agent
────────────────────────────────     ──────────────────────────────────────
                                     planboard PLAN.md          → board URL
open the board
click an item · write note · Send    planboard poll PLAN.md     → JSON: notes + item + thread
                                     edit PLAN.md, planboard set <id> <status>
board re-renders live                planboard reply PLAN.md --to <note-id> "…"
read the reply next to the item      planboard poll PLAN.md …
```

- **Board** (left): the plan. Green check = done, half amber = in progress, red `!` = blocked,
  purple `?` = needs your decision. Section headers carry a stacked progress bar. The **Contents** sidebar jumps to sections
  and shows progress and section discussion counts. Contents numbers follow the
  Markdown heading order automatically: `1`, `1.1`, `1.1.1`. The document title
  is unnumbered. Use `##` for main sections and `###` for subsections; keep sections
  in their intended order and do not type numbers into heading titles. Each second-level section has
  independently expandable **Solution details** and **Tasks**; opening another section’s
  details closes the previous one. **Expand all / Collapse all** controls the full outline.
  **Discuss this section** opens its attached conversation. Expansion choices are saved
  per board, and selecting a hidden item reveals its containing group.
  Items with notes carry a count badge (dashed = not sent yet, filled = waiting for the agent,
  green = agent answered last, 📎 = attachments). Items that changed since your last visit get a
  coloured left rail and a tag drawing the move (old-status dot → new-status dot). The thin
  **ruler** on the right edge is a minimap of where the changes and notes are along the whole
  plan - click a tick to jump.
- **Panel** (right): the thread on whatever you selected - an item, a heading, a diagram node, an
  image point, a text selection, or the whole plan. **Activity** is everything in time order with
  day separators; **Changes** is the review view (below).
- **Composer**: Enter adds a note (it stays "not sent" until you press **Send**, so you can walk
  the whole plan first); ⌘/Ctrl+Enter adds and sends; Esc goes back to the whole plan. You can
  also flip an item's status yourself from the panel. Paste or drop a
  screenshot (or use 📎) to attach it: it is stored beside the plan and shown in the thread.
- **Top bar**: the stacked status bar, the changes chip, **Export**, and agent presence - *no agent
  listening*, *agent is listening* (a poll is attached), *agent is working on your notes*
  (delivered, no reply yet). The listening agent's `--owner` label is shown next to it, so you can
  see which model and effort level will read your notes: that is decided by the agent session that
  runs the poll, not by planboard, which never calls a model itself.
- **Keyboard**: `j`/`k` move between items, `Enter` opens the thread and the note box, `Esc` goes
  back to the whole plan, `n`/`p` walk through the changes, `1`/`2`/`3` switch tabs, `?` shows the cheat sheet.
- **Phone**: under 900 px the panel is a bottom sheet - tap an item to open it, swipe it down with
  the handle or Esc.

### Reviewing what changed

![the Changes tab: status flow, timeline, section deltas and change cards](docs/changes.jpg)

The **Changes** tab is drawn, not listed, so a morning catch-up is a glance:

- a **flow chart**: the item statuses at your last visit and now as two stacked bars, with a band
  per movement between them (to do → in progress, in progress → done, added, removed), unchanged
  items faint;
- a **timeline** of when the changes happened;
- **per-section deltas**: done count then → now, newly done items highlighted, started items in
  amber;
- one **card per changed element**, in plan order: status pills with arrows, `added` / `removed`
  tags, a word diff for rewordings, and for diagrams a **Show before** switch that redraws the
  previous version of the diagram on the board itself;
- a **walk-through** (‹ › or `n`/`p`) that steps through the changes, highlighting each on the
  board.

### Whiteboard

Every Mermaid diagram has a **✎ Whiteboard** button (also in the panel when a diagram or node is
selected). It opens the diagram converted to an editable Excalidraw scene - lavish-axi's built
frame - where you move boxes, add arrows, write on it. **Queue feedback** in the frame turns the
edits into a note on the diagram: a list of what you added, removed, moved or relabeled, a PNG of
the sketch and the `.excalidraw` scene, stored in `PLAN.board/attachments/`. You send it like any
other note; the agent reads the summary, looks at the picture, and changes the Mermaid source.
The working scene autosaves per diagram, so re-opening continues where you left off.

The agent's command contract is `planboard --help`. Installed skills point there and add
guidance for their host's polling tools.

## CLI

| Command | What it does |
| --- | --- |
| `planboard <PLAN.md> [--no-open]` | open or re-open the board (starts the local server if needed); prints the URL and the agent's next step |
| `planboard poll <PLAN.md> [--timeout <sec>] [--owner <label>] [--takeover]` | wait for notes; prints JSON `{status: "feedback", notes: [{id, depth, anchor, text, quote?, kind?, attachments?: [{path, type, bytes}], item, thread}], plan, next_step}` or `{status: "waiting"}` after the timeout |
| `planboard reply <PLAN.md> [--to <note-id> \| --item <id> \| --section <id>] "text"` | answer on the board (Markdown; `--file <path>` or `--file -` for stdin) |
| `planboard set <PLAN.md> <item-id> <status>` | flip a checkbox in the file: `todo`, `in_progress`, `done`, `blocked`, `question`, `dropped` (aliases `wip`, `x`, … work) |
| `planboard show <PLAN.md> [--json]` | the plan as the board sees it: ids, statuses, note counts, pending notes |
| `planboard thread <PLAN.md> <id \| diagram/node \| board>` | one conversation |
| `planboard notes <PLAN.md> [--pending]` | all notes, or only those sent and not yet delivered |
| `planboard export <PLAN.md> [--out <file>]` | the plan with every thread folded in as a blockquote under its item, heading, diagram or image, plus the status history - one Markdown file for project records (stdout unless `--out`; also the **Export** button on the board) |
| `planboard lint <PLAN.md>` | missing / duplicate ids |
| `planboard init [PLAN.md] [--title …]` | scaffold a plan |
| `planboard boards` | boards the server knows, with progress and pending notes |
| `planboard setup claude [--global] [--hook]` | install the Claude Code skill; `--hook` adds a SessionStart hook that lists boards |
| `planboard setup cursor [--global] [--agents-md]` | install the Cursor skill in `.cursor/skills/planboard/SKILL.md` plus a project rule `.cursor/rules/planboard.mdc`; `--global` installs the skill in `~/.cursor/skills`; `--agents-md` appends a section to the current project's `AGENTS.md` |
| `planboard setup codex [--global]` | install the Codex skill in `.agents/skills/planboard/SKILL.md`, or `~/.agents/skills/planboard/SKILL.md` with `--global`; preserves existing `AGENTS.md` files |
| `planboard setup opencode [--global]` | install the OpenCode skill in `.opencode/skills/planboard/SKILL.md`, or the OpenCode config directory's `skills/planboard/SKILL.md` with `--global` (default `~/.config/opencode`); preserves instructions and configuration |
| `planboard server` / `planboard stop` | run the server in the foreground / stop the daemon |

Poll delivery is at-least-once: notes are marked delivered only after the response is written,
so a poll that dies before printing leaves them pending and re-running is safe. One poll per
board at a time; a second one exits 3 with `LISTENER_ACTIVE` unless it passes `--takeover`.

## Agent support

### Claude Code

Run `planboard setup claude` from the project directory (or add `--global` for all projects).
Invoke `/planboard` or `/planboard PLAN.md`, or ask Claude Code to use planboard. Start a new
session if the skill does not appear.

The installer follows the official [Claude Code skill conventions](https://code.claude.com/docs/en/skills):
YAML `name` and `description` front matter in `.claude/skills/planboard/SKILL.md`, or
`~/.claude/skills/planboard/SKILL.md` with `--global`. The skill uses Claude's `$ARGUMENTS`
substitution for explicit requests. Setup preserves existing `CLAUDE.md` instructions and
settings by default. The optional `--hook` adds a `SessionStart` hook to the corresponding
`.claude/settings.json`, preserving other settings and avoiding duplicate hooks. It runs
`planboard boards --brief` to list boards; it does not start a listener.

The skill opens the board, polls with `--owner "Claude Code"`, reads notes and attachments,
edits the Markdown, updates task statuses, replies to each note, and polls again. It uses
Claude Code's [tracked background commands](https://code.claude.com/docs/en/interactive-mode#background-bash-commands)
(`run_in_background`) when available and collects the task's output before starting another
poll. Otherwise it uses `--timeout 540` in the foreground, shortened when needed to fit the
shell tool's limit. A timeout returns `{"status":"waiting"}`; `replaced` or `closed` ends the
listener. Tracked tasks belong to the Claude Code session; resume the review if the session
or listener stops. Browser launch and local-server access follow the session's permissions.

### Codex

Run `planboard setup codex` from the project directory (or add `--global` for all projects).
In Codex CLI or the IDE extension, invoke `$planboard`; in the app, select the skill or ask
Codex to use planboard. If the skill does not appear, restart Codex.

The installer follows the official [Codex skill conventions](https://learn.chatgpt.com/docs/build-skills):
YAML `name` and `description` front matter in `SKILL.md`, under `.agents/skills` at project
or user scope. [Project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
belong in `AGENTS.md` (global instructions default to `~/.codex/AGENTS.md`, with `CODEX_HOME`
overriding that directory). Setup installs only the reusable skill and leaves those instructions
and Codex configuration untouched. Global skill discovery uses `~/.agents/skills`, independently
of `CODEX_HOME`.

The skill opens the board, polls with `--timeout 30 --owner "Codex"`, reads notes and attachments,
edits the Markdown, changes task statuses, replies to each note, and polls again during the active
review. If a shell call yields a session id, Codex must collect that command's output before
starting another poll. A timeout returns `{"status":"waiting"}`; `replaced` or `closed` ends the
listener. This works with bounded foreground shell commands and does not depend on Claude's
background-command option. A detached process cannot be assumed to wake Codex after a turn ends;
resume the review in a new turn if listening has stopped. Browser launch and local-server access
remain subject to the session's permissions.

### Cursor

Run `planboard setup cursor` from the project directory (or add `--global` for all projects).
In Agent chat, type `/` and select `planboard`, or ask Cursor to use the planboard skill.
Restart Cursor if the skill does not appear.

The installer follows the official [Cursor skill conventions](https://cursor.com/docs/skills):
YAML `name` and `description` front matter in `.cursor/skills/planboard/SKILL.md`, or
`~/.cursor/skills/planboard/SKILL.md` with `--global`. Project setup also writes
`.cursor/rules/planboard.mdc`, a [project rule](https://cursor.com/docs/rules) with
`alwaysApply: false` that points to the review workflow. Global setup installs the skill and
prints the optional rule for Customize → Rules (Settings → Rules in older versions).
Existing `AGENTS.md` instructions are preserved unless `--agents-md` is supplied; that option
appends a planboard section to the current project's file, including with `--global`.

The Cursor skill opens the board, polls with `--timeout 30 --owner "Cursor"`, reads notes and
attachments, edits the Markdown, updates task statuses, replies to each note, and polls again
during the active review. It uses foreground terminal commands within the tool's time limit.
If the terminal returns a tracked command handle, collect its output until it exits before
starting another poll. A timeout returns `{"status":"waiting"}`; `replaced` or `closed` ends
the listener. A detached terminal cannot be assumed to wake an ended turn; ask Cursor to resume
the review if listening stops. Browser launch and local-server access follow the session's
permissions.

### OpenCode

Run `planboard setup opencode` from the project directory (or add `--global` for all projects).
Ask OpenCode to use the planboard skill to review `PLAN.md`. OpenCode discovers the skill and
loads it through its native `skill` tool. If it does not appear, restart OpenCode and check
that skill permissions allow `planboard`.

The installer follows the official [OpenCode skill conventions](https://opencode.ai/docs/skills/):
YAML `name` and `description` front matter in `.opencode/skills/planboard/SKILL.md`. Global
setup writes `~/.config/opencode/skills/planboard/SKILL.md` by default. It follows OpenCode's
[configuration paths](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/global.ts):
an absolute `XDG_CONFIG_HOME` changes the base to `$XDG_CONFIG_HOME/opencode`, and
`OPENCODE_CONFIG_DIR` takes precedence when set. [Project instructions](https://opencode.ai/docs/rules/)
belong in `AGENTS.md`; global instructions live in OpenCode's config directory. Setup installs
only the reusable skill and leaves those instructions, `opencode.json`, and permissions untouched.

The skill opens the board, polls with `--timeout 30 --owner "OpenCode"` using the `bash` tool,
reads notes and attachments, edits the Markdown, updates task statuses, replies to each note,
and polls again during the active review. The shell timeout must exceed the poll timeout;
collect the command's JSON and completion before starting another poll. A timeout returns
`{"status":"waiting"}`; `replaced` or `closed` ends the listener. A detached process cannot
be assumed to wake an ended turn; ask OpenCode to resume if listening stops. Skill loading,
shell commands, file edits, browser launch, and local-server access follow the session's
permissions.

## Where things live

| Path | Contents |
| --- | --- |
| `PLAN.board/` next to the plan | `notes.json` (the conversation), `events.jsonl` (derived status history), `snapshot.json`, `attachments/` (pasted screenshots, whiteboard sketches as PNG + `.excalidraw`), `visits.json` (this machine's viewing state), `whiteboards/` (autosaved working scenes) |
| `~/.planboard/` | `server.json` (running daemon), `boards.json` (known boards), `server.log` |

Set `PLANBOARD_STATE_DIR=<dir>` to keep every board's sidecar under one directory (keyed by a
hash of the plan path) instead of beside the plan. The sidecar is meant to be committed with the
plan - notes, replies, attachments and the status history are project knowledge - and planboard
writes a `.gitignore` inside it that keeps the machine-local `visits.json` and the autosaved
`whiteboards/` scenes out of the repository.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PLANBOARD_PORT` | `4747` | server port |
| `PLANBOARD_HOST` | `127.0.0.1` | bind address; `0.0.0.0` makes the board reachable from other machines |
| `PLANBOARD_HOME` | `~/.planboard` | daemon state |
| `PLANBOARD_STATE_DIR` | unset | central sidecar root (see above) |
| `PLANBOARD_NO_OPEN` | unset | `1` never launches a browser |
| `PLANBOARD_ALLOWED_HOSTS` | unset | extra `Host` values to accept (e.g. behind a reverse proxy); `*` disables the check |
| `PLANBOARD_IDLE_TIMEOUT_MS` | `0` (off) | stop the daemon after this long with no browser or poll attached |

Binding beyond loopback exposes an unauthenticated server that serves files from the plan's
directory and accepts notes your agent will act on. Only do it on a network you trust. The
server rejects requests whose `Host` is not one it answers to (DNS-rebinding defence) and
mutating requests carrying a foreign `Origin`.

### From a sandbox VM to the Mac

When Claude Code runs inside the Apple `container` sandbox, start the daemon bound to all
interfaces and open the VM's address from Safari:

```sh
PLANBOARD_HOST=0.0.0.0 planboard PLAN.md --no-open   # prints http://127.0.0.1:4747/boards/<key>
ip -4 addr show eth0 | grep inet                     # e.g. 192.168.65.3 → open http://192.168.65.3:4747/
```

## Development

```sh
npm test                 # node:test - parser, diff, store, export, server, setup
npm run build            # bundle client/ + Mermaid into dist/client/, copy the whiteboard frame into dist/whiteboard/
node scripts/build.js --watch
planboard server         # foreground server with logs on stderr
```

Layout: `src/plan.js` (Markdown → model + HTML), `src/diff.js` (plan snapshots → status
events), `src/store.js` (sidecar persistence: notes, events, attachments, whiteboard scenes),
`src/board.js` (one plan at runtime: watcher, notes, poll, sketch feedback), `src/export.js`
(plan + threads → Markdown), `src/server.js` (HTTP + WebSocket), `src/cli.js`, `src/guidance.js`
(everything the agent is told); `client/main.js` (the browser app), `client/changes.js` (the
change-review graphics), `client/whiteboard.js` (host side of the Excalidraw frame),
`client/util.js`, `client/board.css`.

## Example and screenshots

`PLAN.md` is a fictional community garden project. Its sidecar starts with no notes, events,
visits, attachments, or saved whiteboard scenes; `snapshot.json` matches the example plan.

Regenerate the documentation screenshots with:

```sh
npx playwright install chromium  # once, for screenshot development
npm run screenshots
```

The script opens a temporary copy of the example, adds synthetic review notes and changes,
and captures the real board and Changes tab. It never adds review or visit history to the
checked-in example. To use an existing Chromium-based browser, set `PLANBOARD_BROWSER` to
its executable path. The screenshots are illustrative fixtures, not a captured user session.
