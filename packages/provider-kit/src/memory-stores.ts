/**
 * In-memory and environment-backed stores for hosts with no `~/.agentproto`
 * (a product on a cloud runtime, a test). They satisfy the same
 * `CredsStore` / `SetupLedger` interfaces as the file-backed defaults, so a
 * family built on `makeProviderFamily` can run with no daemon and no home
 * directory.
 *
 * None of these touches the filesystem, `HOME` or `AGENTPROTO_HOME`.
 */

import type { CredsStore } from "./creds-store.js"
import type { SetupLedger } from "./ledger.js"
import type { SetupLedgerRecord } from "./types.js"

/** Setup ledger held in a `Map`. Records are copied on the way in and out. */
export function makeMemorySetupLedger(
  seed: readonly SetupLedgerRecord[] = [],
): SetupLedger {
  const records = new Map<string, SetupLedgerRecord>()
  for (const r of seed) records.set(r.slug, structuredClone(r))
  return {
    async exists(slug) {
      return records.has(slug)
    },
    async write(slug, record) {
      records.set(slug, structuredClone(record))
    },
    async read(slug) {
      const r = records.get(slug)
      return r ? structuredClone(r) : null
    },
  }
}

/** Creds store held in a `Map` (tests, short-lived hosts). */
export function makeMemoryCredsStore<TCreds>(
  seed: Readonly<Record<string, TCreds>> = {},
): CredsStore<TCreds> {
  const rows = new Map<string, TCreds>(
    Object.entries(seed).map(([slug, creds]) => [slug, structuredClone(creds)]),
  )
  return {
    async read(slug) {
      const c = rows.get(slug)
      return c === undefined ? null : structuredClone(c)
    },
    async write(slug, creds) {
      rows.set(slug, structuredClone(creds))
    },
    async exists(slug) {
      return rows.has(slug)
    },
  }
}

export interface MakeEnvCredsStoreOpts {
  /**
   * Per provider slug, which environment variable carries which creds field:
   * `{ stripe: { apiKey: "STRIPE_API_KEY", webhookSecret: "STRIPE_WEBHOOK_SECRET" } }`.
   * A slug absent from the map has no creds (`read` returns null).
   */
  vars: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Environment to read. Defaults to `process.env`; inject one in tests. */
  env?: Readonly<Record<string, string | undefined>>
}

/**
 * Read-only creds store backed by environment variables.
 *
 * `read` returns only the fields whose variable is set and non-empty, or
 * null when none is; `exists` is true when at least one is. `write` always
 * throws: environment variables are configured by whoever runs the process,
 * so a family's setup tool reports "not configurable here" instead of
 * pretending to persist. The error text never carries a value.
 */
export function makeEnvCredsStore(
  opts: MakeEnvCredsStoreOpts,
): CredsStore<Record<string, string>> {
  const env = (): Readonly<Record<string, string | undefined>> =>
    opts.env ?? process.env
  const readRow = (slug: string): Record<string, string> | null => {
    const mapping = opts.vars[slug]
    if (!mapping) return null
    const out: Record<string, string> = {}
    for (const [field, envVar] of Object.entries(mapping)) {
      const v = env()[envVar]
      if (v !== undefined && v.length > 0) out[field] = v
    }
    return Object.keys(out).length > 0 ? out : null
  }
  return {
    async read(slug) {
      return readRow(slug)
    },
    async write() {
      throw new Error(
        "environment creds store is read-only: set the variables on the host instead",
      )
    },
    async exists(slug) {
      return readRow(slug) !== null
    },
  }
}
