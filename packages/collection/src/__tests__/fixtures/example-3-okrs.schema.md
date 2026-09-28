---
schema: collection.schema/v1
name: okrs
title: OKRs
description:
  Quarterly objectives and their key results. Each item is one objective with
  multiple co-owners, a quarter target date, and a structured set of measurable
  key results.
version: 1.0.0

fields:
  - name: objective
    type: text
    required: true
    description: The qualitative objective. One sentence.
  - name: keyResults
    type: array
    required: true
    description: Measurable key results that gate the objective.
    items:
      type: string
  - name: metric
    type: string
    required: true
    description: The single headline metric for the objective.
  - name: target
    type: number
    required: true
    description: Target value for the metric at the end of the quarter.
  - name: current
    type: number
    required: false
    description: Current value of the metric. Updated by the owner each week.
  - name: quarter
    type: string
    required: true
    pattern: "^[0-9]{4}-Q[1-4]$"
    description: ISO-style quarter identifier, e.g. `2026-Q2`.

statuses:
  - id: planning
    label: Planning
    transitionsTo: [active]
  - id: active
    label: Active
    transitionsTo: [achieved, missed, dropped]
  - id: achieved
    label: Achieved
    terminal: true
  - id: missed
    label: Missed
    terminal: true
  - id: dropped
    label: Dropped
    terminal: true
initialStatus: planning

ownership:
  cardinality: multiple
  role: coLeads
  required: true

deadline:
  kind: target-date
  required: true
  fieldName: targetDate

lints:
  - id: missing-owner
    kind: missing-owner
    appliesTo: "*"
    severity: error
  - id: overdue
    kind: overdue
    appliesTo: "*"
    severity: warn
  - id: required-current
    kind: required-field
    appliesTo: "*"
    severity: info
    params:
      field: current

identity:
  slugSource: title
  filingPath: items/{collection}/{quarter}/{slug}.md
---

# OKRs

## Purpose

Quarterly objectives. One headline metric per objective, multiple key results,
multiple co-leads. The target-date deadline and the multi-owner cardinality are
the two non-default knobs.

## Conventions

- Every OKR carries one and only one `metric`. If you need two, file two OKRs.
- `current` is updated weekly; the `required-current` lint surfaces missing
  updates as an `info` finding.
- Co-leads share accountability; mark all of them, not just a primary.
