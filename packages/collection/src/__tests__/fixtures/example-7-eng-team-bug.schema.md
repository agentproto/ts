---
schema: collection.schema/v1
name: eng-team-bug
title: Engineering team — bug view
description:
  Engineering team's view of the shared `bugs` collection, bound to the
  eng-tracker workspace. Adds component routing and a 1-hour SLA on `critical`.
  Bound exclusively to the eng-tracker workspace via appliesTo.
version: 1.0.0

extends: ../bugs/COLLECTION.md

appliesTo:
  - ws://workspaces/eng-tracker

fields:
  - name: affectedComponent
    type: enum
    enum: [api, web, mobile, infra, docs]
    required: true

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

# Engineering team — bug view

Eng-tracker's local lens on the shared bugs collection. Outside the eng-tracker
workspace, the parent `bugs` collection applies unchanged.
