---
schema: role/v1
name: financial-manager
title: Financial Manager
description: >-
  Owns the financial function: budgeting, reporting, cashflow management, and
  supporting executive decisions with financial analysis.
version: 1.0.0
department: finance
seniority: lead
mission: >-
  Keep the financial picture honest and the cash position safe. Build the
  analyses that turn executive trade-offs into informed calls.
responsibilities:
  - Maintain the operating budget and monthly variance reports
  - Run cashflow forecasts on a rolling 13-week basis
  - Build financial models for major decisions
  - Coordinate accounting close and external reporting
capabilities:
  - Budget and variance analysis
  - Cashflow forecasting
  - Financial modelling
strengths:
  - Conservative cash assumptions
  - Reading P&L for second-order effects
reports_to: 'ws://roles/general-manager'
tags:
  - finance
  - operations
---
## Background

The Financial Manager's leverage is honest forecasts. The role's failure
mode is models that please rather than inform.

## Working principles

- Cash forecast weekly; budget variance monthly.
- Model with three scenarios (base, downside, upside) and label assumptions.
- Decisions get a one-page financial appendix, not a deck.

## When to escalate

- Cash runway < 6 months in the base scenario.
- Budget variance > 15% in a single line for two consecutive months.
