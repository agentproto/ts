/**
 * `computeAgencyOverview` — canonical Node implementation of the
 * `procedures/compute-agency-overview` PROCEDURE.md.
 *
 * Walks the workspace (counterparties/, engagements/, invoices/), projects
 * the aggregate into an `AgencyOverviewSnapshot`, optionally writes it to
 * `_snapshots/agency-overview.json`. Vendor-neutral — uses the
 * `IGovernanceFilesystem` adapter from `@agentproto/governance/runtime` so it
 * runs against LocalFilesystem in dev and SupabaseFilesystem in prod
 * without code changes.
 *
 * Designed to be called from:
 *   - A Mastra workflow (`@agentproto/agencies-mastra` codegen wraps this in suspend/
 *     resume primitives if needed).
 *   - A cron-driven routine engine (e.g. Guilde's routine-executor).
 *   - Ad-hoc by a CLI (`agencies overview compute <workspace>`).
 *
 * The compute is single-pass — no memoization, no incremental cache. For
 * very large agencies (>500 engagements) this should be replaced with a
 * watch-based incremental rebuild.
 */

import * as path from "node:path"

import {
  defaultGovernanceFilesystem,
  resolveFromRoot,
  type GovernanceConfig,
  type IGovernanceFilesystem,
} from "@agentproto/governance-engine"
import matter from "gray-matter"

import {
  agencyOverviewSnapshotSchema,
  isAgencyOverviewSnapshotStale,
  type AgencyOverviewSnapshot,
  AGENCY_OVERVIEW_FRESHNESS_MS,
} from "@agentproto/agencies/renderers"

export interface ComputeAgencyOverviewInput {
  /**
   * Workspace root + filesystem adapter. The same `GovernanceConfig` used by
   * the governance runtime — pass the whole config so Supabase-backed
   * workspaces work via `MastraFilesystemGovernanceAdapter`.
   *
   * Only `workspaceRoot` and `filesystem` are read; secrets (genesisSeed,
   * hmacSecret) are not used here.
   */
  config: Pick<GovernanceConfig, "workspaceRoot" | "filesystem">

  /**
   * If true, atomically write the snapshot to
   * `_snapshots/agency-overview.json`. Default: true.
   */
  write?: boolean

  /**
   * Override the `now` clock for deterministic tests.
   */
  now?: Date

  /**
   * Override the staleness threshold. Default: AGENCY_OVERVIEW_FRESHNESS_MS.
   */
  freshnessMs?: number

  /**
   * How many recent payments to include in the snapshot. Default: 5.
   */
  recentPaymentsLimit?: number
}

export interface ComputeAgencyOverviewResult {
  snapshot: AgencyOverviewSnapshot
  /** Workspace-relative path to the written snapshot, or null when `write: false`. */
  snapshotPath: string | null
  /** Counts useful for the audit-log entry the routine writes after a successful run. */
  walked: {
    counterparties: number
    engagements: number
    invoices: number
    skipped: number
  }
}

const SNAPSHOT_REL_PATH = "_snapshots/agency-overview.json"

