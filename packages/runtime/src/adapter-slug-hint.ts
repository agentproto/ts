/**
 * Shared wording for an adapter slug that didn't resolve because it's
 * actually an auth-profile id (`~/.agentproto/auth-profiles.json`), e.g.
 * `adapter: "claude-subs-agentik"` where `access.profileRef` was meant.
 * Used by both the cron create-time check (`cron-scheduler.ts`) and
 * `agent_start`'s fire-time error (`session-spawn.ts`) so the two messages
 * can't drift — and so neither tells the user to `agentproto install` a
 * profile id.
 */

export type AuthProfileLookup = (id: string) => Promise<{ endpoint?: string } | undefined>

/**
 * The corrective hint when `slug` names an existing auth profile, else
 * undefined. A lookup failure counts as "not a profile" — this only words
 * an error, it must never replace one.
 */
export async function authProfileAsAdapterHint(
  slug: string,
  getAuthProfile: AuthProfileLookup | undefined,
): Promise<string | undefined> {
  const profile = await getAuthProfile?.(slug).catch(() => undefined)
  if (!profile) return undefined
  return (
    `'${slug}' is an auth profile${profile.endpoint ? ` (endpoint '${profile.endpoint}')` : ""}, ` +
    `not an adapter; use adapter: 'claude-code' (or the adapter that bills that endpoint) ` +
    `with access.profileRef: '${slug}' (or presetId).`
  )
}
