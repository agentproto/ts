---
name: Update corpus index
id: update-corpus-index
description: |
  Regenerate _index.md (faceted catalog) from the current set of
  active entries. Triggered on promotion, deprecation, or
  status changes; can also run on demand.
version: "1.0.0"
inputs:
  type: object
  properties:
    reason: { type: string, enum: [promoted, deprecated, archived, manual] }
outputs:
  type: object
  required: [entryCount]
  properties:
    entryCount: { type: integer }
    indexBytes: { type: integer }
steps:
  - id: snapshot
    kind: tool
    tool: corpus-read-snapshot
    name: Read current workspace snapshot
  - id: regen
    kind: tool
    tool: corpus-regen-index
    name: Write _index.md from active entries (kind facets)
  - id: log
    kind: tool
    tool: corpus-log-event
    name: Log corpus.entry.indexed event
tags: [corpus, index]
metadata:
  corpus:
    domain: marketing
---

# Update corpus index workflow

Maintenance workflow — keeps `_index.md` in sync with the entries directory. The promote workflow inlines this; standalone version is for drift recovery.
