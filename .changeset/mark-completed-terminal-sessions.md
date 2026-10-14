---
"@agentproto/runtime": minor
---

`session_mark_completed` now accepts an ALREADY-terminal session (`exited` /
`killed` / `error`) and records an operator resolution on it, instead of
refusing with `not_live`. A sandbox session that died — an e2b box hitting its
time cap, a crashed child whose PR had already merged — after its work was
fully pushed and merged used to keep reading FAILED in every list / recap / UI
forever; the only tool that would touch such a row was `session_archive`,
which hides it entirely and throws away the "this was fine" signal.

A terminal row is resolved by the new `registry.resolveOutcome`, the terminal
twin of `closeWithOutcome`: it stamps the SAME Level-2 `SessionOutcome`
fields a live close writes (`source` / `verdict` / `judgedBy` / `summary` /
`note` plus the structured `OutcomeDetail`) and nothing else. Nothing is
revived, no process is signalled, and `status` / `endedReason` / `endedAt` /
`exitCode` keep showing exactly how the row really died. `verdict: "done"`
additionally relabels the outcome's `termination.reason` to
`"operator-completed"` — the true death mechanism preserved in
`previousReason` — and retires the row, matching the UI's existing "Mark as
completed" affordance (`kill(id, …, "operator-completed")`) exactly. Every
other closing verdict (`partial` / `failed` / `abandoned`) only labels the
outcome; `blocked` / `needs-input` stay refused on a terminal row, since
there is no live session left to wait on. Unknown ids and the live path are
unchanged.

New shared `isOutcomeCompleted(outcome)` (exported from the package root)
answers "has an operator/judge declared this session's work complete?" from
either the full outcome or the compact list projection, and the badge
derivations that used to paint such a row as failed now consult it: the
shared dashboard classifier `presenceFor` folds a resolved terminal row into
`quiet` instead of `attention`, and the VS Code sessions tree / webview row
status / outcome card read it as done (a `tool_help` doc for
`session_mark_completed` documents the new contract).
