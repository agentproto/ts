---
schema: knowledge.workspace/v1
name: marketing-corpus
title: Marketing Expert Corpus
description: |
  Expert marketing knowledge for autonomous agents. Composes AIP-10 (knowledge),
  AIP-12 (playbooks), AIP-18 (curation collections), AIP-9 (operators),
  AIP-15 (workflows), and AIP-41 (routines) into an autonomous improvement loop.
version: 1.0.0
entityTypes:
  - { name: Principle, description: "Durable expert rule" }
  - { name: Example, description: "Concrete source-derived example" }
  - { name: Pattern, description: "Reusable transferable mechanic" }
  - { name: Critique, description: "Negative example or failure mode" }
  - { name: Summary, description: "Compressed source synthesis" }
  - { name: Timeline, description: "Time-sensitive trend evolution" }
  - { name: PlaybookCase, description: "Documented case study of a great playbook" }
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
    domain: marketing
    autoPromote:
      enabled: true
      requires:
        qualityScore: { min: 4.2 }
        riskScore: { max: 1.5 }
        hasArchiveHash: true
        requiredFields: [why_it_works, transferable_pattern, use_when, avoid_when]
        notRestricted: true
    temporal:
      defaultHalfLifeDays: 180
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
      activate-playbook: { allowedRoles: [corpus-curator, admin], requireApproval: true }
      admin-reindex: { allowedRoles: [admin] }
      bypass-default-filters: { allowedRoles: [corpus-curator, admin], audit: true }
---

# Marketing Corpus

Source-of-truth for autonomous marketing agents. Composes AgentProto AIPs into a closed-loop knowledge-improvement system.

## Three loops
- **Knowledge curation** — gap-finder → curator → entries
- **Playbook evolution** — gap → AIP-12 shadow playbook → evaluator → active|archived
- **Retrieval-quality feedback** — every query logged; `utility` + `lift` written back to entries

All corpus-specific policy lives under `metadata.corpus.*`. AIP amendments (A1-A8) may hoist specific fields to first-class later — strictly additive, no rip-and-replace.
