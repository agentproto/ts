/**
 * Convert — the inter-asset edge, and the no-arbitrage law.
 *
 * `convert` is the ONLY operation that crosses an asset boundary (and therefore
 * a peg). It is `burn(source) + mint(dest)` at the lattice MEET: the output
 * carries `meet(sourceRestriction, edge.addsRestriction)`, so restrictions only
 * accumulate (points→credit can't strip "non-withdrawable"). Coalescing, by
 * contrast, never crosses an asset and is value-preserving.
 *
 * `verifyNoArbitrage` guarantees no cycle of convert edges multiplies to a gain
 * (e.g. points→credit→points yielding more than you started) — detected as a
 * negative-weight cycle over `-log(rate)` (Bellman-Ford). Run in CI before P4.
 */

import type { AssetDeclaration, AssetRef, ConvertEdge } from "./asset.js"
import type { Restriction } from "./restriction-lattice.js"
import { meet, UNRESTRICTED } from "./restriction-lattice.js"

export interface ConvertDelta {
  /** Burned from the source asset (minor units of `fromAsset`). */
  outAmount: number
  /** Minted into the destination asset (minor units of `toAsset`). */
  inAmount: number
  /** Restriction carried by the minted output (accumulated at the meet). */
  inRestriction: Restriction
}

/**
 * Plan one convert. `majorRate` is destination-major per source-major units (the
 * decimals-independent rate the RatePort resolves). Pure: the caller emits the
 * correlated `convert_out` + `convert_in` events and commits atomically.
 */
export function planConvert(params: {
  fromAsset: AssetDeclaration
  toAsset: AssetDeclaration
  edge: ConvertEdge
  /** Amount to convert, in minor units of `fromAsset`. */
  amount: number
  sourceRestriction: Restriction
  /** Destination-major per source-major rate (resolved fixed or via RatePort). */
  majorRate: number
}): ConvertDelta {
  const { fromAsset, toAsset, edge, amount, sourceRestriction, majorRate } =
    params
  // minor→minor: scale by the decimals delta so units stay honest.
  const scale = 10 ** (toAsset.decimals - fromAsset.decimals)
  const inAmount = Math.floor(amount * majorRate * scale)
  return {
    outAmount: amount,
    inAmount,
    inRestriction: meet(sourceRestriction, edge.addsRestriction ?? UNRESTRICTED),
  }
}

/** Resolve an edge's rate to a concrete destination-major-per-source-major number. */
export type RateResolver = (edge: ConvertEdge, from: AssetRef) => number

export interface NoArbitrageResult {
  ok: boolean
  /** Asset refs forming an arbitrage cycle (product of rates > 1), if found. */
  cycle?: AssetRef[]
}

/**
 * No-arbitrage check over the convert graph. An arbitrage cycle is one whose
 * rate product exceeds 1 — equivalently a negative-weight cycle under
 * `weight = -log(rate)`. Bellman-Ford with a virtual source reaching every node.
 */
export function verifyNoArbitrage(
  assets: readonly AssetDeclaration[],
  resolveRate: RateResolver,
): NoArbitrageResult {
  interface Edge {
    from: AssetRef
    to: AssetRef
    weight: number
  }
  const nodes: AssetRef[] = assets.map(a => a.ref)
  const edges: Edge[] = []
  const EPS = 1e-9

  for (const asset of assets) {
    for (const e of asset.ruleSet.convertEdges) {
      const rate = resolveRate(e, asset.ref)
      if (!(rate > 0) || !Number.isFinite(rate)) continue
      edges.push({ from: asset.ref, to: e.to, weight: -Math.log(rate) })
    }
  }

  // Virtual source: distance 0 to every node so disconnected components run too.
  const dist = new Map<AssetRef, number>()
  const pred = new Map<AssetRef, AssetRef>()
  for (const n of nodes) dist.set(n, 0)

  let relaxedNode: AssetRef | undefined
  for (let i = 0; i < nodes.length; i++) {
    relaxedNode = undefined
    for (const e of edges) {
      const du = dist.get(e.from)
      const dv = dist.get(e.to)
      if (du === undefined || dv === undefined) continue
      if (du + e.weight < dv - EPS) {
        dist.set(e.to, du + e.weight)
        pred.set(e.to, e.from)
        relaxedNode = e.to
      }
    }
    if (relaxedNode === undefined) break
  }

  if (relaxedNode === undefined) return { ok: true }

  // A node still relaxing on iteration |V| sits on (or downstream of) a negative
  // cycle. Walk predecessors |V| times to land inside the cycle, then extract it.
  let cur: AssetRef = relaxedNode
  for (let i = 0; i < nodes.length; i++) {
    const p = pred.get(cur)
    if (p === undefined) break
    cur = p
  }
  const cycle: AssetRef[] = []
  let walk: AssetRef | undefined = cur
  while (walk !== undefined) {
    cycle.push(walk)
    const p = pred.get(walk)
    if (p === cur) {
      cycle.push(cur)
      break
    }
    walk = p
  }
  return { ok: false, cycle: cycle.reverse() }
}
