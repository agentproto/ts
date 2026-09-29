---
schema: collection.schema/v1
name: bugs
title: Bugs
description:
  Defect tracking. Each item captures a reproducible defect with severity, repro
  steps, and an owner accountable for resolution. The status state machine
  encodes the typical triage → fix flow.
version: 1.0.0

fields:
  - name: severity
    type: enum
    enum: [low, medium, high, critical]
    required: true
    description: Impact tier. `critical` items SHOULD page on creation.
  - name: repro
    type: text
    required: true
    description: Minimal repro steps. One numbered list per logical step.
  - name: affectedVersion
    type: string
    required: false
    pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$"
    description: Semver of the version where the bug was first observed.

statuses:
  - id: open
    label: Open
    transitionsTo: [triaged, wontfix]
  - id: triaged
    label: Triaged
    transitionsTo: [in-progress, wontfix]
  - id: in-progress
    label: In progress
    transitionsTo: [fixed, triaged]
  - id: fixed
    label: Fixed
    terminal: true
  - id: wontfix
    label: Won't fix
    terminal: true
initialStatus: open

ownership:
  cardinality: single
  role: assignee
  required: false # bugs may be filed before they have an assignee

deadline:
  kind: none

lints:
  - id: missing-owner-critical
    kind: missing-owner
    appliesTo: "*"
    severity: warn
    params:
      onlyIfFieldEquals:
        field: severity
        value: critical
  - id: stale-30
    kind: stale
    appliesTo: "*"
    severity: info
    params:
      days: 30
  - id: broken-ref
    kind: broken-ref
    appliesTo: "*"
    severity: error

identity:
  slugSource: hash:title,createdAt
  filingPath: items/{collection}/{slug}.md
---

# Bugs

## Purpose

Track defects through triage and resolution. Severity drives escalation; repro
steps drive fix.

## Conventions

- File a bug as soon as a reproducible defect is observed; you don't need to
  know who'll fix it (assignee is optional at creation).
- `repro` is mandatory because a bug without a repro is just a rumour.
- Critical bugs without an assignee surface a `warn` lint — pager / on-call
  owner SHOULD pick them up.
