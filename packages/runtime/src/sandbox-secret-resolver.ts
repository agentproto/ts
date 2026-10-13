/**
 * Keychain-backed fallback for sandbox env-slug resolution.
 *
 * `agent_start.sandbox.env.passthrough` slugs are resolved by the host's
 * secrets broker, which in the daemon is a plain read of the DAEMON
 * process's own env (`serve.ts`). A credential that lives ONLY in the OS
 * keychain — an auth profile's `credentialRef`, a workspace's git PAT — never
 * reaches the box that way. This module layers a keychain read behind the
 * broker, scoped to an explicit `name → credentialRef` map:
 *
 *   1. the broker (daemon env) wins when it has a value, so existing
 *      deployments resolve exactly as before;
 *   2. otherwise, a name that has a `credentialRef` is read from the keychain.
 *
 * Values are returned to the caller and nowhere else — never logged, never
 * cached. Failures degrade to `null` (the sandbox package turns a null for a
 * declared slug into the loud "missing secret" boot failure).
 */

import { KeychainStore, type AuthProfile, type CredentialStore } from "@agentproto/auth"

/** An explicit `{ name, credentialRef }` entry on `agent_start.sandbox.credentialRefs`. */
export interface SandboxCredentialRefEntry {
  /** The env-var name the box sees (and the passthrough slug it is resolved as). */
  name: string
  /** Keychain slot (`StoreRef.path`) holding the value. */
  credentialRef: string
}

export type SandboxSecretResolver = (slug: string) => Promise<string | null>

export interface BuildSandboxSecretResolverOptions {
  /** First-choice resolver — the daemon's secrets broker. */
  base: SandboxSecretResolver
  /** `name → credentialRef`, consulted only when `base` returned null. A live
   *  Map: entries added after construction (the auto-passthrough ref) are seen. */
  refs: ReadonlyMap<string, string>
  /** Keychain backend; defaults to the OS keychain. Injectable for tests. */
  store?: Pick<CredentialStore, "read">
}

/** Layer a keychain read (by explicit `credentialRef`) behind the broker. */
export function buildSandboxSecretResolver(
  opts: BuildSandboxSecretResolverOptions,
): SandboxSecretResolver {
  return async slug => {
    const fromBroker = await opts.base(slug)
    if (fromBroker !== null) return fromBroker
    const ref = opts.refs.get(slug)
    if (ref === undefined) return null
    try {
      const stored = await (opts.store ?? new KeychainStore()).read({ path: ref })
      return stored?.value ?? null
    } catch (err) {
      console.warn(
        `[agent_start] sandbox secret "${slug}": keychain read for credentialRef "${ref}" failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }
}

/** Collapse explicit entries into the resolver's `name → credentialRef` map.
 *  A later duplicate name overrides an earlier one. */
export function credentialRefMap(
  entries: readonly SandboxCredentialRefEntry[] | undefined,
): Map<string, string> {
  const refs = new Map<string, string>()
  for (const entry of entries ?? []) refs.set(entry.name, entry.credentialRef)
  return refs
}

/**
 * The keychain slot behind an auth profile's billing credential, when the box
 * can safely be handed the stored value verbatim. `undefined` for a sub-account
 * pin: the driver injects a derived scoped token there, not the parent key
 * stored at the ref. (Source-backed profiles carry no `credentialRef` at all.)
 */
export function autoCredentialRefOf(
  profile: Pick<AuthProfile, "credentialRef" | "subaccount"> | undefined,
): string | undefined {
  if (profile === undefined || profile.subaccount !== undefined) return undefined
  return profile.credentialRef
}
