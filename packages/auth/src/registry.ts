/**
 * Auth-provider registry — id → handle lookup, pre-seeded with builtins.
 *
 * Mirrors the provision-recipe registry shape (AIP-19). Re-registering an id
 * overrides it (last write wins), so a host can shadow a builtin.
 */

import { BUILTIN_AUTH_PROVIDERS } from "./builtins.js"
import type { AuthProviderHandle } from "./types.js"

const _registry = new Map<string, AuthProviderHandle>()
for (const p of BUILTIN_AUTH_PROVIDERS) _registry.set(p.id, p)

export function registerAuthProvider(provider: AuthProviderHandle): void {
  _registry.set(provider.id, provider)
}

export function getAuthProvider(id: string): AuthProviderHandle | undefined {
  return _registry.get(id)
}

export function listAuthProviders(): AuthProviderHandle[] {
  return [..._registry.values()]
}

export function listAuthProviderIds(): string[] {
  return [..._registry.keys()]
}
