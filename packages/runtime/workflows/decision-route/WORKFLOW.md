---
name: Decision-routed review
id: decision-route
description: |
  Staged decision workflow for review routing: collect bounded evidence ->
  DECISION.md rules (zero models) -> one Jev direct-API classification for
  unresolved cases -> at most ONE profile-gated harness escalation -> closed
  choice mapped to a REVIEW.md binding -> (enforce mode only) the review ->
  one honest verdict report. Shadow by default: nothing is started.
version: 0.1.0
entry: ./entry.mjs
inputs:
  cwd:
    type: string
    description: Directory inside the repo to review.
  policyPath:
    type: string
    description: DECISION.md path relative to cwd.
    default: DECISION.md
  manifestPath:
    type: string
    description: "REVIEW.md path (absolute or relative to cwd). Default: the repo's REVIEW.md."
  base:
    type: string
    description: "Range base (default: merge-base with origin/main)."
  head:
    type: string
    description: "Range head (default: HEAD)."
  profile:
    type: string
    description: local-free (default) or remote-sonnet.
    default: local-free
  mode:
    type: string
    description: shadow (default; starts no review) or enforce.
    default: shadow
  bindings:
    type: object
    description: Closed choice -> REVIEW.md binding name.
    default: { skip: light, light: light, standard: local, deep: deep }
  freeBindings:
    type: object
    description: Binding overrides under a free-only profile.
    default: { deep: deep-free }
  profileOptions:
    type: object
    description: Escalation target, jev flag, reviewTimeoutMs. Cannot change the entitlement.
  parentSessionId:
    type: string
    description: Session that owns this run; spawned sessions nest under it.
  evidence:
    type: object
    description: Consumer-built tier-1 evidence; replaces git-derived metadata, same export policy.
outputs: {}
steps:
  - id: collect
    kind: tool
    tool: decision_collect_evidence
  - id: rules
    kind: tool
    tool: decision_stage_rules
  - id: classify
    kind: tool
    tool: decision_stage_classify
  - id: escalate
    kind: tool
    tool: decision_stage_escalate
  - id: select
    kind: tool
    tool: decision_select_review
  - id: review
    kind: tool
    tool: decision_run_review
  - id: validate
    kind: tool
    tool: decision_validate_verdict
---

# Decision-routed review

One workflow, seven `tool` steps; the parent (this run) owns every step. Each
stage tool returns failures as data and stamps a `trace`
(`workflow / runId / step / parent / profile / entitlement / harness / model /
decisionSource / wait / fallbackCount / recoveryCount`), so `validate`'s report
shows what ran, on what, and precisely what it is waiting for.

| step | tool | models |
| --- | --- | --- |
| `collect` | `decision_collect_evidence` | none — metadata only (counts, change types, risk categories); paths only if DECISION.md opts in; secrets scrubbed |
| `rules` | `decision_stage_rules` | none |
| `classify` | `decision_stage_classify` | Jev direct API, once, no retries; skipped when rules settled, the policy disables it or the profile does |
| `escalate` | `decision_stage_escalate` | at most ONE harness session, only when still unresolved; target validated against the profile BEFORE spawn |
| `select` | `decision_select_review` | none — choice -> binding; every reviewer/fallback/recovery preset is preflighted against the profile |
| `review` | `decision_run_review` | only in `mode: enforce`; shadow starts nothing |
| `validate` | `decision_validate_verdict` | none — folds everything into one state |

## Profiles (execution, not policy)

DECISION.md holds criteria / choices / uncertainty. The **profile** holds which
models and harnesses may run and the budgets. It reuses existing config
(harness presets, user presets, `models` roles, the OpenRouter guard) and adds
one entitlement ceiling:

- `local-free` (alias `free-only`, default): Jev off; the escalation target is
  a model in the `zero-cost` model list (by default, catalog price 0/0) and
  **you must name it** via `profileOptions.escalation` (a preset id, or
  `adapter`+`model`). Nothing paid is ever substituted — a Sonnet preset, a
  paid fallback, a rotate target or a recovery model override is refused
  before spawn.
- `remote-sonnet` (alias `subscription`): Jev on; escalation defaults to the
  configured `review.small` role (must resolve to Claude Code Sonnet or an id
  in the `zero-cost` list); the zero-cost list plus Claude Code Sonnet are the
  ceiling.

E2B (or any) sandbox placement grants no entitlement. Unknown or dynamic
identity (no explicit model, `@route`, unreadable auth profile) fails closed.

## Report states

`validate` reports one of: `completed` (an `approved: true` only when a review
lane set passed and stayed inside the profile), `provider-unavailable`,
`human-input-required` (only when the escalation session itself asked a human —
ordinary classifier uncertainty is not a human request), `incomplete`,
`timeout`, `cancelled`, `refused` (profile gate), `failed`, `shadow`. This
workflow never schedules automatic continuation, so "automatic continuation
pending" is not emitted. Failures and incompleteness are never approvals.

## Invoking

`workflow_run_file` (MCP) with `path` set to this file and `input` as above;
poll `workflow_status`. CLI equivalent (no new command needed):

```sh
agentproto workflow run-file <pkg>/workflows/decision-route/WORKFLOW.md \
  --cwd /path/to/repo \
  --input-json '{"cwd":"/path/to/repo","policyPath":"DECISION.md","profile":"local-free","mode":"shadow","profileOptions":{"escalation":{"preset":"my-opencode-free"}}}'
agentproto workflow status <runId>      # the `validate` step output is the report
```

Worked example policy + review manifest: `examples/DECISION.md`,
`examples/REVIEW.md`. See `docs/decision-policy.md` and
`docs/studio-decision-router-integration.md`.
