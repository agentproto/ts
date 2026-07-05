/**
 * Map a provider's `TokenStoreSpec` to a backend-agnostic `StoreRef`.
 *
 * Shared by every flow engine so the `path`/`keychain` back-compat alias and
 * the `{server}` account template are resolved identically everywhere.
 */

import { resolveAccount } from "../token-store.js"
import type { TokenStoreSpec } from "../types.js"
import type { StoreRef } from "./types.js"

export function resolveStoreRef(spec: TokenStoreSpec, server: string): StoreRef {
  return {
    path: spec.path ?? spec.keychain,
    account: resolveAccount(spec.account, server),
  }
}
