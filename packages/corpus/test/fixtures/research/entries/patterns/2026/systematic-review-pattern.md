---
schema: knowledge.entry/v1
slug: systematic-review-pattern
kind: pattern
title: Systematic review with hierarchical Bayesian meta-analysis
updated_at: "2026-06-10T10:30:00Z"
sources:
  - nature-review-2026-06
confidence: 0.88
tags: [methodology, meta-analysis, bayesian, replication]
metadata:
  corpus:
    status: active
    qualityScore: 4.5
    riskScore: 0.6
    domain: research
    temporal:
      firstSeen: "2018-01-01T00:00:00Z"
      lastSeen: "2026-06-10T10:30:00Z"
      mentions:
        - { at: "2018-01-01T00:00:00Z", sourceId: nature-review-2026-06, weight: 1.0 }
        - { at: "2026-06-10T10:30:00Z", sourceId: nature-review-2026-06, weight: 1.0 }
    promotionMode: auto
    promotedAt: "2026-06-10T10:30:00Z"
    promotedBy: corpus-curator
---

## Summary
Systematic reviews achieve reliable effect-size estimates when they: (1) pre-register inclusion criteria, (2) apply hierarchical Bayesian pooling to account for between-study heterogeneity, and (3) report credible intervals rather than p-values.

## Why it works
Hierarchical (random-effects) Bayesian models shrink extreme estimates toward the population mean — the replication crisis showed that underpowered studies with extreme point estimates drive non-replication. Pre-registration eliminates post-hoc analysis flexibility.

## Transferable pattern
1. Pre-register: hypothesis, inclusion/exclusion criteria, analysis plan.
2. Screen independently: two reviewers screen abstracts; resolve conflicts by consensus.
3. Pool with hierarchical Bayes: τ² estimates between-study variance; shrink estimates accordingly.
4. Report 95 % credible intervals, not just posterior means.
5. Conduct sensitivity analysis: exclude low-quality studies, check robustness.

## Use when
- Synthesizing a body of empirical literature with heterogeneous study designs.
- The corpus needs a high-confidence summary of a contested empirical question.
- Effect-size estimation matters, not just directional conclusions.

## Avoid when
- Fewer than 10 primary studies exist (insufficient for pooling).
- The research question is qualitative or interpretive rather than quantitative.
