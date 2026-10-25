/**
 * Where a push sentinel provider (the `webhook` provider) tells GitHub to
 * call back: the daemon's PUBLIC origin.
 *
 * Resolution order:
 *   1. `AGENTPROTO_PUBLIC_URL` (then `AGENTPROTO_PUBLIC_HTTP_ORIGIN`) — the
 *      operator pinned it, so it counts as stable.
 *   2. An active tunnel forwarding to this daemon's port, with `stable`
 *      taken from the tunnel provider's declared `stableUrl` capability (a
 *      cloudflare quick tunnel gets a fresh hostname per start, so it is
 *      usable but not stable).
 *
 * No tunnel registry access here — the daemon injects a lookup via
 * {@link setSentinelPublicUrlSource}, keeping this module free of the
 * registry/runtime wiring (and trivially testable).
 */

export interface SentinelPublicUrl {
  /** Origin only, no trailing slash, e.g. `https://hooks.example.com`. */
  url: string
  /** Survives daemon/tunnel restarts. Only stable URLs are auto-selected. */
  stable: boolean
  source: "env" | "tunnel"
}

export type SentinelPublicUrlResolver = () => SentinelPublicUrl | undefined

/** A tunnel as far as URL resolution cares. */
export interface PublicUrlTunnel {
  provider: string
  targetPort: number
  publicUrl: string
  status: string
}

function normalizeOrigin(value: string | undefined): string | undefined {
  const candidate = value?.trim()
  if (!candidate) return undefined
  try {
    const url = new URL(candidate)
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    if (url.username || url.password || url.search || url.hash) return undefined
    if (url.pathname !== "/" && url.pathname !== "") return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/** Env-only resolution (step 1). */
export function publicUrlFromEnv(env: NodeJS.ProcessEnv = process.env): SentinelPublicUrl | undefined {
  const url = normalizeOrigin(env.AGENTPROTO_PUBLIC_URL) ?? normalizeOrigin(env.AGENTPROTO_PUBLIC_HTTP_ORIGIN)
  return url ? { url, stable: true, source: "env" } : undefined
}

/** Build a resolver over a live tunnel list (step 2 after env). */
export function makePublicUrlResolver(opts: {
  port: number
  listTunnels: () => readonly PublicUrlTunnel[]
  isStableProvider: (provider: string) => boolean
  env?: NodeJS.ProcessEnv
}): SentinelPublicUrlResolver {
  return () => {
    const fromEnv = publicUrlFromEnv(opts.env)
    if (fromEnv) return fromEnv
    const active = opts
      .listTunnels()
      .filter(t => t.status === "active" && t.targetPort === opts.port)
      .map(t => ({ url: normalizeOrigin(t.publicUrl), provider: t.provider }))
      .filter((t): t is { url: string; provider: string } => t.url !== undefined)
    if (active.length === 0) return undefined
    const stable = active.find(t => opts.isStableProvider(t.provider))
    const pick = stable ?? active[0]!
    return { url: pick.url, stable: stable !== undefined, source: "tunnel" }
  }
}

let configured: SentinelPublicUrlResolver | undefined

/** Daemon boot wires the tunnel-aware resolver here. Until then (and in
 *  tests that don't) resolution is env-only. */
export function setSentinelPublicUrlSource(resolver: SentinelPublicUrlResolver | undefined): void {
  configured = resolver
}

export function resolveSentinelPublicUrl(): SentinelPublicUrl | undefined {
  return (configured ?? (() => publicUrlFromEnv()))()
}
