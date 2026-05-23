---
name: Promote corpus item
id: promote-corpus-item
description: |
  Lift an approved candidate into a published AIP-10 entry. Writes
  the entry file, regenerates _index.md, ships chunks to the
  backing engine, appends a promotion event. Wraps the kit's
  CorpusPromoter.promote().
version: "1.0.0"
inputs:
  type: object
  required: [candidateId, entrySlug, entryKind, entryPath, frontmatter, body]
  properties:
    candidateId: { type: string }
    entrySlug: { type: string }
    entryKind: { type: string, enum: [principle, example, pattern, critique, summary, timeline, playbook] }
    entryPath: { type: string }
    frontmatter: { type: object }
    body: { type: string }
    bypassGate: { type: boolean }
outputs:
  type: object
  required: [entryPath, gatePassed]
  properties:
    entryPath: { type: string }
    versionToken: { type: string }
    chunkCount: { type: integer }
    gatePassed: { type: boolean }
    bypassed: { type: boolean }
steps:
  - id: promote
    kind: tool
    tool: promoteCorpusCandidate
    name: Atomic promote (lock + write + index + chunks + event)
tags: [corpus, promote]
metadata:
  corpus:
    domain: marketing
    triggeredBy: corpus-curator
---

# Promote corpus item workflow

Step 4 of the corpus loop. Single-step wrapper for callers that want the workflow shape; the underlying `CorpusPromoter` does the multi-file transaction.
