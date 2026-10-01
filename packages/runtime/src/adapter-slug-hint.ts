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

/**
 * The route/gateway ids the Anthropic-gateway presets (`~agentproto/provider-presets`)
 * know — the same set `agent_start.route.gateway` and a model ref's leading
 * segment (`opencode-go/glm-5.3`, `openai/gpt-4o@openrouter`) address. A cheap
 * STATIC list on purpose (issue #1647's `adapter_not_found` report): no catalog
 * lookup on the error path — every id here is compile-time constant in
 * `ANTHROPIC_GATEWAY_PRESETS`, so the array just has to name them.
 */
const KNOWN_GATEWAY_IDS: ReadonlySet<string> = new Set([
  "moonshot",
  "openrouter",
  "requesty",
  "opencode-go",
  "opencode",
  "deepseek",
  "xai-anthropic",
  "llm-endpoint",
  "xai",
  "openai",
  "openai-direct",
  "mistral",
  "groq",
  "nebius",
  "huggingface",
  "deepinfra",
])

/**
 * The corrective hint when `slug` names a route/gateway id rather than an
 * installed adapter — e.g. `adapter: "opencode-go"` when `opencode-go` is a
 * MODEL/route (`opencode-go/glm-5.3`) billed through the `opencode` adapter.
 * Undefined for a genuinely-unknown slug (the generic "install it" wording
 * stands). Mirrors {@link authProfileAsAdapterHint}'s shape (issue #1647).
 */
export function gatewayAsAdapterHint(slug: string): string | undefined {
  if (!KNOWN_GATEWAY_IDS.has(slug)) return undefined
  return (
    `'${slug}' is a model/route (gateway), not an adapter; ` +
    `use agent: '<installed-adapter>' with model: '${slug}/<id>' and ` +
    `route: {gateway: '${slug}'}.`
  )
}
