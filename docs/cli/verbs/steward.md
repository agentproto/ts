# `agentproto steward`

```text
agentproto steward [classify] [--idle <min>] [--rules <file>] [--all] [--json]
agentproto steward classify --llm
agentproto steward analyze [<snapshotId|latest>] [--session <ids>] [--only <actions>]
                           [--judge <agent|jev>] [--max-sessions <n>] [--json]
agentproto steward act [<snapshotId|latest>] [--rules <file>] [--only <actions>]
                       [--session <ids>] [--apply] [--allow-relaunch] [--json]
agentproto steward --apply            # one-shot: classify + act
agentproto steward --legacy [--apply] [--ask-sessions] [--judge <auto|jev|agent>] [--wait]
```

The [`session-steward` app](../../../packages/apps/session-steward/README.md)
as three steps that share one persisted snapshot. **Needs a running daemon**
(`agentproto serve`). Only `act --apply` (or the one-shot `--apply`) mutates
anything.

| Step | What it does | Cost |
|------|--------------|------|
| `classify` (default) | Rules + Jev's typed verdict and probabilities per session; ONE recommended action each; writes the snapshot; prints a table grouped by action and the snapshot id. | no agent LLM |
| `analyze` (`classify --llm`) | Reads ONLY the relevant sessions (action not `keep`, low confidence, or `--session`) and records `reason`, `question`, `errorKind`, `nextStep`, `relaunchHint`, evidence refs into the snapshot; may revise the action (the classify verdict stays alongside). | one analyst turn per relevant session, capped by `--max-sessions` (20) |
| `act` | Re-checks each session against the live registry (`changed since snapshot` => skipped), applies the rules, bounds by origin, runs the daemon verbs and records the outcome fields on the session. Dry run unless `--apply`. | daemon verbs |

Actions (closed vocabulary): `keep | mark-complete | mark-failed | relaunch |
needs-input | close-abandoned | archive`.

- `mark-complete` still passes the remaining-work check (a last message that
  asks a question or proposes a next step turns it into `needs-input`).
- `mark-failed` records `outcome: failed` with the error kind.
- `relaunch` is for transient causes (quota, upstream, timeout): the plan says
  continue vs restart and suggests another non-exhausted profile/sub-account of
  the same provider; it never suggests a paid fallback for a free-only model.
  Opt-in: `--only relaunch` or `--allow-relaunch`.
- `needs-input` flags a session that waits on someone; a user-origin session is
  only ever flagged or labelled, never closed or killed.
- `close-abandoned` retires a session that never ran / was abandoned.
- `archive` hides an ended session that already has an outcome. Opt-in via
  `--only archive`.

| Flag | Default | Description |
|------|---------|-------------|
| `--apply` | `false` | Perform the planned actions. On `classify` it is the one-shot (classify, then act on the fresh snapshot). |
| `--idle <min>` | `30` | Idle threshold in minutes. |
| `--min-confidence <x>` | `0.8` | Confidence (0..1) needed to act on a verdict. |
| `--rules <file>` | auto | Custom rules (YAML or JSON). Auto-loads `./.agentproto/steward-rules.yaml` (`.yml`/`.json`), then `~/.agentproto/…`. An unreadable or unparsable file exits `2`; unknown keys / bad actions are listed as errors in the report and the run then acts on nothing. |
| `--only <a,b,…>` | all | Restrict to these recommended actions. |
| `--session <a,b,…>` | all | Restrict to these session ids (repeatable). |
| `--allow-relaunch` | `false` | Let `relaunch` run without naming it in `--only`. |
| `--judge <b>` | `agent` | `analyze`: `agent` or `jev` (no LLM spend). `--legacy`: `auto`, `jev`, `agent`. |
| `--max-sessions <n>` | `20` | `analyze`: most sessions analysed per run. |
| `--llm` | `false` | `classify`: run `analyze` on the new snapshot right after. |
| `--all` | `false` | List `keep` rows in the report too. |
| `--no-wait` | `false` | Start the run and print its id instead of blocking. Without it the command blocks, prints the report and exits `0` (done) / `1` (failed). |
| `--json` | `false` | Print the run output (counts, rows and, for classify/analyze, the whole snapshot) instead of the report. |
| `--legacy` | `false` | The original single-run steward (`--ask-sessions` implies it; `--wait` is opt-in there). |

## Rules

A rules file is data. First match wins, then the built-in defaults:

```yaml
version: 1
rules:
  - id: bench-leftovers
    when: { origin: "model-bench*", idleMinutes: ">=60" }
    action: close-abandoned
    reason: bench harness leftover
  - id: leave-my-research-alone
    when: { cwd: "**/research/**" }
    action: skip
  - id: quota-relaunch
    when: { errorKind: quota }
    action: relaunch
```

`when` keys (all must match): globs `origin`, `label`, `cwd`, `model`,
`profile`; enums `class`, `state`, `verdict`, `errorKind`, `action`,
`originClass`; numbers `idleMinutes`, `confidence` (`120`, `">=120"`,
`"10..60"`); booleans `transient`, `errored`, `neverRan`, `remainingWork`,
`confident`. A bare list is shorthand for `{version: 1, rules: [...]}`. Rule
keys: `id`, `when`, `action` (an action or `skip`), `reason`. Unknown keys are
reported as validation errors.

## Snapshot

`steward-snapshot/v1`, stored in the app data dir as `snapshots/latest.json`
(and `snapshots/<id>.json`). Header: `id`, `createdAt`, `settings`,
`rules {source, count}`, `counts` (rows per action), `scan` (what was listed,
truncated, judged). Per session: `sessionId`, `label`, `origin`, `originClass`,
`cwd`, `model`, `profile`, `state`, `class`, `idleMinutes`, `evidence` (summary),
`verdict`, `probabilities`, `confidence`, `judgedBy`, `action`, `actionReason`,
`ruleId`, `fingerprint` (what `act` re-checks), `relaunchHint`, and after
`analyze` an `analysis {reason, question, errorKind, nextStep, by,
classifiedAction, …}`. Snapshots are not pruned.

## Over MCP

The three steps are ordinary workflows of the `session-steward` app, so an
agent drives them with the `workflow_run_file` tool and the same inputs as the
flags (`apply`, `only`, `sessions`, `rules`, `snapshot`, `judge`, …):
`session-steward-classify` → `session-steward-analyze` → `session-steward-act`,
each reading and writing the same snapshot. `app_install` the app first.

## Examples

```bash
agentproto steward                                  # classify, print the table
agentproto steward classify --llm                   # …then write the reasons
agentproto steward act latest                       # dry run, default rules
agentproto steward act latest --rules my.yaml       # …custom rules
agentproto steward act latest --only mark-failed,needs-input --apply
agentproto steward --apply                          # classify + act in one go
```

## Scheduling it

`packages/apps/session-steward/routines/session-steward-hourly` is an AIP-41
`ROUTINE.md` template — hourly `session-steward-classify` with `apply: true`
(classify, then act on that snapshot; latest snapshot only) — shipped
`enabled: false`, so nothing starts closing sessions on install. Its own doc
lists the enabling steps.

## Footprint

No step puts a session list in a workflow step output: every `session_list` is
a projected (`fields`), filtered, paged query, and the snapshot lives in the
app data dir. A 1000-session registry keeps the step outputs of a classify run
under a few hundred KB.
