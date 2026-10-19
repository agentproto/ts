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
 * Secrets never reach the descriptor: a key that names a credential is
 * dropped on the way in (token, extraHeaders, …). Providers that do not know
 * `sessionHolder` simply ignore the extra config field (their config readers
 * pick the fields they understand), so e2b/instabox/box keep working.
 */

import type { SandboxSpec } from "@agentproto/sandbox"

/** Config field naming the stable holder on the provider spec. */
export const SANDBOX_SESSION_HOLDER_KEY = "sessionHolder"

/** Provider-agnostic credential markers — any config key matching one is not
 *  persisted to the descriptor (no token, no auth header). */
const SECRET_KEY_RE =
  /(token|secret|password|passwd|passphrase|api[-_]?key|authorization|cookie|credential|private[-_]?key|client[-_]?secret|access[-_]?key|headers?)/i

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) continue
      if (entry === undefined) continue
      out[key] = sanitizeValue(entry)
    }
    return out
  }
  return value
}

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
  const clean = sanitizeValue(config ?? {}) as Record<string, unknown>
  return { ...clean, [SANDBOX_SESSION_HOLDER_KEY]: holder }
}

/**
 * Config to hand a provider on re-attach: the persisted non-secret config when
 * the descriptor has one, otherwise just the stable holder. `fallback` is the
 * descriptor's own session id — the holder a pre-fix spawn effectively used.
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
