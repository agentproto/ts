---
name: Ingest source
id: ingest-source
description: |
  Fetch + hash + dedup + archive a single source. Output: a new
  candidate row in _candidates.yaml (or no-op if duplicate).
version: "1.0.0"
inputs:
  type: object
  required: [sourceUrl]
  properties:
    sourceUrl: { type: string }
    category: { type: string, enum: [fresh, classic, competitors, internal, performance] }
outputs:
  type: object
  required: [outcome]
  properties:
    outcome: { type: string, enum: [archived, duplicate, rejected] }
    sourceId: { type: string }
    candidateId: { type: string }
steps:
  - id: fetch
    kind: tool
    tool: web-fetch
    name: Fetch source content
  - id: hash
    kind: tool
    tool: hash-content
    name: Compute sha256 content_hash
  - id: dedup
    kind: branch
    name: Dedup against existing sources
    branches:
      - { when: "output.duplicate === true", next: "done-dup" }
      - { when: "true", next: "archive" }
  - id: archive
    kind: tool
    tool: corpus-archive-source
    name: Write source frontmatter + body to sources/<category>/<slug>.md
  - id: create-candidate
    kind: tool
    tool: createCorpusCandidate
    name: Append discovered row to _candidates.yaml
  - id: done-dup
    kind: tool
    tool: corpus-log-event
    name: Log dedup hit (no-op outcome)
tags: [corpus, ingest, scout]
metadata:
  corpus:
    domain: marketing
    triggeredBy: source-scout
---

# Ingest source workflow

Step 1 of the corpus loop. Single-source entry point. Called by `daily-source-scout` once per discovered URL.
