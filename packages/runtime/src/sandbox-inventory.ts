/**
 * Unified sandbox inventory: one read across every concrete provider's
 * control plane and, optionally, its usage ledger.
 *
 * Each provider is scanned INDEPENDENTLY. A provider that is not configured,
 * cannot enumerate its boxes, or throws is reported in `notScanned` /
 * `errors` for THAT provider and never makes the call fail or hides another
 * provider's rows. Rows are tagged with the provider that produced them and
 * deduplicated on `provider + id` (a provider that reports the same box
 * twice, or the same box id from two providers, stays distinct per provider).
 */
import type { SandboxBox, SandboxProvider, SandboxUsageWindow } from "@agentproto/sandbox"
import {
  DEFAULT_SANDBOX_PROVIDER_SLUGS,
  makeSandboxCredsStore,
  makeSandboxResolver,
} from "./sandbox-adapters.js"
import type { SandboxProviderHandle } from "./sandbox-providers/types.js"

/** The slice of a provider the inventory reads. Kept structural so callers
 *  (and tests) can pass a provider that only implements the optional list or
 *  usage methods. */
export type SandboxInventoryProvider = Pick<SandboxProvider, "list" | "usage">

/** A provider already resolved to a handle. */
export interface SandboxInventorySource {
  /** Catalog slug the rows are tagged with. */
  slug: string
  provider: SandboxInventoryProvider
}

/** A provider source, or a slug to resolve through `resolveProvider`. */
export type SandboxInventoryProviderInput = string | SandboxInventorySource

export interface CollectSandboxInventoryOpts {
  /** Providers to read. Defaults to {@link DEFAULT_SANDBOX_PROVIDER_SLUGS}.
   *  Entries may be slugs (resolved with `resolveProvider`) or handles. */
  providers?: readonly SandboxInventoryProviderInput[]
  /** Resolver for slug inputs. Defaults to the sandbox creds store. */
  resolveProvider?: (slug: string) => Promise<SandboxProviderHandle | null>
  /** Read usage windows too. One provider without `usage()` is not scanned
   *  for usage and is reported as such. */
  includeUsage?: boolean
  /** Usage window start (ISO-8601). Defaults to 24 hours before `to`. */
  from?: string
  /** Usage window end (ISO-8601). Defaults to now. */
  to?: string
}

export interface SandboxInventoryTotals {
  activeSec: number
  vcpuSec: number
  gibSec: number
  /** Sum of the windows whose cost is known; `null` costs are excluded. */
  costEur: number
  /** True when at least one usage window had no cost model (`costEur: null`),
   *  so the total is a lower bound. */
  costPartial: boolean
}

export interface SandboxInventory {
  boxes: SandboxBox[]
  usage: SandboxUsageWindow[]
  totals: SandboxInventoryTotals
  /** Providers whose control plane or usage ledger threw. Never fatal. */
  errors: Array<{ provider: string; error: string }>
  /** Providers that could not be read, and why (unconfigured, no list/usage,
   *  unknown slug). */
  notScanned: Array<{ provider: string; reason: string }>
}

/** Default usage window: the last 24 hours. */
function defaultUsageWindow(opts: { from?: string; to?: string }): { from: string; to: string } {
  const now = new Date()
  const to = opts.to ?? now.toISOString()
  if (opts.from !== undefined) return { from: opts.from, to }
  const end = Date.parse(to)
  const base = Number.isFinite(end) ? end : now.getTime()
  return { from: new Date(base - 24 * 60 * 60 * 1000).toISOString(), to }
}

/** Fill only the fields the first row did not report. Never overwrites a
 *  known value with an unknown one. */
function mergeBox(existing: SandboxBox, next: SandboxBox): SandboxBox {
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(next)) {
    if (merged[key] === undefined && value !== undefined) merged[key] = value
  }
  return merged as unknown as SandboxBox
}

function totalsOf(usage: readonly SandboxUsageWindow[]): SandboxInventoryTotals {
  let activeSec = 0
  let vcpuSec = 0
  let gibSec = 0
  let costEur = 0
  let costPartial = false
  for (const window of usage) {
    activeSec += window.activeSec
    vcpuSec += window.vcpuSec
    gibSec += window.gibSec
    if (window.costEur === null) costPartial = true
    else costEur += window.costEur
  }
  return { activeSec, vcpuSec, gibSec, costEur, costPartial }
}

/**
 * Read every provider's boxes (and optionally usage windows), tagging rows
 * and merging duplicates on `provider + id`. Provider failures are reported
 * individually; the returned inventory always contains every row the other
 * providers produced.
 */
export async function collectSandboxInventory(
  opts: CollectSandboxInventoryOpts = {},
): Promise<SandboxInventory> {
  const inputs = opts.providers && opts.providers.length > 0 ? opts.providers : DEFAULT_SANDBOX_PROVIDER_SLUGS
  const resolveProvider =
    opts.resolveProvider ?? makeSandboxResolver(makeSandboxCredsStore())
  const includeUsage = opts.includeUsage === true
  const range = includeUsage ? defaultUsageWindow(opts) : undefined

  const errors: SandboxInventory["errors"] = []
  const notScanned: SandboxInventory["notScanned"] = []
  const boxes: SandboxBox[] = []
  const boxIndex = new Map<string, number>()
  const usage: SandboxUsageWindow[] = []

  for (const input of inputs) {
    let source: SandboxInventorySource
    if (typeof input === "string") {
      let handle: SandboxProviderHandle | null
      try {
        handle = await resolveProvider(input)
      } catch (err) {
        errors.push({ provider: input, error: err instanceof Error ? err.message : String(err) })
        continue
      }
      if (!handle) {
        notScanned.push({ provider: input, reason: "the provider is not available (not installed or unknown)" })
        continue
      }
      source = { slug: input, provider: handle.provider }
    } else {
      source = input
    }

    const reasons: string[] = []
    const list = source.provider.list
    if (typeof list !== "function") {
      reasons.push("the provider cannot enumerate its boxes (no list)")
    } else {
      try {
        const rows = await list.call(source.provider, range)
        for (const row of rows) {
          const tagged = { ...row, provider: source.slug as SandboxBox["provider"] }
          const key = `${source.slug}\u0000${row.id}`
          const at = boxIndex.get(key)
          if (at === undefined) {
            boxIndex.set(key, boxes.length)
            boxes.push(tagged)
          } else {
            boxes[at] = mergeBox(boxes[at] as SandboxBox, tagged)
          }
        }
      } catch (err) {
        errors.push({
          provider: source.slug,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (includeUsage) {
      const usageFn = source.provider.usage
      if (typeof usageFn !== "function") {
        reasons.push("the provider has no usage ledger (no usage)")
      } else if (range !== undefined) {
        try {
          const windows = await usageFn.call(source.provider, { from: range.from, to: range.to })
          for (const window of windows) {
            usage.push({ ...window, provider: source.slug as SandboxUsageWindow["provider"] })
          }
        } catch (err) {
          errors.push({
            provider: source.slug,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    if (reasons.length > 0) {
      notScanned.push({ provider: source.slug, reason: reasons.join("; ") })
    }
  }

  return {
    boxes,
    usage,
    totals: totalsOf(usage),
    errors,
    notScanned,
  }
}
