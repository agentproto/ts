---
kind: review-pack
id: core
version: 0.1.0
description: Correctness, security, and test-coverage reviewer lanes — the checks most repos want without hand-writing their own rubrics.
checks:
  - id: correctness
    kind: agent
    rubric: ./rubrics/correctness.md
    blockOn: high
    description: Does this range introduce a correctness or security regression?
  - id: security
    kind: agent
    rubric: ./rubrics/security.md
    blockOn: high
    description: Does this range introduce an OWASP-class vulnerability?
  - id: tests
    kind: agent
    rubric: ./rubrics/tests.md
    blockOn: high
    description: Does a behavior change in this range ship a test that would catch its regression?
---

# @agentproto/review-pack-core

Three generic reviewer lanes, meant to be `uses:`d rather than copied:
`correctness`, `security`, `tests`. None declare a `preset` — presets are
harness-specific, so the consumer's `uses[]` entry (or a per-check
`overrides.<id>.preset`) must supply one. None declare `bindings`,
`prepare`, or an `effects: true` check — a pack is checks + rubrics only.

See the consuming repo's own REVIEW.md for how these are wired into a
binding (`uses: [{pack: ..., as: core}]`, then reference `core/correctness`
etc. from a binding's `checks`).
