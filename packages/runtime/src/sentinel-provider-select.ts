/**
 * Provider auto-selection when `spec.provider` is undefined (AIP-60 §5):
 * `agentpush` if it is set up, else `webhook` if a STABLE public URL exists
 * and the provider reports itself ready, else `local-gh`. Shared by
 * `sentinel_watch` / `POST /sentinels` and the PR auto-linker so both pick the
 * same backend.
 *
 * An explicit `provider` is never routed through here (never second-guessed,
 * never silently downgraded). A probe that throws counts as "not ready".
 */

import { LOCAL_GH_SLUG } from "./sentinel-providers/local-gh.js"
import { AGENTPUSH_SLUG } from "./sentinel-providers/agentpush.js"
import { WEBHOOK_SLUG } from "./sentinel-providers/webhook.js"
import { resolveSentinelPublicUrl, type SentinelPublicUrl } from "./sentinel-public-url.js"
import type { SentinelProviderHandle } from "./sentinel-providers/types.js"

export interface AutoSelectDeps {
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
  /** Public-URL source. Defaults to the daemon-wired resolver. */
  publicUrl?: () => SentinelPublicUrl | undefined
}

async function isReady(provider: SentinelProviderHandle | null): Promise<boolean> {
  if (!provider) return false
  if (!provider.readiness) return true
  try {
    return (await provider.readiness()).ready
  } catch {
    return false
  }
}

export async function autoSelectProviderSlug(deps: AutoSelectDeps): Promise<string> {
  if (await isReady(await deps.resolveProvider(AGENTPUSH_SLUG))) return AGENTPUSH_SLUG
  const pub = (deps.publicUrl ?? resolveSentinelPublicUrl)()
  if (pub?.stable && (await isReady(await deps.resolveProvider(WEBHOOK_SLUG)))) return WEBHOOK_SLUG
  return LOCAL_GH_SLUG
}
