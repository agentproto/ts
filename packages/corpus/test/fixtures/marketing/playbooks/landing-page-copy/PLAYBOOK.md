---
schema: playbooks/v1
slug: landing-page-copy
title: Landing-page copy — high-conversion structure
targets:
  - { kind: operator, ref: marketing-analyst }
binds_operator: marketing-analyst
kind: overlay
status: shadow
priority: 100
lock_check:
  - brand-voice
  - factual-grounded
evidence:
  - kind: run
    ref: collections/eval-case/landing-page-copy-conversion-suite/runs/2026-05-22-batch-1
    note: First shadow batch, n=30 evals, winRateVsBaseline TBD
  - kind: reflection
    ref: collections/corpus-gap/weak-positioning-saas/ITEM.md
    note: Gap that motivated this playbook
ttl: "P90D"
supersedes: []
created_at: "2026-05-22T14:30:00Z"
updated_at: "2026-05-22T14:30:00Z"
tags: [landing-page, copy, conversion]
metadata:
  corpus:
    authoredBy: corpus-curator
    derivedFromGap: collections/corpus-gap/weak-positioning-saas/ITEM.md
    shadowTrafficPct: 0.10
    autoPromote:
      enabled: true
      metric: winRateVsBaseline
      threshold: { gte: 0.55 }
      minSampleSize: 30
      cooldown: "7d"
    shadowMetrics:
      sampleSize: 0
      winRateVsBaseline: null
      lastEvaluatedAt: null
    archiveReason: null
    execution: sandboxed
---

## Overlay
[Markdown that gets merged into marketing-analyst's prompt at runtime when this playbook is active. The block-replacement / overlay merge logic is the runtime's concern, not this fixture's.]

## Procedure
1. Read brief: ICP, offer, current page.
2. Apply principle [[specificity-beats-superlatives]] — every superlative gets a number, date, or named entity.
3. Generate 3 hook variants using pattern [[contrarian-short-form-hooks]].
4. Lint output against critique [[weak-positioning-saas]].
5. Output: H1, sub-H1, 3 CTA variants, 1 social-proof block.

## Promotion gate
Promote shadow → active when winRateVsBaseline ≥ 0.55 over n ≥ 30 evals (see metadata.corpus.autoPromote).
