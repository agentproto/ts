---
name: Review then fix-and-PR demo
id: review-fix-demo
description: Two-step proof that the agentproto-run lane carries a real multi-step agentflow — a single claude-code session reviews a diff, then (via sessionRef reuse) acts on its own findings by opening a PR against a NEW branch.
version: 0.1.0
entry: ./entry.mjs
inputs: {}
outputs: {}
steps:
  - id: review
    kind: agent
    adapter: claude-code
  - id: fix-and-pr
    kind: agent
    sessionRef: review
---

# Review then fix-and-PR demo

The manifest mirrors the entry's step graph for governance (AIP-15
`reconcileEntry`); the entry (`entry.mjs`) is the source of truth for the
runtime `agent` steps, which are only reachable via an entry module.

Proves the one capability the trivial `smoke` flow doesn't: **session reuse
across steps** via `sessionRef`. `agentproto run` (the one-shot CLI verb)
structurally cannot do this — it dispatches exactly one adapter turn — which
is why the `agentproto-run` lane drives `agentproto serve` over MCP instead.

Step `review` spawns a `claude-code` session and has it read
`git diff origin/<baseRef>...HEAD` in the workflow's checkout, reporting
concrete findings without changing anything. Step `fix-and-pr` reuses that
SAME session (`sessionRef: review`) and, only if something concrete and safe
was found, applies the fix, commits it (no AI-attribution trailer), pushes
to a brand-new branch, and opens a PR against `<baseRef>` — explicitly never
touching the reviewed branch itself and never running `gh pr merge`. If
nothing concrete was found, it says so and creates no branch and no PR.

This workflow is `workflow_dispatch`-only in its calling Action — it creates
real commits and opens real PRs, so it must never fire automatically.
