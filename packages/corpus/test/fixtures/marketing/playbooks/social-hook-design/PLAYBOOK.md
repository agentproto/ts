---
schema: playbooks/v1
slug: social-hook-design
title: Social hook design — pattern interrupt in 5 seconds
targets:
  - { kind: operator, ref: marketing-analyst }
binds_operator: marketing-analyst
kind: overlay
status: shadow
priority: 95
lock_check: []
evidence:
  - kind: run
    ref: collections/eval-case/social-hook-suite/runs/initial
    note: First eval batch planned
  - kind: reflection
    ref: entries/patterns/2026/contrarian-short-form-hooks.md
    note: Pattern this playbook operationalizes
ttl: "P90D"
supersedes: []
created_at: "2026-05-22T14:30:00Z"
updated_at: "2026-05-22T14:30:00Z"
tags: [social, hook, short-form]
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
Every short-form hook MUST earn the next 5 seconds. State a contradiction OR a specific number OR a named entity in the first sentence.

## Procedure
1. Generate 3 hooks per outline: contradiction, number, name.
2. Score each by surprise (1-5) + relevance (1-5).
3. Promote the highest combined score; archive the rest as alts.
4. Output: hook + first 3 sentences + CTA.

## Promotion gate
Promote shadow → active when winRateVsBaseline ≥ 0.55 over n ≥ 30 evals.
