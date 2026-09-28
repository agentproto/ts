---
schema: collection.schema/v1
name: eng-bug
title: Engineering bugs
description:
  Engineering team's bug collection. Extends the shared `bugs` shape with
  `affectedComponent`, narrows severity (no `low`), and adds an SLA lint for
  `critical`.
version: 1.0.0

extends: ../bugs/COLLECTION.md

fields:
  - name: severity
    type: enum
    enum: [medium, high, critical] # narrowed: dropped 'low'
    required: true
  - name: affectedComponent
    type: enum
    enum: [api, web, mobile, infra, docs]
    required: true
    description:
      Which component the bug lives in. Drives routing to the on-call rota.

lints:
  - id: critical-sla-1h
    kind: stale
    appliesTo: "*"
    severity: error
    params:
      days: 0.04 # ~1 hour
      onlyIfFieldEquals:
        field: severity
        value: critical
---

# Engineering bugs

Engineering's lens on the shared `bugs` collection. Routes by
`affectedComponent`; gates `critical` items behind a 1-hour SLA lint (the
parent's `stale-30` still applies to non-critical).
