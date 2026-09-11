# Panel entities — the four nouns, and the two that don't exist

The daemon already answers "what is this thing" four different ways. The VS Code
panel drifted into answering it with a fifth vocabulary of its own ("subagent",
"mission", "task" used loosely), which is how an operator ends up unable to say
whether a row is a process, an intention, or a record of something that happened.
This file is the vocabulary. Code that renders any of these should use these
words, and no others.

## Session — a process with a conversation

`kind: "agent-cli"` (an agent), `"terminal"` (a PTY), `"command"` (one shell run
— a log, not a resumable session). Lineage is `parentSessionId` + `depth`; the
spawn `role` is `supervisor` (may delegate) or `executor` (a leaf, whose
delegation tools are stripped).

**"Subagent" is not an entity.** It is a session at `depth > 0`, usually with
role `executor`. Say *child session*, or name the relation ("under
rdv-supervisor"). Two words for one thing is what made the nesting unreadable in
the first place.

## Tree — a root session and its descendants

Derived, never stored: walk `parentSessionId` to the depth-0 root. This is the
unit of delegation, and it is also — not by coincidence — the default task
board: `tree:<rootSessionId>`, so a supervisor and every executor it spawned
share a board automatically (`task-ledger.ts`).

**"Mission" is not a fifth entity either.** If the UI shows a mission, it is
showing a tree. The word is allowed as a *label on a view*; it must never become
a record, an id, or a thing you can create.

## Task — declared intent: what should be done, by whom

The write-model (`task-ledger.ts`). `pending ⇄ in_progress → done | failed`,
plus `cancelled`, plus an explicit reopen. Claimable (absent `owner`), CAS on
`rev`, scoped to a board. Two facts the ledger deliberately keeps and the UI must
not launder away:

- **owner** — an executor session, or the human who claimed it.
- **verification** — `gate` (a policy actually ran and passed) vs `self-report`
  (someone said so). A done that was never verified must keep looking casual.

Tasks are intent, not runs: when an owner session dies, its in-progress task is
*released* back to `pending`, never failed.

## Activity — what is executing or waiting, right now

The read-model (`activity-projection.ts`): a projection **recomputed on every
`list()`**, never a registry. Kinds: `turn`, `policy`, `gate`, `commit`,
`workflow-step`, `pr`, `cron-run`. States: `active`, `pending`, `done`, `failed`,
`cancelled`. A `pending` record always carries `waitingOn` — the external signal
whose arrival moves it (`session-turn`, `human-ack`, `cap-slot`,
`stage-barrier`, `forge`, `timer`).

## What follows for the UI

- A **kanban can only be built on tasks.** Activity is recomputed each call, so a
  drag would write to something that is about to be re-derived; a session has a
  lifecycle, not an intention. `PATCH /tasks/:id` is the human write path.
- **Terminals and commands are activity, not sessions.** A PTY in the sessions
  list reads as an agent and isn't one.
- A **terminated child stays in its tree.** Falling back to a flat "Earlier"
  bucket loses the only context that made it findable.
- `pending` means two different things — blocked (Activity) vs unclaimed (Task).
  Render them as "Blocked · waiting on X" and "Unclaimed"; never print the bare
  word twice in one screen.

## Where each one is rendered

The sidebar is ~340px and vertical; a board is neither. So the split is by
SHAPE, not by importance:

- **Sessions** and **Activity** are lists — they belong in the sidebar, where
  the tree nesting and the activity feed read naturally in one column.
- **Work** is a board: the **work-board** builtin MCP-App
  (`packages/apps/src/work-board/`, tool id `agentproto_work_board`), mounted
  unconditionally by the daemon's `makeBuiltinPanelApps`
  (`packages/runtime/src/builtin-apps.ts`) alongside `sessions-panel`,
  `session-story`, `session-chat`, and the rest — no `app_install` step, and
  it reads the Task ledger live rather than off an emitted snapshot.
  Columns are the ledger's own status enum — Pending / In Progress / Done /
  Failed — with `cancelled` folded into the Failed column (tagged distinctly)
  rather than a fifth column for a status v1 treats as terminal scrap. There
  is deliberately no drag-and-drop: each card carries the explicit status
  actions valid from its current state (Claim, Start, Done, Fail, Release,
  Cancel, Reopen), and every action passes the task's CAS `rev` through
  `task_claim` / `task_update` so a concurrent move loses cleanly instead of
  clobbering. An unclaimed card reads "Unclaimed", never "pending" — that
  word stays reserved for Activity's "blocked" meaning. The verification tell
  is rendered distinctly per kind: a gate-passed done tags green ("✓ gate"),
  a self-reported one tags amber ("self-report"), a human one tags blue, and
  a declared-but-unverified `verify` tags grey ("gated") — so an unverified
  done never reads as gate-passed.
