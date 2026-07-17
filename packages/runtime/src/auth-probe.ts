/**
 * Read-only probe: does a credential actually RESOLVE for an adapter slug's
 * billing auth? Used by `adapter_list` to report an HONEST status instead of
 * claiming "ready" on a host with zero credentials for an adapter that hard-
 * fails every spawn (claude-code, `authEnforce: "always"`).
 *
 * THE TRAP (see the money regression test in `__tests__/auth-probe.test.ts`):
 * a probe that answers "is auth configured?" by checking `providers.json`
 * alone would report `true` for a spawn that still throws
 * `missing_auth_credential` — the store lookup at `session-spawn.ts:612-617`
 * is gated on `explicit` (PR #321: an unconfigured `always`-enforcing adapter
 * must never pick up a leftover store key and bill org credits instead of the
 * Max subscription). So this mirrors `session-spawn.ts`'s resolution exactly
 * — same `resolveSpawnDefaults` + `resolveAuthSpec`, same explicit gate on
 * the store lookup — rather than reimplementing the precedence: a second
 * copy of this logic WILL drift, and the drift is denominated in money.
 */

import { getModelProvider } from "@agentproto/model-catalog/llm"
import { loadConfig } from "./config.js"
import { getProviderKey } from "./providers-store.js"
import {
  resolveSpawnDefaults,
  resolveAuthSpec,
  AuthResolutionError,
  type AdapterAuthDescriptor,
} from "./spawn-defaults.js"

export async function isAgentCliAuthConfigured(
  slug: string,
  descriptor: AdapterAuthDescriptor,
  model?: string,
): Promise<boolean> {
  const config = await loadConfig()
  const spawnDefaults = resolveSpawnDefaults(config.defaults, slug, {})
  const pinnedProvider = spawnDefaults.auth.provider
  const resolvedProvider =
    pinnedProvider ?? descriptor.provider ?? (model ? getModelProvider(model) : undefined)
  // Same money-safety gate as session-spawn.ts: the providers.json store is
  // only consulted when auth is EXPLICITLY configured (defaults.adapters.
  // <slug>.auth in config.json) — never for an unconfigured spawn.
  const apiKeyStoreCredential =
    resolvedProvider &&
    spawnDefaults.auth.explicit &&
    spawnDefaults.auth.apiKeyCredential === undefined
      ? await getProviderKey(resolvedProvider)
      : undefined
  try {
    const result = resolveAuthSpec({
      descriptor,
      ...(model ? { model } : {}),
      ...(pinnedProvider ? { requestedProvider: pinnedProvider } : {}),
      ...(spawnDefaults.auth.requestedMode
        ? { requestedMode: spawnDefaults.auth.requestedMode }
        : {}),
      explicit: spawnDefaults.auth.explicit,
      ...(spawnDefaults.auth.subscriptionCredential !== undefined
        ? { subscriptionCredential: spawnDefaults.auth.subscriptionCredential }
        : {}),
      ...(spawnDefaults.auth.apiKeyCredential !== undefined
        ? { apiKeyConfigCredential: spawnDefaults.auth.apiKeyCredential }
        : {}),
      ...(apiKeyStoreCredential !== undefined ? { apiKeyStoreCredential } : {}),
    })
    return result?.spec.credential !== undefined
  } catch (err) {
    if (err instanceof AuthResolutionError) return false
    throw err
  }
}
