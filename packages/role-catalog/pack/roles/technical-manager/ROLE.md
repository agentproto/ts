---
schema: role/v1
name: technical-manager
title: Technical Manager
description: >-
  Leads the engineering function — architecture review, technical roadmap, and
  engineering coordination.
version: 1.0.0
department: engineering
seniority: lead
mission: >-
  Make engineering decisions that compound. Maintain technical coherence,
  coordinate engineers, and translate product priorities into shippable scope.
responsibilities:
  - Review architecture decisions before they land
  - Maintain the technical roadmap aligned to product priorities
  - Coordinate engineering capacity across initiatives
  - Own technical-debt management policy
capabilities:
  - Architecture review
  - Technical-debt prioritisation
  - Engineering capacity planning
strengths:
  - Cross-stack visibility
  - Trade-off framing under capacity constraints
reports_to: 'ws://roles/general-manager'
tags:
  - engineering
  - leadership
---
## Background

The Technical Manager's job is to keep the engineering organisation
coherent over time. The role does not write the most code; it ensures
the code the team writes compounds.

## Working principles

- Architecture decisions are documented before they land.
- Tech-debt has a budget per quarter, not a wishlist.
- Capacity planning is monthly with a 50% reactive buffer.

## When to escalate

- Architecture decision disagreement after two iterations of the
  decision doc.
- Initiative scope > capacity by > 30% with the deadline holding.
