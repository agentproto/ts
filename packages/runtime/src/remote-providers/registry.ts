/**
 * Slug-keyed tunnel provider registry — the single source of truth that both
 * halves of the tunnel family consult:
 *
 *   - the adapter-kit listing path (`list_tunnel_adapters` / `setup_tunnel_provider`)
 *   - the lifecycle path (`TunnelRegistry`: create / restore / start / stop)
 *
 * Before this module those two halves spoke different languages — the
 * lifecycle engine only knew the short discriminators `"quick"`/`"named"` and
 * had no ngrok case at all, while the adapter half spoke slugs. They never
 * reconciled, so ngrok was listable-but-not-creatable. Routing everything
 * through one registry collapses that: a built-in OR a third-party
 * `@agentproto/adapter-<slug>` / `@<scope>/agentproto-adapter-<slug>` provider
 * resolves the same way and works end to end.
 */

import { discoverAdapterPackages } from "@agentproto/adapter-kit"

import {
  quickTunnelProvider,
  CLOUDFLARE_QUICK_SLUG,
} from "./quick.js"
import {
  namedTunnelProvider,
  CLOUDFLARE_NAMED_SLUG,
} from "./named.js"
import { ngrokTunnelProvider, NGROK_SLUG } from "./ngrok.js"
import type {
  RemoteProvider,
  TunnelProviderHandle,
  TunnelProviderCapabilities,
} from "./types.js"

/** A resolved provider — the lifecycle + adapter-kit handle surface combined. */
export type TunnelProvider = RemoteProvider & TunnelProviderHandle

/** Per-slug credentials, as stored by the creds store / setup tool. */
export type TunnelCreds = Record<string, string>

/**
 * Factory for a tunnel provider. Built-ins and third-party packages both
 * expose this shape: given the slug's stored creds (or null for a
 * descriptor-only handle used in listing), return a ready provider.
 */
export type TunnelProviderFactory = (creds?: TunnelCreds | null) => TunnelProvider

/**
 * Built-in providers keyed by canonical slug. This replaces BOTH the old
 * `pickProvider()` switch (lifecycle) and the `makeTunnelResolver()` switch
 * (listing) — one map, two consumers.
 */
export const BUILTIN_TUNNEL_PROVIDERS: Record<string, TunnelProviderFactory> = {
  [CLOUDFLARE_QUICK_SLUG]: () => quickTunnelProvider(),
  [CLOUDFLARE_NAMED_SLUG]: (creds) =>
    namedTunnelProvider({
      hostname: creds?.hostname ?? "",
      tunnelId: creds?.tunnelId ?? "",
      ...(creds?.credentialsFile
        ? { credentialsFile: creds.credentialsFile }
        : {}),
    }),
  [NGROK_SLUG]: (creds) =>
    ngrokTunnelProvider(
      creds?.authToken
        ? {
            authToken: creds.authToken,
            ...(creds.domain ? { domain: creds.domain } : {}),
          }
        : undefined,
    ),
}

/** The canonical built-in slugs, in catalog order. */
export const BUILTIN_TUNNEL_SLUGS = [
  CLOUDFLARE_QUICK_SLUG,
  CLOUDFLARE_NAMED_SLUG,
  NGROK_SLUG,
] as const

/**
 * Legacy short discriminators → canonical slugs. Persisted `tunnels.json`
 * descriptors and existing automations create tunnels with `"quick"` /
 * `"named"`; we normalize those to slugs everywhere so old state restores and
 * old callers keep working.
 */
export const LEGACY_PROVIDER_ALIAS: Record<string, string> = {
  quick: CLOUDFLARE_QUICK_SLUG,
  named: CLOUDFLARE_NAMED_SLUG,
}

/** Map a raw provider string (slug OR legacy short name) to a canonical slug. */
export function normalizeProviderSlug(raw: string): string {
  return LEGACY_PROVIDER_ALIAS[raw] ?? raw
}

