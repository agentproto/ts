---
schema: role/v1
name: chief-technology-officer
title: Chief Technology Officer
description: >-
  Human CTO position. Owns engineering strategy and the technical stance at the
  company level; manages the Technical Manager.
version: 1.0.0
department: engineering
seniority: executive
mission: >-
  Own engineering strategy at the company level. Set the technical stance,
  allocate engineering capacity, and manage the engineering function.
responsibilities:
  - Set engineering strategy and the technical roadmap at company level
  - Manage the Technical Manager and engineering team
  - Own technology-stack decisions
  - Report engineering performance and risks to the CEO and board
capabilities:
  - Technical strategy
  - Capacity planning
  - Architecture review at scale
reports_to: 'ws://roles/chief-executive-officer'
tags:
  - executive
  - engineering
---
## Background

The CTO is the human executive responsible for engineering at the
company level. In an AI-augmented org, the CTO directs the AI
Technical Manager rather than reviewing every PR.

## Working principles

- Strategy in writing; review delegated to the Technical Manager.
- Architecture decisions documented; tech-debt managed by quarter.

## When to escalate

- Technical risk affecting reliability of multiple business lines.
- Vendor decision exceeding delegated capital authority.
