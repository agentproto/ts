/**
 * `fetchedAt` ledger - remembers the ISO date a SOURCE's price payload was
 * last observed to change.
 *
 * Unlike `addedAt` (first ever seen), a price's `fetchedAt` should advance
 * when the price actually moves, not on every weekly sync. Hashing the source
 * payload (or the selected price for one model) makes the generated
 * `*.generated.ts` deterministic: an unchanged source keeps its committed
 * date, so `catalog-sync generate --check` stays green between real changes.
 *
 * Ledgers are committed at `packages/catalog-sync/ledger/<id>.json` and
 * included in the generator's `GeneratedFiles`, so the runner's existing
 * diff/write logic covers them.
 *
 * Plain JS (types in `fetched-at.d.mts`) so the bare-`node` sync scripts and
 * the TypeScript generators share one implementation.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function catalogSyncDir() {
  return resolve(__dirname, "..")
}

export function fetchedAtLedgerAbsPath(ledgerId) {
  return join(catalogSyncDir(), "ledger", `${ledgerId}.json`)
}

export function fetchedAtLedgerRelPath(ledgerId) {
  return `packages/catalog-sync/ledger/${ledgerId}.json`
}

/** Reads a committed ledger from disk. Missing/unparseable → empty ledger. */
export function readFetchedAtLedger(ledgerId) {
  const path = fetchedAtLedgerAbsPath(ledgerId)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const ledger = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value === "object" &&
        typeof value.hash === "string" &&
        typeof value.fetchedAt === "string"
      ) {
        ledger[key] = value
      }
    }
    return ledger
  } catch {
    return {}
  }
}

/** Deterministic (sorted-key) JSON serialization. */
export function serializeFetchedAtLedger(ledger) {
  const sorted = {}
  for (const key of Object.keys(ledger).sort()) sorted[key] = ledger[key]
  return `${JSON.stringify(sorted, null, 2)}\n`
}

/** sha256 of an arbitrary JSON-serializable value. */
export function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/**
 * Merge one key into a ledger: reuse the committed date when the hash is
 * unchanged, otherwise stamp today.
 */
export function resolveFetchedAt(previous, key, hash, today) {
  const prior = previous[key]
  const entry = prior && prior.hash === hash ? prior : { hash, fetchedAt: today }
  return { ledger: { ...previous, [key]: entry }, entry }
}
