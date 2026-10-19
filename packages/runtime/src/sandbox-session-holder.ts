/**
 * The stable session holder the runtime forwards to a sandbox provider.
 *
 * `computer` maps an attach onto a controller-side session slot keyed by a
 * holder id, and makes a re-attach by the SAME holder idempotent. The runtime
 * used to rely on `AGENTPROTO_SESSION_ID` reaching the provider process, but
 * that variable only exists in the spawned agent's child process, never in the
 * daemon process that drives the provider. The runtime therefore names the
 * holder explicitly in the sandbox spec's `config.sessionHolder`, and persists
 * the non-secret part of that config on the descriptor so both re-attach paths
 * (session_restart and the boot-time reattach pass) replay the same value
 * instead of rebuilding an empty `config: {}`.
 *
 * Secrets never reach the descriptor: only an allowlist of provider config
 * fields known to be non-secret is persisted (plus the holder). Everything
 * else — tokens, headers, connection strings, env maps, arbitrary caller keys —
 * is dropped, so an unknown key cannot smuggle a credential onto disk.
 * Providers that do not know `sessionHolder` simply ignore the extra config
 * field (their config readers pick the fields they understand), so
 * e2b/instabox/box keep working.
 */

import type { SandboxSpec } from "@agentproto/sandbox"

/** Config field naming the stable holder on the provider spec. */
export const SANDBOX_SESSION_HOLDER_KEY = "sessionHolder"

/** Provider config keys known to carry no credentials. Deliberately an
 *  allowlist: `input.sandbox.config` is caller-supplied and arbitrary, so a
 *  denylist would persist any secret hiding under a key it does not name. */
const SAFE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "template",
  "size",
  "cpus",
  "memoryMiB",
  "rootDiskMiB",
  "ttlSeconds",
  "port",
  "workspace",
  "egress",
  "maxSessions",
  "daemonRoute",
  "tenantId",
  "installPackages",
  "installAdapters",
  "updateCliOnBoot",
  "cliVersion",
  "timeoutMs",
  "healthProbeTimeoutMs",
  "daemonReadyTimeoutMs",
  "pollIntervalMs",
  "updateCliTimeoutMs",
  "waitReadyTimeoutMs",
  "swapMb",
])

/**
 * Build the config persisted on a descriptor from the effective boot spec:
 * the non-secret keys plus the stable `sessionHolder`. `holder` (the agentproto
 * session id, or the provider-visible box session id) is always present so a
 * re-attach never sends an empty config.
 */
export function sandboxConfigForDescriptor(
  config: Record<string, unknown> | undefined,
  holder: string,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value !== undefined && SAFE_CONFIG_KEYS.has(key)) clean[key] = value
  }
  return { ...clean, [SANDBOX_SESSION_HOLDER_KEY]: holder }
}

/**
 * Config to hand a provider on re-attach: the persisted non-secret config when
 * the descriptor has one, otherwise just the stable holder. `fallbackHolder` is
 * the descriptor's own session id — used for descriptors written before
 * `sandboxConfig` existed, which never sent a holder; their first re-attach
 * injects one so the provider can create/reuse a slot deterministically.
 */
export function sandboxConfigForReattach(
  sandboxConfig: Record<string, unknown> | undefined,
  fallbackHolder: string,
): Record<string, unknown> {
  const base = sandboxConfig ?? {}
  const persisted =
    typeof base[SANDBOX_SESSION_HOLDER_KEY] === "string"
      ? (base[SANDBOX_SESSION_HOLDER_KEY] as string)
      : undefined
  return { ...base, [SANDBOX_SESSION_HOLDER_KEY]: persisted ?? fallbackHolder }
}

/** Return a spec whose `config.sessionHolder` is `holder` (no-op when unset). */
export function withSandboxSessionHolder(spec: SandboxSpec, holder: string | undefined): SandboxSpec {
  if (holder === undefined || holder.length === 0) return spec
  return { ...spec, config: { ...spec.config, [SANDBOX_SESSION_HOLDER_KEY]: holder } }
}
