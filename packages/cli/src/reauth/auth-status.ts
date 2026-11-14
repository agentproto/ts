import { profileAuthStatus, type AuthProfile, type ProfileAuthStatus } from "@agentproto/auth"
import { registerBuiltinReauthAdapters } from "./register.js"

/** Expiry, derived state and parent account of each profile. Never a token. */
export async function profileStatuses(
  profiles: readonly AuthProfile[],
): Promise<Map<string, ProfileAuthStatus>> {
  await registerBuiltinReauthAdapters()
  const out = new Map<string, ProfileAuthStatus>()
  // Sequential: sub-account owners of one parent share a cached org lookup.
  for (const p of profiles) out.set(p.id, await profileAuthStatus(p))
  return out
}

/** `expires in 3h`, `expired 2d ago`, `no expiry known`. */
export function describeExpiry(status: ProfileAuthStatus, now: number = Date.now()): string {
  if (status.expiresAt === null) return status.parent?.loggedIn === false ? "no login stored" : "no expiry known"
  const ms = Date.parse(status.expiresAt) - now
  const abs = Math.abs(ms)
  const span =
    abs < 3_600_000
      ? `${Math.max(1, Math.round(abs / 60_000))}m`
      : abs < 86_400_000
        ? `${Math.round(abs / 3_600_000)}h`
        : `${Math.round(abs / 86_400_000)}d`
  return ms < 0 ? `expired ${span} ago` : `expires in ${span}`
}
