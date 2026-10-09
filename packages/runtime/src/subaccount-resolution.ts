/**
 * Spawn-time application of a profile's pinned sub-account (org / workspace /
 * project). The runtime never imports a provider: it asks the registry in
 * `@agentproto/auth` for the one that owns the profile's account and maps the
 * provider's {@link SubaccountResolution} onto `resolveAuthSpec` inputs.
 */

import {
  findSubaccountProvider,
  type AuthProfile,
  type SubaccountPin,
  type SubaccountResolution,
} from "@agentproto/auth"
import { SubscriptionSourceError, type CredentialSource } from "./spawn-defaults.js"

export interface ResolvedProfileSubaccount {
  pin: SubaccountPin
  /** The credential to inject: the provider's own, else the profile's stored one. */
  credential?: string
  /** Spread straight into `resolveAuthSpec`'s input. */
  authInputs: {
    credentialEnvOverride?: string
    apiKeyCredentialSource?: CredentialSource
    extraEnv?: Record<string, string>
    isolateDataHome?: boolean
  }
}

/** Duck-typed: the error may come from a different copy of `@agentproto/auth`
 *  (an adapter installed on its own), where `instanceof` would not hold. */
function isSubaccountError(err: unknown): err is Error {
  return err instanceof Error && err.name === "SubaccountError"
}

export function mapSubaccountResolution(
  pin: SubaccountPin,
  res: SubaccountResolution,
  storedCredential: string | undefined,
): ResolvedProfileSubaccount {
  return {
    pin,
    ...(res.credential !== undefined || storedCredential !== undefined
      ? { credential: res.credential ?? storedCredential }
      : {}),
    authInputs: {
      ...(res.credentialEnvOverride ? { credentialEnvOverride: res.credentialEnvOverride } : {}),
      ...(res.credential !== undefined ? { apiKeyCredentialSource: "subaccount" as const } : {}),
      ...(res.env && Object.keys(res.env).length > 0 ? { extraEnv: res.env } : {}),
      ...(res.isolateDataHome !== undefined ? { isolateDataHome: res.isolateDataHome } : {}),
    },
  }
}

/**
 * Resolve `profile`'s sub-account pin for a spawn. Returns undefined when the
 * profile pins none. Fails loud ({@link SubscriptionSourceError}) when the pin
 * has no registered provider or the provider cannot resolve it — never falls
 * back to the account's default scope, which would bill the wrong wallet.
 */
export async function resolveProfileSubaccount(
  profile: AuthProfile,
  ctx: { credential?: string } = {},
): Promise<ResolvedProfileSubaccount | undefined> {
  const pin = profile.subaccount
  if (!pin) return undefined
  const provider = findSubaccountProvider({
    ...(profile.source !== undefined ? { source: profile.source } : { endpoint: profile.endpoint }),
  })
  if (!provider) {
    throw new SubscriptionSourceError(
      "auth_source_unresolved",
      `profile "${profile.id}" pins ${pin.kind} "${pin.id}" but no sub-account provider is registered for ` +
        `${profile.source !== undefined ? `source "${profile.source}"` : `endpoint "${profile.endpoint}"`}.`,
    )
  }
  try {
    const res = await provider.resolve(profile as AuthProfile & { subaccount: SubaccountPin }, ctx)
    return mapSubaccountResolution(pin, res, ctx.credential)
  } catch (err) {
    if (isSubaccountError(err)) throw new SubscriptionSourceError("auth_source_unresolved", err.message)
    throw err
  }
}
