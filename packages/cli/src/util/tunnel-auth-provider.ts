/**
 * Shared transient `device-code` auth-provider handle for a tunnel host.
 *
 * `agentproto auth login` (../commands/auth.ts) and `agentproto serve`'s
 * silent-refresh path (../commands/serve.ts) both need to hand `runAuthFlow`
 * an identical provider handle for the same host — this is the one place
 * that builds it, so the two call sites can't drift apart.
 */

import { defineAuthProvider, type AuthProviderHandle } from "@agentproto/auth"
import { normaliseHost } from "./credentials.js"

/**
 * The host URL the user passes is typically a wss:// (tunnel) URL. The OAuth
 * metadata document lives at the http(s) origin of the same host. This
 * converter assumes wss → https, ws → http; everything else passes through.
 */
export function toHttpHost(host: string): string {
  const trimmed = host.replace(/\/+$/, "")
  if (trimmed.startsWith("wss://")) return "https://" + trimmed.slice(6)
  if (trimmed.startsWith("ws://")) return "http://" + trimmed.slice(5)
  return trimmed
}

/** Derive a valid AIP cross-id (`/^[a-z0-9][a-z0-9._-]{1,79}$/`) from a host
 *  URL for the transient provider — the id is only used for logging /
 *  `provider.id` interpolation in the engine's ceremony output, never
 *  persisted or looked up by name. */
function providerIdForHost(host: string): string {
  const slug = host
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, 74)
  return `tunnel-${slug || "host"}`
}

export function buildTunnelAuthProvider(
  host: string,
  opts: { label: string; scope?: string; clientId?: string },
): AuthProviderHandle {
  const normalizedHost = normaliseHost(host)
  return defineAuthProvider({
    id: providerIdForHost(normalizedHost),
    description: `Transient device-code auth provider for agentproto tunnel host ${normalizedHost}.`,
    apiBase: toHttpHost(host),
    audience: "tunnel",
    auth: {
      flow: "device-code",
      clientId: opts.clientId ?? "agentproto-cli",
      ...(opts.scope ? { scope: opts.scope } : {}),
      deviceLabel: opts.label,
      tokenStore: {
        keychain: "agentproto-daemon",
        account: normalizedHost,
      },
    },
  })
}
