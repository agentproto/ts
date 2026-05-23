---
schema: playbooks/v1
slug: ad-angle-generation
title: Ad angle generation — JTBD-grounded variants
targets:
  - { kind: operator, ref: marketing-analyst }
binds_operator: marketing-analyst
kind: overlay
status: shadow
priority: 90
lock_check:
  - factual-grounded
evidence:
  - kind: run
    ref: collections/eval-case/ad-angle-suite/runs/initial
    note: First eval batch, n=20 planned
  - kind: reflection
    ref: collections/corpus-gap/generic-ad-copy/ITEM.md
    note: Gap that motivated this playbook
ttl: "P90D"
supersedes: []
created_at: "2026-05-22T14:30:00Z"
updated_at: "2026-05-22T14:30:00Z"
tags: [ads, angles, jtbd]
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
When generating ad creative, generate 3 distinct angles before refining any single one.

## Procedure
1. Identify the JTBD (job-to-be-done) the audience hires the product for.
2. Generate one angle per axis: outcome, pain, identity.
3. For each angle, write a hook + body in <50 words.
4. Score each angle on specificity + audience fit; promote the highest.

## Promotion gate
Promote shadow → active when winRateVsBaseline ≥ 0.55 over n ≥ 30 evals.
