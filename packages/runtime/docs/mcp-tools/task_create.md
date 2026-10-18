# task_create

Create a task on the caller's board — declared intent, not a run. Registered
alongside `task_list` / `task_claim` / `task_update`; when no Task ledger is
wired the tool answers a structured `task ledger not available` error.

Default board: a daemon session's lineage board (`tree:<root>`, shared with its
supervisor and siblings); the operator's workspace board (`ws:<slug>`). Pass
`boardId` to override (e.g. one shared board for children spawned from a
client). Leave `owner` absent for a claimable task; pass `"self"` to keep it for
yourself. `meta` is free-form provenance (prUrl, worktreePath, actionId, …).

Field detail cut from the schema lives here; each schema field description ends
with a pointer like `Details: tool_help {name:"task_create", topic:"verify"}`.

## verify

Opt-in done-gate, the same shape as `policy_attach`'s `gate`. With it a
`status:"done"` report only lands after the gate passes (shell exit 0, or a
judge agent returning PASS). One of:

- shell gate — `{ command, args?, cwd?, timeoutMs? }`: `command` must be an
  allowlisted basename; `args` are passed verbatim; `cwd` defaults to the
  session's cwd; `timeoutMs` defaults to 60 000.
- judge gate — `{ judge: { adapter, model?, prompt, timeoutMs? } }`: spawns the
  named adapter with the rubric `prompt` (the supervisor appends a VERDICT
  instruction); `timeoutMs` defaults to 120 000.
- cost-budget gate — `{ costBudget: { maxCostUsd, window, scope }, sessionId? }`:
  passes when the rolling windowed spend is within the cap, fails
  (`policy:failed`) when over; never kills the session. `sessionId` defaults to
  the watched session.
