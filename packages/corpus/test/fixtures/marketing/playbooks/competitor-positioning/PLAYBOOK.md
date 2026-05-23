---
schema: playbooks/v1
slug: competitor-positioning
title: Competitor positioning — pick your axis, name the trade
targets:
  - { kind: operator, ref: marketing-analyst }
binds_operator: marketing-analyst
kind: overlay
status: shadow
priority: 80
lock_check:
  - factual-grounded
  - brand-voice
evidence:
  - kind: run
    ref: collections/eval-case/positioning-suite/runs/initial
    note: First eval batch planned
ttl: "P90D"
supersedes: []
created_at: "2026-05-22T14:30:00Z"
updated_at: "2026-05-22T14:30:00Z"
tags: [positioning, competitive, differentiation]
metadata:
  corpus:
    authoredBy: corpus-curator
    shadowTrafficPct: 0.10
    autoPromote:
      enabled: true
      metric: winRateVsBaseline
      threshold: { gte: 0.55 }
      minSampleSize: 30
      cooldown: "7d"
    execution: sandboxed
---

## Overlay
Positioning copy MUST name the specific competitor weakness it's trading off against. "We're faster" is noise; "We don't ship a CLI" is positioning.

## Procedure
1. List the top 3 competitors by ICP overlap.
2. For each, identify one specific decision they made that we explicitly DIDN'T.
3. Write the positioning line as: `For [ICP], who [problem], [product] is the [category] that [specific trade-off vs competitor]`.
4. Lint output against the [[weak-positioning-saas]] critique.

## Promotion gate
Promote shadow → active when winRateVsBaseline ≥ 0.55 over n ≥ 30 evals.
