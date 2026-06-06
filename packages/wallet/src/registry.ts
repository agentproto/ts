/**
 * AssetRegistry — the config-first asset catalog.
 *
 * Mirrors the catalog shape used elsewhere (GrantCatalog, plan catalogs): a base
 * class hosts populate, an immutable `extend` layers app assets onto a shared
 * common set, and `verify` runs the no-arbitrage check across the union. The
 * registry is brand-neutral — concrete assets (USD/EUR, GUILDE_CREDITS, …) live
 * in the host, declared via `defineAsset`.
 *
 * Config-first today; a host MAY seed additional entries from a DB loader for
 * runtime assets (guild-minted tokens, deposited on-chain assets) keyed by the
 * same `ref`, so lookups stay uniform.
 */

import type { AssetDeclaration, AssetRef } from "./asset.js"
import {
  verifyNoArbitrage,
  type NoArbitrageResult,
  type RateResolver,
} from "./convert.js"

export class AssetRegistry {
  private readonly assets = new Map<AssetRef, AssetDeclaration>()

  register(asset: AssetDeclaration): this {
    if (this.assets.has(asset.ref)) {
      throw new Error(`AssetRegistry: asset "${asset.ref}" already registered`)
    }
    this.assets.set(asset.ref, asset)
    return this
  }

  get(ref: AssetRef): AssetDeclaration | undefined {
    return this.assets.get(ref)
  }

  has(ref: AssetRef): boolean {
    return this.assets.has(ref)
  }

  /** Like `get`, but throws — for call sites where the asset MUST exist. */
  require(ref: AssetRef): AssetDeclaration {
    const a = this.assets.get(ref)
    if (!a) throw new Error(`AssetRegistry: unknown asset "${ref}"`)
    return a
  }

  getAll(): AssetDeclaration[] {
    return [...this.assets.values()]
  }

  static from(assets: readonly AssetDeclaration[]): AssetRegistry {
    const r = new AssetRegistry()
    for (const a of assets) r.register(a)
    return r
  }

  /** Immutable extend: a new registry = this ∪ assets (mirrors GrantCatalog.extend). */
  extend(assets: readonly AssetDeclaration[]): AssetRegistry {
    return AssetRegistry.from([...this.getAll(), ...assets])
  }

  /**
   * No-arbitrage gate across every registered convert edge. Run per app in CI:
   * the union (common + app) must admit no profitable cycle.
   */
  verify(resolveRate: RateResolver): NoArbitrageResult {
    return verifyNoArbitrage(this.getAll(), resolveRate)
  }
}
