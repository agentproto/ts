---
name: Leboncoin houses
id: leboncoin-houses
description: search, enrich each listing with a commute, filter, render a report, deliver it. The entry module carries the runtime step logic the declarative grammar cannot express (the transform filter).
version: 0.1.0
entry: ./entry.mjs
inputs: {}
outputs: {}
steps:
  - id: search
    kind: tool
    tool: marketplace.search
  - id: routes
    kind: map
    over: $steps.search.ads
    steps:
      - id: route
        kind: tool
        tool: maps.route
  - id: items
    kind: transform
  - id: report
    kind: tool
    tool: report.render
  - id: sent
    kind: tool
    tool: messaging.send
---

# Leboncoin houses

The manifest is the governance-facing mirror; `entry.mjs` is the runtime source
of truth. Reconciliation pins the top-level `(id, kind)` sequence so the two
cannot silently drift.
