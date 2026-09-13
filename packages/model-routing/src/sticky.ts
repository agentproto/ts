/**
 * AIP-57 §5 — chains and deterministic sticky selection.
 *
 * Pure per §7: no clock, no randomness, no request-ordering state. Only the
 * hash of `stablePrefix` may influence the outcome — the prefix content
 * itself MUST NOT be retained (§5 Security Considerations).
 */

import type { Chain, ChainResolution, Layer, Pack, ResolvedRoute, Route, RoutableRequest } from "./types.js"
import { resolve } from "./resolve.js"

/**
 * FNV-1a, 32-bit. Stable, non-cryptographic, deterministic across processes
 * and restarts — exactly what §5's `H` requires and nothing more.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Every system message plus the FIRST user message, and nothing else (§5).
 * Appending later turns MUST NOT change this — that is what makes one
 * conversation stick to one served model across turns and across hosts.
 */
export function stablePrefix(req: RoutableRequest): unknown {
  const systemMessages = req.messages.filter((m) => m.role === "system")
  const firstUser = req.messages.find((m) => m.role === "user")
  return [systemMessages, firstUser ?? null]
}

/** `H(stablePrefix(request))` — the only thing sticky selection may consult. */
export function stablePrefixHash(req: RoutableRequest): number {
  return fnv1a32(JSON.stringify(stablePrefix(req)))
}

/**
 * Declare a chain, validated at CONFIGURATION LOAD (§5 Security
 * Considerations: "a chain referencing an unknown or virtual entry MUST
 * fail configuration loading; deferring it makes a typo a production
 * routing failure under load").
 *
 * `chainIds` is every other chain id known at load time — `chain.chain`
 * MUST NOT contain any of them (no chain-to-chain, including self-reference).
 * Throws synchronously; call this where packs/chains are declared, not on
 * the request path.
 */
export function defineChain(chain: Chain, chainIds: ReadonlySet<string> | readonly string[]): Chain {
  const ids = chainIds instanceof Set ? chainIds : new Set(chainIds)
  for (const ref of chain.chain) {
    if (ref === chain.id || ids.has(ref)) {
      throw new Error(
        `chain "${chain.id}": entry "${ref}" resolves to another chain — chain-to-chain routing is forbidden (AIP-57 §5)`
      )
    }
  }
  return chain
}

/**
 * Resolve the sticky candidate for a chain: `chain.chain` filtered to refs
 * `isResolvable` accepts (§5: "`chain'` is `chain` filtered to refs that
 * resolve to a real Route"), then
 * `chain'[H(stablePrefix(request)) mod |chain'|]`.
 *
 * An empty filtered chain resolves to no candidate rather than an arbitrary
 * one (§5) — returns `null`, never throws; an empty chain is a runtime
 * condition (every candidate currently gated off), not a config error.
 *
 * Kept independent of {@link Pack} / {@link resolve} so a host can bind
 * `isResolvable` to whatever "is this ref a real, currently-enabled route"
 * means for it. {@link resolveThroughChain} is the `Pack`-bound convenience
 * built on top.
 */
export function resolveChain(
  chain: Chain,
  req: RoutableRequest,
  isResolvable: (ref: string) => boolean
): ChainResolution | null {
  const candidates = chain.chain.filter(isResolvable)
  if (candidates.length === 0) return null
  const hash = stablePrefixHash(req)
  const servedKey = candidates[hash % candidates.length]
  if (servedKey === undefined) return null
  return { id: chain.id, servedKey }
}

/**
 * Resolve a chain through a {@link Pack}: a ref is resolvable when it is a
 * key of `pack` and {@link resolve} against it (through `layers`) is not
 * gated to `null`. Reattaches the served identity onto the returned
 * {@link ResolvedRoute} exactly once (§5): `key` is the real served key
 * `virtualKey` is the chain id the client addressed — a host observing
 * `virtualKey` alongside `key` can e.g. surface both `x-served-model` (from
 * `key`) and echo the addressed virtual id, while metrics/pricing key off
 * `key` only.
 */
export function resolveThroughChain<Key extends string, R extends Route = Route>(
  chain: Chain,
  pack: Pack<Key, R>,
  req: RoutableRequest,
  layers: readonly Layer<Key, R>[] = []
): ResolvedRoute<R> | null {
  const isResolvable = (ref: string): ref is Key =>
    Object.prototype.hasOwnProperty.call(pack.routes, ref) && resolve(pack, ref as Key, layers) !== null

  const picked = resolveChain(chain, req, isResolvable)
  if (!picked) return null
  const served = resolve(pack, picked.servedKey as Key, layers)
  if (!served) return null
  return { ...served, virtualKey: chain.id }
}
