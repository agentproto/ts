/**
 * Who pays (AIP-74 rules 19 and 20).
 *
 * `self`: the account that acts pays. `hierarchy/v1`: walk up while the parent
 * is funded `pool`; a parent funded `allocated_budget` stops the walk and its
 * direct child pays; a chain longer than `maxDepth`, a cycle or a missing
 * parent is an error. There is no cascade: when the payer cannot pay, nobody
 * else does.
 */
import { fold, floorOf } from "@agentproto/wallet"
import type { StoragePort } from "@agentproto/wallet/ports"
import type { BillingHandle } from "./define-billing-manifest.js"

export interface AccountNode {
  id: string
  parentId: string | null
  /** How THIS account funds its children. */
  funding?: "pool" | "allocated_budget"
}

export interface AccountDirectory {
  get(id: string): Promise<AccountNode | null>
}

export type PayerResolution = { ok: true; payerId: string; path: string[] } | { ok: false; error: string }

/** Strategies a host registers for `x-<vendor>:<name>`. */
export type PayerStrategy = (accountId: string, directory: AccountDirectory) => Promise<PayerResolution>

export async function resolvePayer(
  manifest: BillingHandle,
  directory: AccountDirectory,
  accountId: string,
  strategies: Readonly<Record<string, PayerStrategy>> = {},
): Promise<PayerResolution> {
  const s = manifest.payer.strategy
  if (s === "self") return { ok: true, payerId: accountId, path: [accountId] }
  if (s !== "hierarchy/v1") {
    const impl = strategies[s]
    if (!impl) return { ok: false, error: `payer strategy '${s}' is not registered` }
    return impl(accountId, directory)
  }
  const maxDepth = manifest.accounts.hierarchy.maxDepth
  const start = await directory.get(accountId)
  if (!start) return { ok: false, error: `unknown account '${accountId}'` }
  const path = [start.id]
  const seen = new Set(path)
  let node = start
  for (;;) {
    if (node.parentId === null) return { ok: true, payerId: node.id, path }
    const parent = await directory.get(node.parentId)
    if (!parent) return { ok: false, error: `corrupted chain: parent '${node.parentId}' of '${node.id}' does not exist` }
    if (seen.has(parent.id)) return { ok: false, error: `cycle at '${parent.id}'` }
    if (parent.funding === "allocated_budget") return { ok: true, payerId: node.id, path }
    node = parent
    seen.add(node.id)
    path.push(node.id)
    if (path.length - 1 > maxDepth) return { ok: false, error: `chain longer than maxDepth ${maxDepth}` }
  }
}

/**
 * Can `payerId` pay `amount` of the primary asset? `balance` counts what the
 * account owns, holds included; `spendable` removes what is reserved (a dispute
 * freeze, an open hold). A lot minted with a `floor` (a bounded short position,
 * `null` for an unbounded one) can be spent below zero down to that floor, the
 * same bound the journal enforces on commit, so its headroom counts too.
 */
export async function canPay(
  manifest: BillingHandle,
  storage: StoragePort,
  payerId: string,
  amount: number,
  now: number,
): Promise<boolean> {
  const lots = fold(await storage.loadEvents(payerId), now).filter(
    l => l.asset === manifest.primaryAsset && !(l.expiresAt !== undefined && l.expiresAt <= now),
  )
  const mode = manifest.payer.affordability ?? "balance"
  const held = lots.reduce((s, l) => s + l.remaining - (mode === "spendable" ? l.reserved : 0) - floorOf(l.floor), 0)
  return held >= amount
}
