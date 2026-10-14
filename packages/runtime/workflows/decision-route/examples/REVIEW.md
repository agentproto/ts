---
kind: review
id: decision-route-example
name: Decision-routed review (example)
description: >-
  Example REVIEW.md for the decision-route workflow. DECISION.md choices map to
  BINDINGS (light / local / deep / deep-free); each binding names checks and
  each check names a preset — never a model id. Replace the two preset ids
  with presets configured on your daemon.
target:
  kind: git-range
  base: origin/main
checks:
  - id: claims
    kind: agent
    # An OpenCode preset whose model ends in -free (or big-pickle).
    preset: opencode-free-review
    rubric: ./rubrics/claims.md
    blockOn: high
    timeoutMs: 600000
  - id: correctness-free
    kind: agent
    preset: opencode-free-review
    rubric: ./rubrics/correctness.md
    blockOn: high
    timeoutMs: 900000
  - id: correctness-sonnet
    kind: agent
    # A Claude Code preset pinned to a Sonnet model. Refused under a
    # free-only profile BEFORE spawn; nothing is substituted.
    preset: claude-sonnet-review
    rubric: ./rubrics/correctness.md
    blockOn: high
    timeoutMs: 900000
bindings:
  light: {checks: [claims]}
  local: {checks: [correctness-free, claims]}
  deep: {checks: [correctness-sonnet, claims]}
  deep-free: {checks: [correctness-free, claims]}
---

# Example review manifest

Pairs with `DECISION.md` in this directory. `deep` needs a subscription
profile (`remote-sonnet`); under `local-free` the workflow's `freeBindings`
input redirects `deep` to `deep-free`.
