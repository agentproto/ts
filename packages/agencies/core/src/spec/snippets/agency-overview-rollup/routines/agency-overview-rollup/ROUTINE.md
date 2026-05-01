---
schema: agentagencies/v1
doctype: routine
slug: agency-overview-rollup
name: Agency overview rollup
description: |
  Recompute the agency-wide overview snapshot every 10 minutes. The procedure
  walks counterparties/, engagements/, invoices/ and writes a JSON file at
  `_snapshots/agency-overview.json` for the agency.agency-overview canvakit
  template to read.

  Cheap to recompute (a directory walk + frontmatter parse), so the cadence
  errs on the side of fresh. Bump down to 5 minutes if operators complain
  about staleness; bump up to 30 minutes if the agency has hundreds of
  engagements and the walk becomes expensive.

runs: compute-agency-overview
trigger:
  kind: schedule
  cronExpression: "*/10 * * * *"
  timezone: UTC
escalation:
  ifPendingAfter: PT2H
  escalateTo:
    - operator:founder
metadata:
  agency:
    canonical: true
---

# Agency overview rollup

Schedules the **`compute-agency-overview`** procedure every 10 minutes. The
procedure does a single-pass walk of the workspace, projects the aggregate into
a JSON snapshot, and writes it to `_snapshots/agency-overview.json`.

The agency dashboard (canvakit template `agency.agency-overview`) reads the
snapshot via a `kind: file` data source — no live globs at render time, so the
page stays cheap regardless of engagement count.

## When to override this routine

Fork this ROUTINE.md if you need:

- **A different cadence** — change `cronExpression`. Match it to your operators'
  working hours if you don't need 24/7 freshness.
- **An additional snapshot** — copy this routine, change `runs` to a sibling
  procedure that writes a different snapshot file (e.g.,
  `_snapshots/cashflow.json` for a cashflow widget).
- **Per-vertical aggregations** — your `compute-agency-overview` procedure can
  branch on `AGENCY.md.verticals[]` and emit verticalized stats.

## How to disable

Delete this file. The procedure can still be invoked ad-hoc via
`runProcedureTool({ slug: "compute-agency-overview" })`, and the dashboard will
simply show whatever snapshot is on disk (or render the staleness banner if
none).
