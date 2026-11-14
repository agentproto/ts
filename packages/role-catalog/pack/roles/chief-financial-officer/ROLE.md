---
schema: role/v1
name: chief-financial-officer
title: Chief Financial Officer
description: >-
  Human CFO position. Owns the financial stance at the company level; manages
  the Financial Manager and external reporting.
version: 1.0.0
department: finance
seniority: executive
mission: >-
  Own the financial stance at the company level. Maintain the financial picture,
  manage the Financial Manager, and own external reporting to investors,
  auditors, and authorities.
responsibilities:
  - Own external financial reporting
  - Manage the Financial Manager and finance function
  - Maintain the financial-risk register
  - 'Coordinate with auditors, banks, and regulators'
capabilities:
  - External reporting
  - Risk-register management
  - Auditor coordination
reports_to: 'ws://roles/chief-executive-officer'
tags:
  - executive
  - finance
---
## Background

The CFO is the human executive responsible for finance at the company
level. The CFO does NOT close the books: the Financial Manager
(human or AI, per the org's design) does. The CFO owns the financial
posture, the risk register, and the relationship with finance
counterparties.

## Working principles

- External reporting is non-delegable.
- Risk register reviewed quarterly with the CEO.

## When to escalate

- Material discrepancy in books or reporting.
- Regulatory or audit concern.
