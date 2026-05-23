---
name: Evaluate agent output
id: evaluate-agent-output
description: |
  Score an agent output against a rubric via the pluggable
  IEvaluator (M9). Wins seed flagCorpusLearning candidates;
  losses feed detect-corpus-gaps.
version: "1.0.0"
inputs:
  type: object
  required: [prompt, response, rubricSlug]
  properties:
    prompt: { type: string }
    response: { type: string }
    rubricSlug: { type: string }
    operatorRef: { type: string }
    conversationId: { type: string }
    retrievedHits:
      type: array
      items: { type: object }
outputs:
  type: object
  required: [score]
  properties:
    score: { type: number }
    dimensions: { type: object }
    rationale: { type: string }
    routedAs: { type: string, enum: [win, loss, neutral] }
steps:
  - id: evaluate
    kind: tool
    tool: evaluator-evaluate
    name: Run IEvaluator against the rubric
  - id: classify
    kind: branch
    name: Route win / loss / neutral
    branches:
      - { when: "output.score >= 0.7", next: "as-win" }
      - { when: "output.score < 0.4", next: "as-loss" }
      - { when: "true", next: "as-neutral" }
  - id: as-win
    kind: tool
    tool: flagCorpusLearning
    name: Seed a candidate from the winning trace
  - id: as-loss
    kind: tool
    tool: corpus-record-eval-failure
    name: Add to the eval-failure log for gap-finder
  - id: as-neutral
    kind: tool
    tool: corpus-log-event
    name: Log neutral outcome (no candidate spawn)
tags: [corpus, eval, telemetry]
metadata:
  corpus:
    domain: marketing
    requires:
      pluggable: [evaluator]
---

# Evaluate agent output workflow

Closes loop #3 (retrieval quality). Every agent output that's worth evaluating runs through this. Win / loss / neutral routing feeds the curation queue + the gap finder.
