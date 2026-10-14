# session_mark_completed

One call that records "this session's work is done" — the declared path: no
wrapup plan, no classification, no judge loop. The verdict (with an optional
summary + who judged it) is written onto the session's Level-2
`SessionOutcome`, on top of whatever the daemon already derived from the
session's last assistant message, opened PRs and cost.

It works on TWO kinds of row, and which one you hit changes what the call
DOES, not what it records:

| Row | Effect |
|---|---|
| live (`running` / `starting`, idle) | closes it gracefully — `endedReason: "steward-completed"` for `verdict:"done"`, `steward-abandoned` for the not-completed verdicts — and clears the in-memory binding so it stays lazy-resumable (never deleted) |
| already terminal (`exited` / `killed` / `error`) | records the SAME resolution and stops there: nothing is revived, no process is signalled, and `status` / `endedReason` / `exitCode` keep showing exactly how it really died |

The terminal case exists for the sandbox session that died AFTER its work was
fully pushed and merged — an e2b box hitting its time cap, a crashed child
whose PR had already landed. Before this, the only tool that accepted such a
row was `session_archive`, which hides it entirely and throws away the "this
was fine" signal. Now the row keeps its true cause of death and gains the
resolution: list / recap / UI badges derived from `outcome`
(`isOutcomeCompleted`) read it as completed instead of failed.

## verdict

Default `"done"`.

- `"done"` — completed. A live row closes as `endedReason:
  "steward-completed"`; an already-ended row's recorded outcome is relabelled
  `termination.reason: "operator-completed"` with the TRUE original mechanism
  (`crashed`, `sandbox_gone`, …) preserved in `termination.previousReason`.
  `desc.endedReason` is never rewritten — only the operator-facing outcome
  label changes.
- `"partial"` / `"failed"` / `"abandoned"` — not completed. A live row closes
  as `endedReason: "steward-abandoned"`; an ended row is only labelled (the
  verdict nuance rides on `outcome.verdict`, termination untouched).
- `"blocked"` / `"needs-input"` — NOT a completion: the session must stay
  running and wait on a human, so the verdict is recorded as
  `SessionDescriptor.wrapupFlag` instead. There is no live row left to wait
  on once a session has ended, so these two verdicts are refused (`ok:false`,
  `error: "not_live"`) on a terminal session.

## summary

Overrides the outcome's derived summary (the session's own last assistant
message), trimmed to the same 600-char cap, tail kept. Useful exactly when
the derived one is missing or misleading — a session killed before it said
anything, or one whose last words were mid-thought.

## note

Free-text note explaining the verdict — the operator's one line of why. Kept
verbatim on `outcome.note`, alongside the structured `reason` below.

## judgedBy

A judge session id sets `outcome.source: "judged"`. Omitted ⇒
`source: "declared"`, `judgedBy: "steward-rules"` (a deterministic close with
no judge in the loop). The structured detail's `by` field is derived from it
too: a `jev…` judge ⇒ `jev`, any other judge ⇒ `agent`.

## reason / errorKind / nextStep / by

The structured `OutcomeDetail` (`session-outcome.ts`), same vocabulary every
other close shares: free-text `reason`, a closed-vocabulary `errorKind`
(`quota` | `upstream` | `timeout` | `crash` | `logic` | `none`), what should
`nextStep`, and who states it (`by`).

## Refusals

`ok:false` with:

- `not_found` — the session id/name does not resolve. Still refused, terminal
  or not.
- `orchestrator_session_out_of_scope` — a scope-bound orchestrator may only
  mark sessions it (transitively) spawned.
- `not_live` — a terminal row asked for `blocked`/`needs-input` (see the
  verdict table above). The response carries the row's real `status`.
- `refused_stale_or_busy` — a LIVE row that picked up a turn, asked a
  question, or still has a background task in flight since the caller last
  looked. Re-read the row and retry; the liveness re-check is what keeps an
  autonomous close from ever landing on a session that just went busy.
