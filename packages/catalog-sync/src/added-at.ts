/**
 * `addedAt` ledger — tracks, per generator, the ISO date each model id was
 * FIRST seen by a sync run. See `README.md` ("addedAt convention") for the
 * full contract; this module is the mechanism.
 *
 * Invariant: once an id has a ledger entry, that date is NEVER overwritten —
 * not even if the source's own `created` timestamp for that id later
 * resolves to something different (a provider backdating/correcting its own
 * metadata must not rewrite catalog history). New ids are backfilled from
 * the source's own creation timestamp when it has one, else stamped with
 * the current run's date.
 *
 * Ledger entries are never dropped when an id disappears from a run — the
 * ledger records "first ever seen", not "currently present". A model that
 * vanishes from a provider's list and later reappears keeps its original
 * `addedAt` rather than looking newly added.
 *
 * Each generator owns one ledger file, committed at
 * `packages/catalog-sync/ledger/<generator-id>.json` (id → ISO date, sorted
 * keys, deterministic serialization) — included as a normal entry in the
 * generator's `GeneratedFiles` return value, so `runner.ts`'s existing
 * diff/write logic covers it for free (including `--check` drift detection).
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** The catalog-sync package directory — see `runner.ts`'s `catalogSyncDir`. */
function catalogSyncDir(): string {
  return resolve(__dirname, "..")
}

/** Absolute path to a generator's committed addedAt ledger. */
export function ledgerAbsPath(ledgerId: string): string {
  return join(catalogSyncDir(), "ledger", `${ledgerId}.json`)
}

/** Repo-relative path for a ledger — for inclusion in a generator's `GeneratedFiles`. */
export function ledgerRelPath(ledgerId: string): string {
  return `packages/catalog-sync/ledger/${ledgerId}.json`
}

export type AddedAtLedger = Record<string, string>

/** Reads a committed ledger from disk. Missing/unparseable → empty ledger. */
export function readLedger(ledgerId: string): AddedAtLedger {
  const path = ledgerAbsPath(ledgerId)
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as AddedAtLedger
  } catch {
    return {}
  }
}

/** Deterministic (sorted-key) JSON serialization, matching the `*.generated.ts` style of a trailing newline. */
export function serializeLedger(ledger: AddedAtLedger): string {
  const sorted: AddedAtLedger = {}
  for (const id of Object.keys(ledger).sort()) sorted[id] = ledger[id]!
  return `${JSON.stringify(sorted, null, 2)}\n`
}

/**
 * Merge the current run's ids into a ledger.
 *
 * - id already in `previous` → keep the existing stamp verbatim (never
 *   mutated), regardless of what `createdAt` says this run.
 * - id new to the ledger, source has a native creation timestamp for it →
 *   backfill with `createdAt[id]`.
 * - id new to the ledger, no native timestamp → stamp with `today`.
 * - ids in `previous` but absent from `currentIds` this run are kept as-is
 *   (see module doc comment — the ledger is "first ever seen").
 */
export function computeAddedAtLedger(
  currentIds: readonly string[],
  previous: AddedAtLedger,
  createdAt: Readonly<Record<string, string>>,
  today: string
): AddedAtLedger {
  const next: AddedAtLedger = { ...previous }
  for (const id of currentIds) {
    if (next[id] !== undefined) continue
    next[id] = createdAt[id] ?? today
  }
  return next
}

/** Today's date as `YYYY-MM-DD`, in UTC. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Converts a provider's Unix-seconds creation timestamp to `YYYY-MM-DD`. */
export function isoDateFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}
