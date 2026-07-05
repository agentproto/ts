/**
 * Map a provider's `TokenStoreSpec` to a backend-agnostic `StoreRef`.
 *
 * Shared by every flow engine so the `path`/`keychain` back-compat alias and
 * the `{server}` account template are resolved identically everywhere.
 */

import { resolveAccount } from "../token-store.js"
import type { TokenStoreSpec } from "../types.js"
import type { CredentialStore, StoreRef, StoredCredential } from "./types.js"

/** When `audience` is declared, it's folded into the physical store key —
 *  `${audience}:${path}` — so credentials scoped to different audiences
 *  (e.g. "tunnel" vs "api") never collide under the same slot. Absent
 *  `audience` = today's unprefixed path, unchanged. */
export function resolveStoreRef(
  spec: TokenStoreSpec,
  server: string,
  audience?: string,
): StoreRef {
  const path = spec.path ?? spec.keychain
  return {
    path: audience ? `${audience}:${path}` : path,
    account: resolveAccount(spec.account, server),
  }
}

/** Derive both the audience-prefixed `ref` and the unprefixed `legacyRef` in
 *  one call — the pair every flow engine and the broker need for the
 *  audience back-compat read (`readStoreRefWithFallback`). When no audience
 *  is declared, `legacyRef === ref` (same object), matching `resolveStoreRef`
 *  called with `audience` undefined. */
export function resolveStoreRefs(
  spec: TokenStoreSpec,
  server: string,
  audience?: string,
): { ref: StoreRef; legacyRef: StoreRef } {
  const ref = resolveStoreRef(spec, server, audience)
  const legacyRef = audience ? resolveStoreRef(spec, server) : ref
  return { ref, legacyRef }
}

/**
 * Read through `ref`, falling back once to `legacyRef` on a miss.
 *
 * This is the read half of the audience back-compat rule: a write always
 * targets the audience-prefixed ref, but a credential written before the
 * provider adopted an audience still lives at the unprefixed (legacy) path.
 * Rather than duplicate that fallback at every flow-engine/broker read site,
 * it lives here, next to `resolveStoreRef` — the one place that already
 * knows how prefixed vs. legacy refs are derived. Callers that don't declare
 * an audience pass `ref === legacyRef` (or just call `store.read` directly);
 * this only does extra work when the two refs actually differ.
 */
export async function readStoreRefWithFallback(
  store: CredentialStore,
  ref: StoreRef,
  legacyRef: StoreRef,
): Promise<StoredCredential | undefined> {
  const stored = await store.read(ref)
  if (stored) return stored
  if (ref.path === legacyRef.path && ref.account === legacyRef.account) {
    return undefined
  }
  return store.read(legacyRef)
}
