---
schema: collection.schema/v1
name: corpus-candidate
title: Corpus Candidate
description: |
  Candidate corpus item awaiting analysis and promotion to an AIP-10 entry.
  Discovered candidates live in `_candidates.yaml` sidecar; materialized
  ITEM.md files appear only after transition out of `discovered`.
version: 1.0.0
initialStatus: discovered
statuses:
  - { id: discovered, label: Discovered, transitionsTo: [analyzed, rejected] }
  - { id: analyzed, label: Analyzed, transitionsTo: [approved, rejected, needs-work] }
  - { id: needs-work, label: Needs Work, transitionsTo: [analyzed, rejected] }
  - { id: approved, label: Approved, terminal: true }
  - { id: rejected, label: Rejected, terminal: true }
identity:
  slugSource: id
  filingPath: "collections/corpus-candidate/{slug}/ITEM.md"
fields:
  - { name: sourcePath, type: string, required: true }
  - { name: sourceUrl, type: url }
  - { name: targetEntryPath, type: string }
  - { name: corpusKind, type: enum, enum: [principle, example, pattern, critique, summary, timeline], required: true }
  - { name: qualityScore, type: number }
  - { name: riskScore, type: number }
  - { name: promotionMode, type: enum, enum: [auto, human] }
  - { name: contentHash, type: string }
  - { name: reviewerNotes, type: text }
lints:
  - { id: required-field-source-path, kind: required-field, appliesTo: "*", severity: error, params: { fields: [sourcePath] } }
  - { id: required-field-corpus-kind, kind: required-field, appliesTo: "*", severity: error, params: { fields: [corpusKind] } }
metadata:
  corpus:
    description: Used by source-scout (writes), research-analyst (writes), quality-reviewer (scores), corpus-curator (promotes).
---

# Corpus Candidate collection

Holds candidates discovered by the scout, analyzed by the analyst, scored by the reviewer, and promoted by the curator. State machine enforced by `statuses[].transitionsTo`. Domain-agnostic — the `corpusKind` field drives which entry type the analyst targets.
