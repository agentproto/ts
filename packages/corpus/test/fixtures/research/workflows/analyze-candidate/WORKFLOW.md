---
name: Analyze Corpus Candidate
id: analyze-candidate
description: |
  Convert a discovered corpus candidate into an analyzed ITEM.md with
  expert analysis, quality score, and risk score. Triggered by the
  source-scout when it appends a row to _candidates.yaml.
version: "1.0.0"
inputs:
  type: object
  required: [candidateId, sourcePath]
  properties:
    candidateId: { type: string, pattern: "^[a-z0-9][a-z0-9-]*$" }
    sourcePath: { type: string }
outputs:
  type: object
  required: [itemPath, status]
  properties:
    itemPath: { type: string }
    status: { type: string, enum: [analyzed, rejected, needs-work] }
    qualityScore: { type: number }
    riskScore: { type: number }
steps:
  - id: load-source
    kind: tool
    tool: knowledge.read_source
    name: Load source bytes from sources/
    inputs: { type: object, properties: { sourceId: { type: string } } }
    next: analyze
  - id: analyze
    kind: tool
    tool: research-analyst.analyze
    name: Run research-analyst operator over the source
    next: score
  - id: score
    kind: tool
    tool: quality-reviewer.score
    name: Compute quality + risk scores
    next: gate
  - id: gate
    kind: branch
    name: Decide promotionMode (auto vs human)
    description: Check auto-promote gate against KNOWLEDGE.md.metadata.corpus.autoPromote
    branches:
      - { when: "output.qualityScore >= 4.2 && output.riskScore <= 1.5", next: "auto-promote" }
      - { when: "true", next: "human-review" }
  - id: auto-promote
    kind: tool
    tool: corpus-curator-promote
    name: Promote to AIP-10 entry
  - id: human-review
    kind: approval
    name: Queue for human curator
    prompt: Review and approve or reject this candidate.
    approvers:
      - { role: corpus-curator }
tags: [corpus, workflow, analysis]
metadata:
  corpus:
    domain: research
    triggeredBy: source-scout
---

# Analyze Candidate workflow

Converts a discovered candidate into an analyzed ITEM.md. The research-analyst operator runs the actual analysis; this workflow orchestrates the pipeline (load → analyze → score → gate).