/**
 * Capabilities for a BUILT-IN provider slug (or legacy short name), read
 * synchronously from a descriptor-only handle. Returns null for third-party
 * slugs (their capabilities need an async import — `resolveTunnelProvider`).
 * Used by the lifecycle engine to decide autostart eligibility by data
 * (`stableUrl`) rather than a hardcoded slug literal.
 */
export function builtinProviderCapabilities(
  raw: string,
): TunnelProviderCapabilities | null {
  const factory = BUILTIN_TUNNEL_PROVIDERS[normalizeProviderSlug(raw)]
  return factory ? factory(null).capabilities : null
}

const slugToCamel = (slug: string): string =>
  slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

/** Duck-type a value as a tunnel provider handle (no secrets touched). */
function isTunnelProvider(x: unknown): x is TunnelProvider {
  if (!x || typeof x !== "object") return false
  const h = x as Record<string, unknown>
  const caps = h.capabilities
  return (
    typeof h.start === "function" &&
    typeof h.stop === "function" &&
    typeof caps === "object" &&
    caps !== null &&
    "stableUrl" in (caps as Record<string, unknown>)
  )
}

/**
 * Import a third-party tunnel provider package and build its handle. The
 * package may export either a factory `(creds) => handle` or a ready static
 * handle, under `<camelSlug>TunnelProvider`, `<camelSlug>`, `default`, or
 * `handle`. Returns null on any failure (not importable / wrong shape) —
 * partial discovery beats failing the whole listing on one bad package.
 */
async function importThirdPartyProvider(
  packageName: string,
  slug: string,
  creds: TunnelCreds | null,
): Promise<TunnelProvider | null> {
  let mod: Record<string, unknown>
  try {
    mod = (await import(packageName)) as Record<string, unknown>
  } catch {
    return null
  }
  const camel = slugToCamel(slug)
  const candidate =
    mod[`${camel}TunnelProvider`] ??
    mod[camel] ??
    mod.default ??
    mod.handle
  const built =
    typeof candidate === "function"
      ? (candidate as TunnelProviderFactory)(creds)
      : candidate
  return isTunnelProvider(built) ? built : null
}

export interface ResolveTunnelProviderOpts {
  /** Stored creds for the slug (descriptor-only listing passes null). */
  creds?: TunnelCreds | null
}

/**
 * Resolve a slug (or legacy short name) to a concrete provider. Built-ins
 * first (no import), then a third-party package discovered on disk across
 * both naming conventions. Returns null when the slug is unknown / not
 * installed — the kit's "supported but unavailable" signal.
 */
export async function resolveTunnelProvider(
  raw: string,
  opts?: ResolveTunnelProviderOpts,
): Promise<TunnelProvider | null> {
  const slug = normalizeProviderSlug(raw)
  const builtin = BUILTIN_TUNNEL_PROVIDERS[slug]
  if (builtin) return builtin(opts?.creds ?? null)

  const pkgs = await discoverAdapterPackages()
  const match = pkgs.find((p) => p.slug === slug)
  if (!match) return null
  return importThirdPartyProvider(match.packageName, slug, opts?.creds ?? null)
}

/**
 * Discover installed third-party tunnel providers NOT already in the catalog
 * (built-ins) — the `discoverExtras` source for the kit's lister so
 * locally-installed custom providers appear in `list_tunnel_adapters`.
 */
export async function discoverTunnelHandles(
  catalogSlugs: Set<string>,
): Promise<TunnelProvider[]> {
  const pkgs = await discoverAdapterPackages()
  const out: TunnelProvider[] = []
  for (const pkg of pkgs) {
    if (catalogSlugs.has(pkg.slug)) continue
    if (BUILTIN_TUNNEL_PROVIDERS[pkg.slug]) continue
    const handle = await importThirdPartyProvider(pkg.packageName, pkg.slug, null)
    if (handle) out.push(handle)
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}
