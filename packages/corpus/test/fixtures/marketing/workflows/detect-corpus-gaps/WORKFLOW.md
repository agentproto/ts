---
name: Detect corpus gaps
id: detect-corpus-gaps
description: |
  Scan the last 30 days of eval-case failures, cluster by
  weakness type, open corpus-gap items with priority. Drives the
  scout's next harvest.
version: "1.0.0"
inputs:
  type: object
  properties:
    windowDays: { type: integer, minimum: 1, maximum: 365, default: 30 }
    minOccurrences: { type: integer, minimum: 1, default: 3 }
outputs:
  type: object
  required: [gapsOpened]
  properties:
    gapsOpened: { type: integer }
    clusters: { type: array }
steps:
  - id: load-failures
    kind: tool
    tool: corpus-load-eval-failures
    name: Load last-N-days eval failures
  - id: cluster
    kind: tool
    tool: gap-finder-cluster
    name: Cluster failures by weakness type + recurrence
  - id: open-gaps
    kind: map
    over: "steps.cluster.output.clusters"
    steps:
      - { id: open, kind: tool, tool: corpus-open-gap }
tags: [corpus, gaps]
metadata:
  corpus:
    domain: marketing
    triggeredBy: gap-finder
---

# Detect corpus gaps workflow

Runs monthly. Reads eval-case results, clusters failures, opens `corpus-gap/*/ITEM.md` items for the scout to read.
