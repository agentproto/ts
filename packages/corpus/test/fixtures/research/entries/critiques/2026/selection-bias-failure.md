---
schema: knowledge.entry/v1
slug: selection-bias-failure
kind: critique
title: Selection bias as a driver of non-replication
updated_at: "2026-06-10T10:30:00Z"
sources:
  - nature-review-2026-06
confidence: 0.90
tags: [methodology, bias, replication, failure-mode]
metadata:
  corpus:
    status: active
    qualityScore: 4.4
    riskScore: 0.5
    domain: research
    temporal:
      firstSeen: "2011-01-01T00:00:00Z"
      lastSeen: "2026-06-10T10:30:00Z"
      mentions:
        - { at: "2011-01-01T00:00:00Z", sourceId: nature-review-2026-06, weight: 1.0 }
        - { at: "2026-06-10T10:30:00Z", sourceId: nature-review-2026-06, weight: 1.0 }
    promotionMode: human
    promotedAt: "2026-06-10T10:30:00Z"
    promotedBy: corpus-curator
---

## Summary
Studies that select their sample on the outcome variable or restrict inclusion to high-effect subgroups produce inflated effect sizes that fail to replicate in unselected populations.

## Why it fails
When inclusion criteria correlate with the outcome, the sample is not representative of the target population. The estimated effect is an artifact of the selection process, not a property of the population. Replication studies that sample more broadly will find smaller or null effects.

## Failure modes
- **Outcome-dependent sampling**: recruiting only people who experienced the effect being studied.
- **Subgroup cherry-picking**: reporting the subgroup with the largest effect after observing the data.
- **Survivor bias in longitudinal studies**: only measuring participants who completed the study.
- **Publication bias at meta-analysis level**: including only published (positive) studies.

## Use when
- Evaluating a new source for corpus inclusion: check whether sample selection is described.
- Scoring riskScore for an entry: unexplained heterogeneity across replications raises riskScore.
- Writing critique entries that expose methodological limitations in existing literature.

## Avoid when
- The selection IS the design (e.g., case studies of rare diseases where selection is inherent).
