---
name: Docs drift audit
id: docs-audit
description: >
  Documentation auditor. Spawns a single claude session that reads the repo's
  user-facing docs, compares them against a shipped feature surface, and reports
  drift. Read-only by default; the `delivery` input escalates to commit or PR.
version: 0.3.0
entry: ./entry.mjs
inputs:
  surface:
    type: string
    description: Free-text description of the shipped surface the docs should reflect.
    default: ""
  docPaths:
    type: string
    description: Newline- or comma-separated list of doc files to audit.
    default: ""
  delivery:
    type: string
    description: review (default, report only) | commit (apply + commit) | pr (apply + open PR).
    default: review
  baseRef:
    type: string
    description: Base branch for pr delivery.
    default: main
  repo:
    type: string
    description: owner/repo — required for the sandbox bootstrap + REST delivery.
    default: ""
  reviewConfig:
    type: object
    description: Parsed .github/agentic-review.json (placement/adapter). Omit for a host run.
outputs:
  report:
    type: string
    description: The markdown drift report (also the session's final message in review mode).
steps:
  - id: audit
    kind: agent
    adapter: claude-code
  - id: deliver
    kind: agent
    sessionRef: audit
---

# Docs drift audit

A composable agentflow lane (see `reference/ci-review-fix-lanes.md`) that carries
a documentation audit across two steps sharing one session (the `review-fix-demo`
shape): step `audit` reports drift read-only, step `deliver` (via `sessionRef`)
acts on that report. Like `pr-review` and `agent-verb`, it composes the shared
`lib/sandbox-agent.mjs` block builders, so placement, billing, and delivery
follow the one sandbox recipe:

- **Placement** is config-driven via `reviewConfig` (the parsed
  `.github/agentic-review.json`). Omit it — as `workflow_run_file` does for a
  local run — and the step spawns on the **host** with adapter `claude-code` on
  the daemon's configured (subscription) billing. Pass a `reviewConfig` with
  `reviewerSandbox: "e2b"` (CI) and it runs in a sandbox with `claude-sdk`.
- **Delivery** is a per-run `delivery` input, NOT an `agentic-review.json` key,
  so the lane needs no merge-machinery config edit to be useful:
  - `review` (default) — read-only: `audit` reports drift, `deliver` is a no-op.
    The report is the `audit` step's final message.
  - `commit` — `deliver` applies the doc fixes and commits them to a fresh
    `bot/docs-audit-<runid>` branch (never straight onto the base branch).
  - `pr` — `deliver` applies the doc fixes and opens a fresh PR from that branch.

The manifest mirrors the entry's two-step graph for governance (AIP-15
`reconcileEntry`); `entry.mjs` is the source of truth for the runtime `agent`
steps (adapter/sandbox/cwd are resolved there via the `lib` selectors; `deliver`
inherits placement from `audit` via `sessionRef`), which are only reachable via
an entry module. Hard rules from `hardRulesBlock` apply: no
AI attribution, never `gh pr merge`, and — DOCS lane — edit only Markdown docs,
never code/workflows/config.
