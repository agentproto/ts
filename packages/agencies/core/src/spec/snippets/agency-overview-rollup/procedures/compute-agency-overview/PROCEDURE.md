---
schema: agentagencies/v1
doctype: procedure
slug: compute-agency-overview
name: Compute agency overview snapshot
description: |
  Walk the workspace and emit a fresh agency-overview snapshot. Vendor-neutral
  playbook — any orchestration runtime can follow these steps (the canonical
  implementation lives in `@agencies/spec/runtime` as
  `computeAgencyOverview(config)`).

triggers:
  - routine: agency-overview-rollup
requiredSkills:
  - workspace.read
estimatedDuration: PT30S

steps:
  - id: walk-counterparties
    description: |
      List counterparties/*/COUNTERPARTY.md and project the active subset
      (mergedIntoId == null, status != "archived"). Used to count distinct
      counterparties in the snapshot.
    output: in-memory list

  - id: walk-engagements
    description: |
      List engagements/*/ENGAGEMENT.md and parse frontmatter for status,
      activeStep, expected value (sum of AGREEMENT.md line items), and
      requiredSignatures. Group by status to fill `byStatus`. Compute
      `pipelineValueFormatted` = sum of expected value where status ∈
      {`scoping`, `proposed`, `negotiating`}.

  - id: walk-invoices
    description: |
      Scan engagements/*/invoices/*/INVOICE.md. Sum paidAmount per month for
      MRR; collect the top-N most-recent paid invoices for `recentPayments`.

  - id: walk-pending-signatures
    description: |
      Read `_index/pending-signatures.json` (regeneratable; rebuild from
      a directory walk if missing). Group by engagement, compute oldest
      pending age. Tag staleness label per (oldest, threshold).

  - id: project-snapshot
    description: |
      Assemble the result against `AgencyOverviewSnapshot` shape from
      `@agencies/spec/renderers`. Stamp `generatedAt = now`. Validate
      against `agencyOverviewSnapshotSchema` before writing.

  - id: write-snapshot
    description: |
      Atomically write `_snapshots/agency-overview.json`. The dashboard
      reads this file on its next refresh tick.
    output: _snapshots/agency-overview.json

  - id: record-audit
    description: |
      Append a `snapshot.refreshed` entry to `audit/audit-log.jsonl` with
      the row counts as payload (counterparties, engagements, invoices).
      Lets operators see "did the rollup actually run?" in the dashboard's
      audit feed.
    output: audit/audit-log.jsonl (one line)
---

# Compute agency overview snapshot

The vendor-neutral playbook for the agency-overview rollup. The agencies/v1
runtime ships a Node implementation as `computeAgencyOverview()` from
`@agencies/spec/runtime`. Other runtimes (Temporal, n8n, hand-rolled) can follow
the steps above — every step has a deterministic input/output described in the
workspace contract.

## Performance notes

The walk is O(N) over engagements + invoices. For an agency with 500 engagements
and 50 invoices each, expect ~0.5–1s on cold cache. Most cost is in YAML
frontmatter parsing — if that becomes a bottleneck, cache parsed frontmatter
keyed by `(path, mtime)` between invocations.

## Failure modes

- **Corrupted ENGAGEMENT.md** — the walker logs the path + skips the row. The
  audit-log entry includes a `skipped` count so operators see drift.
- **Missing `_index/pending-signatures.json`** — falls back to a fresh walk of
  `signatures/` directories. Slower but correct.
- **Concurrent writes during walk** — the snapshot is a best-effort
  point-in-time view. The next tick (10m) reconciles.
