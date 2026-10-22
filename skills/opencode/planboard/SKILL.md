---
name: planboard
description: Review a Markdown plan with the user on a live Planboard board. Use when the user asks to open a board, discuss plan items, or handle Planboard notes.
---

# planboard for OpenCode

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

Golden plan structure
  Keep one current record, with these ## sections in order for new plans:
  1. Description {#description}: what the task is, why it matters, and the source
     of the request. Distinguish user instructions from attached source material.
  2. Requirements and scope {#requirements}: observable outcomes, acceptance
     criteria, constraints, and explicit exclusions. Requirements are prose.
  3. Architecture {#architecture}: the current design and rationale. Use a diagram
     only when it clarifies the design; keep old designs in supporting details.
  4. Decisions and questions {#decisions}: what must be decided, by whom, why,
     and which action depends on it. Compare options in a table on the same
     dimensions. Label recommendations; record the selected option, actor, date,
     rationale and source. Options are not tasks. Unchosen does not mean done.
  5. Risks and dependencies {#risks}: consequence, owner, mitigation and affected
     work; link related plans. Recheck assumptions when a dependency changes.
  6. Implementation {#implementation}: concrete actions with owner, completion
     condition and evidence. Use plain subheadings for phases, checkboxes for
     executable actions; do not count both a parent summary and its child tasks.
  7. Apply and verify {#apply}: version, target or rollout wave, prerequisites,
     operator, apply result, verification, stop conditions and recovery. Keep
     building, merging, applying and observed success distinct.
  8. Results and evidence {#results}: criterion, observed result, source, revision
     or environment, and observation date. Say what remains unverified.
  9. Handoff and ownership {#handoff}: next action, owner, waiting condition and
     enough context to resume. Use Unassigned when ownership is unknown.
  10. Timeline {#timeline}: creation, iterations, scope/design decisions,
      meaningful failures, milestones and handoffs with original dates/sources.
      Preserve date-only precision and include a zone for times. Do not invent
      missing history or treat the date a file was opened as verification.
  Keep non-applicable sections brief and explain why; do not invent work, gates
  or deployment steps to fill them. Existing plans remain valid. When migrating,
  retain existing item/heading IDs and their threads, preserve source order within
  sections, and record the restructuring in Timeline. Never silently reinterpret
  an ambiguous historical status.

  Use paragraphs, plain bullets and tables for facts, requirements, assumptions,
  decisions, options, evidence and history. Only actions use [ ], [~], [!], [x]
  or [-]. [?] is an unresolved question, shown separately from action progress.
  When answered, preserve its ID in a plain entry recording the answer and source;
  use plain text for Deferred or Superseded. Do not mark an option [x] to mean
  selected. Cancelled or transferred work is not completed work; retain the
  reason and destination. Questions and cancelled work do not enter progress.
  A done action needs its completion condition verified, with evidence referenced;
  implementation progress is separate from application and acceptance.

  The page is continuous: main explanations, actions, choices and results stay
  visible. Put only supporting context, logs or superseded alternatives inside
  native <details id="stable-detail-id"><summary>Specific label</summary> blocks,
  with blank lines around the Markdown body. Expand all opens all such blocks;
  Collapse details leaves the primary content visible. Opening one disclosure
  does not close another. Avoid hiding entire sections or nesting many folders.

  The Now strip reads canonical plain list entries by stable ID: {#now-outcome}
  in Results for the latest known outcome, {#now-verified} there for its last
  verified date/source (or Not yet verified), and {#now-next} in Handoff for the
  next action and owner. Keep these short; link their evidence or action. Open
  [?] questions supply Needs your input. Do not maintain a duplicate Now section.
  On resume or closeout, reconcile current scope, choices, diagrams, work states,
  evidence and handoff; add significant changes to Timeline. Existing authorization
  persists: optional questions do not block unrelated authorized work, and silence
  never establishes a decision or approval.

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
   Link each updated item, section, or diagram with `[label](#stable-id)` in
   your reply so the user can jump to the change from Thread or Activity.
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

Advanced workflow (opt-in)
  A sibling PLAN.workflow.json enables source-backed tasks, workers, candidate
  artifacts, checks and durable recovery. Plain Markdown plans keep working.
  Start with `planboard spec PLAN.md init --key setup-1`, or pass --file config.json.
  Edit the companion configuration and linked source files, then run
  `planboard spec PLAN.md refresh --key refresh-1` to reconcile their revisions.
  `planboard spec PLAN.md` shows requirements, criteria, mappings and issues.
  Browser discussion is not automatically an accepted instruction or spec change.
  Accept a proposed change explicitly with `planboard spec PLAN.md accept
  --change <change-id> --key accept-1`; use --file for reconciliation details.
  Acceptance first records ready_to_reconcile. Then explicitly run
  `planboard spec PLAN.md reconcile --change <change-id> --key archive-1`.
  For a standard OpenSpec directory this runs native `openspec archive <id> --yes`
  with literal arguments, refreshes sources, and records evidence of success or failure.
  Plain Markdown and custom OpenSpec directory names require manual source updates;
  after refresh, use `spec PLAN.md reconciled --change <id> --outcome passed
  --file <evidence.json> --key reconciled-1`. The server verifies canonical changes.

  All workflow mutations require --key <stable-id>, or idempotency_key in --file.
  Reuse that key with the exact same request when retrying a lost response. Use
  a new key for new work. --expected-revision <n> detects stale state; exit 3 means
  a conflict. Read commands print JSON; --format markdown is also available.
  Payloads may come from --file input.json or --file -; tokens are credentials.

  1. Register each actual host worker with `planboard worker PLAN.md register
     --host codex|claude|cursor|opencode --label <label> --workspace <absolute-path>
     --capabilities implement,validate --key register-1`. Record its returned id
     and worker_token privately; session/model identifiers must be known, not guessed.
  2. The coordinator acquires `planboard worker PLAN.md coordinator --worker <id>
     --worker-token <token> --key coordinate-1`. Only its active lease may create,
     dispatch, cancel or integrate runs. Use --takeover only for an intended handoff.
     On an enabled workflow board, polls require --worker <id> --token <coordinator-token>.
  3. Create work with `planboard run PLAN.md create --task <id> --worker <id>
     --token <coordinator-token> --key run-1`. Record dispatch before using the
     host's native subagent/session tool: `planboard run PLAN.md dispatch --run <id>
     --worker <id> --token <coordinator-token> --phase dispatched --key dispatch-1`.
     Record a known --host-session-id after launch; if launch status is unknown,
     record --phase uncertain and inspect history before retrying. Planboard does
     not create model sessions or infer that a launch happened.
  4. The worker claims the run with `planboard worker PLAN.md claim --worker <id>
     --worker-token <token> --run <id> --key claim-1`. Follow the returned task packet.
     Keep the attempt lease alive only while its host turn is active:
     `planboard worker PLAN.md keepalive --attempt <id> --token <attempt-token>
     --parent-pid <active-host-pid> --max-duration 300 --key alive-1`.
     Heartbeats run every 30 seconds and stop on parent death, invalid lease,
     signal or the duration bound. Use a tracked command and stop/release it when
     the turn ends. A long-lived app PID is not proof that a turn is still active.
     Coordinator keepalive uses --coordinator --worker <id> --token <lease-token>.
  5. Submit a candidate with `planboard run PLAN.md submit --attempt <id>
     --token <attempt-token> --summary <text> --key submit-1`. Files, revisions,
     evidence and checks determine acceptance; a successful worker report does not.
     Run an explicit queued command/evaluation job with `planboard validate PLAN.md
     run --job <id> --worker <id> --worker-token <token> --key check-1` (eval uses
     the same syntax). The user-started runner uses executable + argv without a
     shell, enforces timeout/output bounds and records stdout/stderr as evidence.
     Manual/reviewer results use `validate PLAN.md start` then `result --file`
     with the job token, criteria outcomes and durable evidence. No model API is built in.
     A runner retry returns an already recorded result, but never automatically
     repeats an uncertain prior execution. Inspect history, explicitly recover or
     enqueue a new job, and use a new --key before rerunning external side effects.
  6. For dependent work, integrate actual candidate files into the chosen workspace
     and record `planboard run PLAN.md integrate --task <id> --worker <id>
     --token <coordinator-token> --workspace <absolute-path> --artifacts <id,id>
     --key integrate-1`; combined validation must pass. Failed checks can lead to
     an explicit new run with --repair-of <result-id>. Do not retry forever.

  Checkbox done is reported progress, separate from accepted/not_validated/pending/stale.
  Never use `planboard set ... done` as proof of validation or to bypass blockers.
  Check `planboard history PLAN.md`, `planboard resume PLAN.md --since <cursor>`,
  and `planboard compare PLAN.md --from <revision> --to <revision>` before resuming.
  History filters: --task, --requirement, --worker, --run, --outcome, --from, --to,
  --cursor and --limit. Resume reports missing leases, blockers and repair work.
  Native host delegation remains subject to user authorization and host permissions.
  Never create commits, new branches or pushes without the user's explicit request.

OpenCode loads this skill through its native `skill` tool. Use the user's
conversation to choose the plan. Skill, shell, and edit permissions remain under
the session's control; the skill does not grant additional access.
