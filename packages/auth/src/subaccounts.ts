/**
 * Sub-accounts: an ACCOUNT (a login / billing identity) can have SUB-ACCOUNTS
 * (org, workspace, project, team) with their own quota and billing. A profile
 * can pin one ({@link AuthProfile.subaccount}); each pin is a distinct,
 * truthful wallet. HOW a pin is applied to a spawn — headers, an inline config
 * block, a scoped token, an isolated data home — is the provider's business.
 *
 * This module is the generic seam: the pin type, the {@link SubaccountProvider}
 * interface, and a process-wide registry. Nothing here (or in any core spawn
 * path) names a vendor; providers live with their adapter and are registered by
 * the host (the CLI registers the built-ins at start-up).
 */

import type { AuthProfile, SubaccountPin } from "./profile-types.js"

export type { SubaccountPin }

/** Conservative charset for a pin's `kind` — it ends up in CLI args and logs. */
export const SUBACCOUNT_KIND_RE = /^[a-z][a-z0-9-]*$/

/** `"org:org_01ABC"` → `{ kind: "org", id: "org_01ABC" }`; split on the FIRST
 *  colon so an id may itself contain colons. Returns undefined when malformed. */
export function parseSubaccountPin(spec: string): SubaccountPin | undefined {
  const at = spec.indexOf(":")
  if (at <= 0) return undefined
  const kind = spec.slice(0, at).trim()
  const id = spec.slice(at + 1).trim()
  if (!SUBACCOUNT_KIND_RE.test(kind) || id === "") return undefined
  return { kind, id }
}

/** The parent account a provider lists sub-accounts of. */
export interface SubaccountAccountRef {
  /** Billing endpoint the account authenticates against (`opencode-go`, …). */
  endpoint: string
  /** Source-backed account (the account name a provider owns), no stored secret. */
  source?: string
  /** Credential-backed account: the resolved secret. Never logged or returned. */
  credential?: string
}

export interface DiscoveredSubaccount {
  kind: string
  id: string
  name: string
}

export interface SubaccountListing {
  account: { id: string; label?: string }
  subaccounts: DiscoveredSubaccount[]
}

/** What a provider hands the spawn path for one pinned profile. */
export interface SubaccountResolution {
  /** Credential to inject, when the provider resolves its own (a source-backed
   *  account's scoped token). Omitted ⇒ the profile's stored credential stands. */
  credential?: string
  /** Env var the credential is set into INSTEAD of the endpoint's conventional
   *  key env (the conventional one is then scrubbed). */
  credentialEnvOverride?: string
  /** Extra env set verbatim beside the credential. A value that is a JSON
   *  object is deep-merged over a same-key value the spawn already carries
   *  (e.g. a mode's inline config), never clobbering it. */
  env?: Record<string, string>
  /** `false` opts out of the adapter's isolated, login-less data home for this
   *  spawn; omitted ⇒ whatever the adapter declares applies. */
  isolateDataHome?: boolean
}

/** Raised by a provider when a sub-account cannot be listed or resolved. The
 *  runtime maps it onto its own spawn-error codes; the message must never carry
 *  a secret. */
export class SubaccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SubaccountError"
  }
}

export interface SubaccountProvider {
  /** Registry key, unique per provider. */
  id: string
  /** The `source` name that identifies this provider's source-backed accounts
   *  (`AuthProfile.source`). */
  source?: string
  /** Endpoints whose credential-backed profiles this provider serves. */
  endpoints?: readonly string[]
  /** Sub-account kinds this provider understands. */
  kinds: readonly string[]
  /** Endpoint a profile created from a discovered sub-account lands on. */
  defaultEndpoint?: string
  /** Default id prefix for profiles created from a discovery (`<prefix>-<name>`). */
  profilePrefix?: string
  /** Discovery: the sub-accounts of `account`. */
  list(account: SubaccountAccountRef): Promise<SubaccountListing>
  /** Spawn-time: how the pinned `profile` is applied. `credential` is the
   *  profile's stored credential when it has one. */
  resolve(
    profile: AuthProfile & { subaccount: SubaccountPin },
    ctx: { credential?: string },
  ): Promise<SubaccountResolution>
  /** Migrate-on-read hook for a profile shape that predates generic pins: a
   *  legacy `source` string → the account `source` + the pin it encoded. */
  migrateLegacySource?(source: string): SubaccountPin | undefined
}

const providers = new Map<string, SubaccountProvider>()

/** Register (or replace, by `id`) a provider. Idempotent. */
export function registerSubaccountProvider(provider: SubaccountProvider): void {
  providers.set(provider.id, provider)
}

/** Remove a provider; returns whether it was registered. Mainly for tests. */
export function unregisterSubaccountProvider(id: string): boolean {
  return providers.delete(id)
}

export function listSubaccountProviders(): SubaccountProvider[] {
  return [...providers.values()]
}

export function getSubaccountProvider(id: string): SubaccountProvider | undefined {
  return providers.get(id)
}

/** The provider owning an account: by `source` name first, else by `endpoint`
 *  for a credential-backed account. */
export function findSubaccountProvider(account: {
  source?: string
  endpoint?: string
}): SubaccountProvider | undefined {
  const all = listSubaccountProviders()
  if (account.source !== undefined) {
    return (
      all.find(p => p.source === account.source) ??
      all.find(p => p.migrateLegacySource?.(account.source!) !== undefined)
    )
  }
  if (account.endpoint !== undefined) return all.find(p => p.endpoints?.includes(account.endpoint!))
  return undefined
}

/**
 * Migrate-on-read: a profile that carries a legacy provider-encoded `source`
 * (and no `subaccount`) is returned with the generic shape — `source` reduced
 * to the account name, the encoded pin lifted into `subaccount`. Any other
 * profile is returned as-is. Pure over the registry; never writes.
 */
export function migrateLegacySubaccountProfile(profile: AuthProfile): AuthProfile {
  if (profile.subaccount !== undefined || profile.source === undefined) return profile
  for (const provider of providers.values()) {
    const pin = provider.migrateLegacySource?.(profile.source)
    if (pin !== undefined && provider.source !== undefined) {
      return { ...profile, source: provider.source, subaccount: pin }
    }
  }
  return profile
}
