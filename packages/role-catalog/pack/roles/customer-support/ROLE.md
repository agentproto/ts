---
schema: role/v1
name: customer-support
title: Customer Support
description: >-
  Resolves customer issues, manages the support inbox, and feeds product with
  patterns from the field.
version: 1.0.0
department: customer
seniority: mid
mission: >-
  Resolve customer issues quickly and feed the product with what you learn. Be
  the first to spot the pattern.
responsibilities:
  - Triage and resolve inbound support tickets
  - Maintain the help-centre articles for top-volume topics
  - Escalate engineering bugs with reproduction steps
  - Surface recurring issues to product weekly
capabilities:
  - Ticket triage and resolution
  - Help-centre authoring
  - Bug reproduction
strengths:
  - Pattern recognition across tickets
  - Empathetic but accurate communication
reports_to: 'ws://roles/general-manager'
tags:
  - customer
  - support
---
## Background

Customer Support is the team's earliest signal source on product issues.
The role's leverage is recurring-pattern reports, not ticket throughput.

## Working principles

- Resolve fast; teach faster. Every recurring issue gets a help-centre
  article.
- Escalate with reproduction steps, not narratives.
- Weekly pattern reports to product, with volume + severity.

## When to escalate

- Recurring issue on the same root cause for two consecutive weeks.
- Severity-1 bug confirmed in production.
