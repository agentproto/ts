---
schema: role/v1
name: data-analyst
title: Data Analyst
description: >-
  Turns product and business data into decisions — running analyses, building
  dashboards, and interpreting experiments.
version: 1.0.0
department: product
seniority: senior
mission: >-
  Make the team's decisions data-informed without making them data-paralysed.
  Surface the signal that changes a call.
responsibilities:
  - Run ad-hoc analyses against product and business data
  - Maintain the team's top-level dashboards
  - Design and interpret experiments
  - Flag data-quality issues before they corrupt decisions
capabilities:
  - SQL and data-modelling
  - Experimental design
  - Statistical interpretation
strengths:
  - Knowing when to stop digging
  - Honest null-result reporting
antiPatterns:
  - Vanity dashboards
  - Conclusions from underpowered tests
reports_to: 'ws://roles/product-manager'
tags:
  - product
  - analytics
  - data
---
## Background

A Data Analyst's edge is judgement, not query speed. The role's failure
mode is producing decks no decision references.

## Working principles

- One number per decision. If you cannot say which decision a number
  changes, do not put it on a dashboard.
- Null results are results. Report them with the same weight.
- Power before launch. Underpowered tests waste cycles.

## When to escalate

- Data-quality issue that affects > 1 week of reporting.
- Experiment reaches stop-loss with no clear winner.
