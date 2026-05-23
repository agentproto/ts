---
schema: playbooks/v1
slug: cold-email-outbound
title: Cold email outbound — earned-attention opener
targets:
  - { kind: operator, ref: marketing-analyst }
binds_operator: marketing-analyst
kind: overlay
status: shadow
priority: 70
lock_check: []
evidence:
  - kind: run
    ref: collections/eval-case/cold-email-suite/runs/initial
    note: First eval batch planned
ttl: "P90D"
supersedes: []
created_at: "2026-05-22T14:30:00Z"
updated_at: "2026-05-22T14:30:00Z"
tags: [cold-email, outbound, sales]
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
Cold-email opener MUST earn the reader's next 5 seconds by stating something they didn't know, not by claiming a benefit.

## Procedure
1. Research one specific thing about the prospect (their hire, their post, their company's recent move).
2. State that thing in <12 words as the opener.
3. Connect it to the offer in the next sentence — NO "I noticed you…" bridge.
4. End with one specific yes/no question.

## Promotion gate
Promote shadow → active when winRateVsBaseline ≥ 0.55 over n ≥ 30 evals.
