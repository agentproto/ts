/**
 * StoragePort — the journal substrate, injected by the host.
 *
 * The kit is pure: it computes events + lot deltas but never persists them. The
 * host (Postgres adapter for agstudio, in-memory for tests) implements append +
 * projection. `commit` MUST be atomic AND serialized per account — the lattice
 * spend is lot-precise (multi-row), so a lock-free single-column guard is not
 * enough; lock the account row while picking lots + applying deltas.
 */

import type { AssetRef } from "../asset.js"
import type { Lot, WalletEvent } from "../fold.js"

export interface StoragePort {
  /** Full journal for an account, in occurrence order. */
  loadEvents(accountId: string): Promise<WalletEvent[]>

  /** Current lot projection for an account (maintained-in-tx by the adapter). */
  loadLots(accountId: string): Promise<Lot[]>

  /**
   * Append events and apply their lot deltas for one account, atomically and
   * serialized against concurrent commits on the SAME account. Throws if the
   * resulting projection would drive any lot's `remaining − reserved` below 0.
   */
  commit(accountId: string, events: readonly WalletEvent[]): Promise<void>

  /**
   * Spendable balance for an asset on an account (Σ remaining − reserved over
   * live lots). The single accessor all readers route through (P6).
   */
  spendableBalance(accountId: string, asset: AssetRef): Promise<number>
}
