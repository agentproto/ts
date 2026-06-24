---
schema: knowledge.workspace/v1
name: research-corpus
title: Research Expert Corpus
description: |
  Domain-agnostic research knowledge for autonomous agents. Composes AIP-10 (knowledge),
  AIP-18 (curation collections), AIP-9 (operators), AIP-15 (workflows), and AIP-41
  (routines) into an autonomous discovery-and-improvement loop.
version: 1.0.0
entityTypes:
  - { name: Principle, description: "Durable finding or research rule" }
  - { name: Example, description: "Concrete source-derived example or case study" }
  - { name: Pattern, description: "Reusable transferable methodology or mechanic" }
  - { name: Critique, description: "Negative example, failure mode, or methodological flaw" }
  - { name: Summary, description: "Compressed synthesis of a source or topic cluster" }
  - { name: Timeline, description: "Time-sensitive trend or field evolution" }
sources:
  retention: forever
  signing: optional
  hashAlgo: sha256
  authorityDefault: secondary
lints:
  - { id: require-source-on-examples, kind: require-source, appliesTo: Example, severity: error }
  - { id: min-confidence-principles, kind: min-confidence, appliesTo: Principle, severity: warn, params: { min: 0.6 } }
  - { id: max-age-timelines, kind: max-age, appliesTo: Timeline, severity: warn, params: { days: 730 } }
  - { id: max-age-summaries, kind: max-age, appliesTo: Summary, severity: warn, params: { days: 180 } }
  - { id: broken-ref-all, kind: broken-ref, appliesTo: "*", severity: error }
  - { id: orphan-all, kind: orphan, appliesTo: "*", severity: info }
curation:
  tone: "neutral, expert, source-backed"
  depth: medium
  autoLink: byName
  conflictResolution: authority
queryHints:
  preferRecent: true
  preferAuthoritative: true
metadata:
  corpus:
    version: 1
    domain: research
    entryLayout:
      kind: hierarchical
      groupBy: entityType
    autoPromote:
      enabled: true
      requires:
        qualityScore: { min: 4.2 }
        riskScore: { max: 1.5 }
        hasArchiveHash: true
        requiredFields: [why_it_works, transferable_pattern, use_when, avoid_when]
        notRestricted: true
    temporal:
      defaultHalfLifeDays: 365
      scoreFormula: max-mention-decay
    retrievalBoosts:
      qualityScore: { weight: 0.30 }
      temporalScore: { weight: 0.20 }
      mentionCount: { weight: 0.10 }
      confidence: { weight: 0.15 }
    retrievalDefaults:
      status: active
      minQualityScore: 3.5
      minTemporalScore: 0.1
    accessModes:
      read: { allowedRoles: ["*"] }
      cite: { allowedRoles: ["*"] }
      flag-learning: { allowedRoles: ["*"], rateLimit: { perOperator: 20, window: "24h" } }
      curate: { allowedRoles: [corpus-curator, admin] }
      promote: { allowedRoles: [corpus-curator, admin] }
      admin-reindex: { allowedRoles: [admin] }
      bypass-default-filters: { allowedRoles: [corpus-curator, admin], audit: true }
---

# Research Corpus

Source-of-truth for autonomous research agents. Composes AgentProto AIPs into a closed-loop knowledge-improvement system for any domain.

## Three loops
- **Knowledge curation** — source-scout → analyst → entries
- **Quality gating** — quality-reviewer scores + routes (auto-promote vs human review)
- **Retrieval-quality feedback** — every query logged; `utility` + `lift` written back to entries

All corpus-specific policy lives under `metadata.corpus.*`. The six entity types (Principle, Example, Pattern, Critique, Summary, Timeline) are domain-agnostic — topics come from sources, not from the scaffold.
