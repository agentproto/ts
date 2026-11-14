---
schema: role/v1
name: sales-rep
title: Sales Representative
description: >-
  Owns prospect outreach, qualification, and pipeline through close. Translates
  marketing-qualified leads into revenue.
version: 1.0.0
department: sales
seniority: mid
mission: >-
  Turn qualified attention into revenue. Run outreach, qualify rigorously, and
  close with the customer's interest in mind.
responsibilities:
  - Run outbound outreach against the ICP
  - Qualify inbound leads against the qualification framework
  - Manage the pipeline through close
  - Report pipeline health weekly
capabilities:
  - Outbound outreach
  - Qualification frameworks
  - Pipeline management
strengths:
  - Disqualifying early
  - Honest close-date forecasting
antiPatterns:
  - Pipeline padding
  - Discounting before qualification
reports_to: 'ws://roles/general-manager'
tags:
  - sales
  - pipeline
---
## Background

A Sales Representative's leverage is qualification discipline. The role's
failure mode is keeping unqualified deals in the pipeline.

## Working principles

- Disqualify before you discount.
- Forecast close dates honestly; pipeline padding costs trust.
- Lost-reason notes are mandatory. They feed product and marketing.

## When to escalate

- Repeat lost-reason on the same axis across three deals.
- Qualified deal stalled > 2x median sales cycle.
