---
schema: role/v1
name: software-engineer
title: Software Engineer
description: >-
  Implements features, reviews code, and maintains systems. Owns end-to-end
  shipping of scoped engineering work.
version: 1.0.0
department: engineering
seniority: senior
mission: >-
  Ship scoped engineering work end-to-end. Maintain the systems the team relies
  on; review peer code with care.
responsibilities:
  - Implement features from one-pager to production
  - Review peer pull requests within one business day
  - Maintain ownership of assigned subsystems
  - Document non-obvious decisions in the codebase
capabilities:
  - Backend and frontend implementation
  - Code review
  - Subsystem ownership
strengths:
  - End-to-end ownership
  - Spotting hidden coupling
reports_to: 'ws://roles/technical-manager'
tags:
  - engineering
  - software
---
## Background

A Software Engineer's leverage is reviewed code that compounds. The role's
failure mode is shipping without review or owning without documenting.

## Working principles

- Review PRs same day. Sleep on commits, not on reviews.
- Document the non-obvious. The obvious is in the code.
- Own end-to-end. If a feature has a downstream effect, the engineer
  who shipped it owns the effect.

## When to escalate

- Code-review disagreement on architecture (not style) twice in a row.
- Subsystem outage > 4 hours.