export async function computeAgencyOverview(
  input: ComputeAgencyOverviewInput
): Promise<ComputeAgencyOverviewResult> {
  const fs = input.config.filesystem ?? defaultGovernanceFilesystem()
  const workspaceRoot = input.config.workspaceRoot
  const now = input.now ?? new Date()
  const freshnessMs = input.freshnessMs ?? AGENCY_OVERVIEW_FRESHNESS_MS
  const recentPaymentsLimit = input.recentPaymentsLimit ?? 5

  let skipped = 0

  // ── 1. Counterparties ──────────────────────────────────────────────
  const counterpartyDirs = await listSubdirs(
    fs,
    workspaceRoot,
    "counterparties"
  )
  const counterparties: Array<{
    slug: string
    displayName: string
    status: string | null
  }> = []
  for (const dir of counterpartyDirs) {
    const fmPath = resolveFromRoot(
      workspaceRoot,
      `counterparties/${dir}/COUNTERPARTY.md`
    )
    const fm = await readFrontmatter(fs, fmPath)
    if (!fm) {
      skipped++
      continue
    }
    counterparties.push({
      slug: dir,
      displayName:
        stringField(fm, "displayName") ?? stringField(fm, "name") ?? dir,
      status: stringField(fm, "status"),
    })
  }

  // ── 2. Engagements ─────────────────────────────────────────────────
  const engagementDirs = await listSubdirs(fs, workspaceRoot, "engagements")
  type EngagementRow = {
    slug: string
    name: string
    status: string
    activeStep: string | null
    counterpartyId: string | null
    counterpartyDisplayName: string
    expectedValue: number
    requiredSignerCount: number
    createdAt: Date | null
  }
  const engagements: EngagementRow[] = []
  for (const dir of engagementDirs) {
    const fmPath = resolveFromRoot(
      workspaceRoot,
      `engagements/${dir}/ENGAGEMENT.md`
    )
    const fm = await readFrontmatter(fs, fmPath)
    if (!fm) {
      skipped++
      continue
    }
    const counterpartyId = stringField(fm, "counterpartyId")
    const counterparty = counterparties.find(c => c.slug === counterpartyId)
    const expectedValue = await readEngagementExpectedValue(
      fs,
      workspaceRoot,
      dir
    )
    engagements.push({
      slug: dir,
      name: stringField(fm, "name") ?? dir,
      status: stringField(fm, "status") ?? "unknown",
      activeStep: stringField(fm, "activeStep"),
      counterpartyId,
      counterpartyDisplayName:
        counterparty?.displayName ?? counterpartyId ?? "—",
      expectedValue,
      requiredSignerCount: countRequiredSignatures(fm),
      createdAt: parseDate(stringField(fm, "createdAt")),
    })
  }

  // ── 3. Invoices ────────────────────────────────────────────────────
  type InvoiceRow = {
    invoiceNumber: string
    amount: number
    currency: string
    status: string
    paidAt: Date | null
    counterpartyDisplayName: string
  }
  const invoices: InvoiceRow[] = []
  for (const eng of engagements) {
    const invoiceDirs = await listSubdirs(
      fs,
      workspaceRoot,
      `engagements/${eng.slug}/invoices`
    )
    for (const invDir of invoiceDirs) {
      const fmPath = resolveFromRoot(
        workspaceRoot,
        `engagements/${eng.slug}/invoices/${invDir}/INVOICE.md`
      )
      const fm = await readFrontmatter(fs, fmPath)
      if (!fm) {
        skipped++
        continue
      }
      invoices.push({
        invoiceNumber: stringField(fm, "invoiceNumber") ?? invDir,
        amount:
          numberField(fm, "totalAmount") ?? numberField(fm, "amount") ?? 0,
        currency: stringField(fm, "currency") ?? "EUR",
        status: stringField(fm, "status") ?? "issued",
        paidAt: parseDate(stringField(fm, "paidAt")),
        counterpartyDisplayName: eng.counterpartyDisplayName,
      })
    }
  }

  // ── 4. Pending signatures index ────────────────────────────────────
  const pendingPath = resolveFromRoot(
    workspaceRoot,
    "_index/pending-signatures.json"
  )
  const pendingRaw = await fs.readFile(pendingPath)
  let pendingByEngagement: Map<string, { count: number; oldest: Date | null }> =
    new Map()
  let pendingTotal = 0
  if (pendingRaw) {
    try {
      const parsed = JSON.parse(pendingRaw) as {
        bySigner?: Record<
          string,
          Array<{ artifactPath?: string; requestedAt?: string }>
        >
      }
      for (const [, list] of Object.entries(parsed.bySigner ?? {})) {
        for (const entry of list ?? []) {
          pendingTotal++
          const m = (entry.artifactPath ?? "").match(/^engagements\/([^/]+)\//)
          const engSlug = m?.[1]
          if (!engSlug) continue
          const requested = parseDate(entry.requestedAt) ?? now
          const cur = pendingByEngagement.get(engSlug) ?? {
            count: 0,
            oldest: null,
          }
          cur.count++
          if (!cur.oldest || requested < cur.oldest) cur.oldest = requested
          pendingByEngagement.set(engSlug, cur)
        }
      }
    } catch {
      // Corrupted index — leave totals at zero rather than failing the snapshot.
    }
  }

  // ── 5. Project the snapshot ────────────────────────────────────────
  const ACTIVE_STATUSES = new Set([
    "scoping",
    "proposed",
    "negotiating",
    "signed",
    "executing",
    "in_progress",
    "in-progress",
    "pending_validation",
  ])
  const PIPELINE_STATUSES = new Set(["scoping", "proposed", "negotiating"])

  const activeEngagements = engagements.filter(e =>
    ACTIVE_STATUSES.has(e.status)
  )
  const pipelineValue = engagements
    .filter(e => PIPELINE_STATUSES.has(e.status))
    .reduce((sum, e) => sum + e.expectedValue, 0)

  // Active-engagements delta = engagements created this calendar month.
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const activeEngagementsDelta = engagements.filter(
    e => e.createdAt && e.createdAt >= monthStart
  ).length

  // MRR — sum of paid invoices in the current calendar month.
  const mrr = invoices
    .filter(i => i.status === "paid" && i.paidAt && i.paidAt >= monthStart)
    .reduce((sum, i) => sum + i.amount, 0)

  // Group engagements by status.
  const byStatusMap = new Map<string, { count: number; value: number }>()
  for (const e of engagements) {
    const cur = byStatusMap.get(e.status) ?? { count: 0, value: 0 }
    cur.count++
    cur.value += e.expectedValue
    byStatusMap.set(e.status, cur)
  }
  const byStatus = Array.from(byStatusMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([status, { count, value }]) => ({
      status,
      pillClass: statusPillClass(status),
      count,
      valueFormatted: formatMoney(value),
    }))

  // Recent payments — top N most-recent paid invoices.
  const recentPayments = invoices
    .filter(i => i.status === "paid" && i.paidAt)
    .sort((a, b) => b.paidAt!.getTime() - a.paidAt!.getTime())
    .slice(0, recentPaymentsLimit)
    .map(i => ({
      invoiceNumber: i.invoiceNumber,
      counterpartyDisplayName: i.counterpartyDisplayName,
      amountFormatted: `${formatMoney(i.amount)} ${i.currency}`,
      paidAt: i.paidAt!.toISOString().slice(0, 10),
    }))

  // Pending-signature engagements — sort oldest-first.
  const pendingByEngagementRows = Array.from(pendingByEngagement.entries())
    .map(([slug, { count, oldest }]) => {
      const eng = engagements.find(e => e.slug === slug)
      const ageMs = oldest ? now.getTime() - oldest.getTime() : 0
      return {
        slug,
        name: eng?.name ?? slug,
        requiredSigners: `${count} pending`,
        oldestPendingAt: oldest ? oldest.toISOString().slice(0, 10) : "—",
        stalenessLabel: ageLabel(ageMs),
        stalenessPillClass: stalenessPillClass(ageMs),
        ageMs,
      }
    })
    .sort((a, b) => b.ageMs - a.ageMs)
    .map(({ ageMs: _ageMs, ...rest }) => rest)

  const snapshotRaw = {
    generatedAt: now.toISOString(),
    isStale: false,
    activeEngagementsCount: activeEngagements.length,
    activeEngagementsDelta,
    pipelineValueFormatted: formatMoney(pipelineValue),
    mrrFormatted: formatMoney(mrr),
    pendingSignaturesCount: pendingTotal,
    byStatus,
    recentPayments,
    pendingByEngagement: pendingByEngagementRows,
  }

  const parsed = agencyOverviewSnapshotSchema.safeParse(snapshotRaw)
  if (!parsed.success) {
    throw new Error(
      `computeAgencyOverview: produced an invalid snapshot — ${parsed.error.issues
        .map(i => i.message)
        .join("; ")}`
    )
  }
  const snapshot = parsed.data
  // Re-stamp isStale against the chosen freshness window so writers and
  // readers agree on staleness without re-checking the clock.
  snapshot.isStale = isAgencyOverviewSnapshotStale(snapshot, freshnessMs, now)

  // ── 6. Write the snapshot ──────────────────────────────────────────
  let snapshotPath: string | null = null
  if (input.write !== false) {
    const abs = resolveFromRoot(workspaceRoot, SNAPSHOT_REL_PATH)
    await fs.ensureDir(path.dirname(abs))
    await fs.writeFileAtomic(abs, JSON.stringify(snapshot, null, 2) + "\n")
    snapshotPath = SNAPSHOT_REL_PATH
  }

  return {
    snapshot,
    snapshotPath,
    walked: {
      counterparties: counterparties.length,
      engagements: engagements.length,
      invoices: invoices.length,
      skipped,
    },
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

async function listSubdirs(
  fs: IGovernanceFilesystem,
  workspaceRoot: string,
  rel: string
): Promise<string[]> {
  const abs = resolveFromRoot(workspaceRoot, rel)
  const entries = await fs.listDirectory(abs)
  return entries.filter(e => e.isDirectory).map(e => e.name)
}

async function readFrontmatter(
  fs: IGovernanceFilesystem,
  absPath: string
): Promise<Record<string, unknown> | null> {
  const content = await fs.readFile(absPath)
  if (!content) return null
  try {
    const parsed = matter(content)
    return parsed.data as Record<string, unknown>
  } catch {
    return null
  }
}

function stringField(fm: Record<string, unknown>, key: string): string | null {
  const v = fm[key]
  if (typeof v === "string") return v
  // YAML 1.1 auto-parses ISO date strings to Date objects (gray-matter →
  // js-yaml). Coerce back to ISO so date-shaped frontmatter fields still
  // expose a string when callers ask for one.
  if (v instanceof Date) return v.toISOString()
  return null
}

function numberField(fm: Record<string, unknown>, key: string): number | null {
  const v = fm[key]
  if (typeof v === "number") return v
  if (typeof v === "string") {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function countRequiredSignatures(fm: Record<string, unknown>): number {
  const v = fm.requiredSignatures
  return Array.isArray(v) ? v.length : 0
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : new Date(ms)
}

async function readEngagementExpectedValue(
  fs: IGovernanceFilesystem,
  workspaceRoot: string,
  engagementSlug: string
): Promise<number> {
  const agreementPath = resolveFromRoot(
    workspaceRoot,
    `engagements/${engagementSlug}/AGREEMENT.md`
  )
  const fm = await readFrontmatter(fs, agreementPath)
  if (!fm) return 0
  const direct =
    numberField(fm, "totalAmount") ?? numberField(fm, "expectedValue")
  if (direct != null) return direct
  // Fall back to summing line items.
  const items = fm.lineItems
  if (Array.isArray(items)) {
    return items.reduce((sum: number, li: unknown) => {
      if (typeof li === "object" && li !== null && "total" in li) {
        const t = (li as { total: unknown }).total
        if (typeof t === "number") return sum + t
      }
      return sum
    }, 0)
  }
  return 0
}

function statusPillClass(
  status: string
): "" | "ok" | "warn" | "danger" | "muted" {
  switch (status) {
    case "signed":
    case "executing":
    case "in_progress":
    case "in-progress":
      return "ok"
    case "pending_validation":
    case "negotiating":
    case "proposed":
    case "scoping":
      return "warn"
    case "disputed":
    case "cancelled":
    case "void":
      return "danger"
    case "closed":
    case "archived":
      return "muted"
    default:
      return ""
  }
}

function stalenessPillClass(ageMs: number): "" | "ok" | "warn" | "danger" {
  const day = 24 * 60 * 60 * 1000
  if (ageMs < 2 * day) return "ok"
  if (ageMs < 7 * day) return "warn"
  return "danger"
}

function ageLabel(ageMs: number): string {
  if (ageMs <= 0) return "just now"
  const min = Math.round(ageMs / 60000)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr}h`
  const day = Math.round(hr / 24)
  return `${day}d`
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
