---
schema: collection.schema/v1
name: incidents
title: Production incidents
description:
  Production incidents. Extends `eng-bug` with `impactWindow` and tighter status
  flow. Bound to the ops workspace.
version: 1.0.0

extends: ../eng-bug/COLLECTION.md

appliesTo:
  - ws://workspaces/ops-tracker

fields:
  - name: impactWindow
    type: array
    required: true
    description:
      ISO datetime pairs marking the start and end of customer impact.
    items:
      type: datetime
  - name: severity
    type: enum
    enum: [high, critical] # further narrowed from [medium, high, critical]
    required: true

statuses:
  - id: open
    label: Open
    transitionsTo: [triaged] # narrowed from parent's [triaged, wontfix]
  # `wontfix` deliberately not redeclared — INHERITED but unused
  # because `open.transitionsTo` no longer reaches it. Existing
  # incident items in `wontfix` (if any) still validate.

ownership:
  required: true # narrowed from parent's required: false

deadline:
  kind: target-date
  required: true
  fieldName: targetResolutionAt

lints:
  - id: incident-postmortem
    kind: required-field
    appliesTo: "*"
    severity: warn
    params:
      field: postmortemUrl
---

# Production incidents

Severity floor of `high`; ownership required at file time; `open` only
transitions to `triaged` (no shortcut to `wontfix`, which remains in the schema
only for legacy items).
