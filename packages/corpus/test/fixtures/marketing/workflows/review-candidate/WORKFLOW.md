---
name: Review analyzed candidate
id: review-candidate
description: |
  Score an analyzed candidate (quality + risk), set promotionMode,
  route to auto-promote or human-review queue.
version: "1.0.0"
inputs:
  type: object
  required: [candidateId]
  properties:
    candidateId: { type: string }
outputs:
  type: object
  required: [decision]
  properties:
    decision: { type: string, enum: [auto-promote, queue-review, reject] }
    qualityScore: { type: number }
    riskScore: { type: number }
steps:
  - id: load
    kind: tool
    tool: corpus-load-candidate
    name: Load candidate ITEM.md
  - id: score
    kind: tool
    tool: quality-reviewer-score
    name: Compute qualityScore + riskScore via reviewer operator
  - id: gate
    kind: branch
    name: Auto-promote gate
    branches:
      - { when: "output.qualityScore >= 4.2 && output.riskScore <= 1.5", next: "auto-promote" }
      - { when: "output.qualityScore < 2.0 || output.riskScore > 3.0", next: "reject" }
      - { when: "true", next: "queue-review" }
  - id: auto-promote
    kind: tool
    tool: promoteCorpusCandidate
    name: Promote without human gate
  - id: queue-review
    kind: tool
    tool: corpus-route-to-review
    name: Move ITEM.md to corpus-review collection
  - id: reject
    kind: tool
    tool: corpus-log-event
    name: Log corpus.candidate.rejected with reason
tags: [corpus, review]
metadata:
  corpus:
    domain: marketing
    triggeredBy: marketing-analyst
---

# Review candidate workflow

Step 3 of the corpus loop (after `analyze-candidate`). Reviewer scores and routes.
