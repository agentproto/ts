/**
 * Slug-keyed sentinel provider registry — mirrors `remote-providers/registry.ts`
 * (the tunnel family) exactly, so `sentinel-runtime.ts` and
 * `sentinel-adapters.ts`'s kit wiring resolve providers the same way every
 * other adapter family does.
 *
 * Step 3 (AIP-60) adds the first built-in, `local-gh` — zero infra, no
 * credentials. `webhook` / `agentpush` are added by later steps (design §12
 * steps 5, 10) without changing this shape.
 */

import { discoverAdapterPackages } from "@agentproto/provider-kit"

import { localGhSentinelProvider, LOCAL_GH_SLUG } from "./local-gh.js"
import type { SentinelProviderHandle } from "./types.js"

/** Per-slug credentials, as stored by the creds store / setup tool. */
export type SentinelCreds = Record<string, string>

/**
 * Factory for a sentinel provider. Built-ins and third-party packages both
 * expose this shape: given the slug's stored creds (or null for a
 * descriptor-only handle used in listing), return a ready provider.
 */
export type SentinelProviderFactory = (
  creds?: SentinelCreds | null,
) => SentinelProviderHandle

/**
 * Built-in providers keyed by canonical slug. `local-gh` ignores creds — it
 * needs none, it uses the host's ambient `gh` auth.
 */
export const BUILTIN_SENTINEL_PROVIDERS: Record<string, SentinelProviderFactory> = {
  [LOCAL_GH_SLUG]: () => localGhSentinelProvider(),
}

/** The canonical built-in slugs, in catalog order. */
export const BUILTIN_SENTINEL_SLUGS: readonly string[] = [LOCAL_GH_SLUG]

const slugToCamel = (slug: string): string =>
  slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

/** Duck-type a value as a sentinel provider handle (no secrets touched). */
function isSentinelProvider(x: unknown): x is SentinelProviderHandle {
  if (!x || typeof x !== "object") return false
  const h = x as Record<string, unknown>
  const caps = h.capabilities
  return (
    typeof h.create === "function" &&
    typeof h.attach === "function" &&
    typeof h.cancel === "function" &&
    typeof h.status === "function" &&
    typeof h.defaultTypes === "function" &&
    typeof caps === "object" &&
    caps !== null &&
    "subjects" in (caps as Record<string, unknown>)
  )
}

/**
 * Import a third-party sentinel provider package and build its handle. The
 * package may export either a factory `(creds) => handle` or a ready static
 * handle, under `<camelSlug>SentinelProvider`, `<camelSlug>`, `default`, or
 * `handle`. Returns null on any failure (not importable / wrong shape) —
 * partial discovery beats failing the whole listing on one bad package.
 *
 * Naming convention note: discovery is `discoverAdapterPackages` (the shared
 * kit walker), which matches `@agentproto/adapter-<slug>` /
 * `@<scope>/agentproto-adapter-<slug>` — NOT the `agentproto-sentinel-<name>`
 * convention the design doc names, since the kit has no sentinel-specific
 * walker. See the PR description for this deviation.
 */
async function importThirdPartyProvider(
  packageName: string,
  slug: string,
  creds: SentinelCreds | null,
): Promise<SentinelProviderHandle | null> {
  let mod: Record<string, unknown>
  try {
    mod = (await import(packageName)) as Record<string, unknown>
  } catch {
    return null
  }
  const camel = slugToCamel(slug)
  const candidate =
    mod[`${camel}SentinelProvider`] ??
    mod[camel] ??
    mod.default ??
    mod.handle
  const built =
    typeof candidate === "function"
      ? (candidate as SentinelProviderFactory)(creds)
      : candidate
  return isSentinelProvider(built) ? built : null
}

export interface ResolveSentinelProviderOpts {
  /** Stored creds for the slug (descriptor-only listing passes null). */
  creds?: SentinelCreds | null
}

/**
 * Resolve a slug to a concrete provider. Built-ins first (no import), then a
 * third-party package discovered on disk. Returns null when the slug is
 * unknown / not installed — the kit's "supported but unavailable" signal.
 */
export async function resolveSentinelProvider(
  slug: string,
  opts?: ResolveSentinelProviderOpts,
): Promise<SentinelProviderHandle | null> {
  const builtin = BUILTIN_SENTINEL_PROVIDERS[slug]
  if (builtin) return builtin(opts?.creds ?? null)

  const pkgs = await discoverAdapterPackages()
  const match = pkgs.find(p => p.slug === slug)
  if (!match) return null
  return importThirdPartyProvider(match.packageName, slug, opts?.creds ?? null)
}

/**
 * Discover installed third-party sentinel providers NOT already in the
 * catalog — the `discoverExtras` source for the kit's lister so
 * locally-installed custom providers appear in `list_sentinel_adapters`.
 */
export async function discoverSentinelHandles(
  catalogSlugs: Set<string>,
): Promise<SentinelProviderHandle[]> {
  const pkgs = await discoverAdapterPackages()
  const out: SentinelProviderHandle[] = []
  for (const pkg of pkgs) {
    if (catalogSlugs.has(pkg.slug)) continue
    if (BUILTIN_SENTINEL_PROVIDERS[pkg.slug]) continue
    const handle = await importThirdPartyProvider(pkg.packageName, pkg.slug, null)
    if (handle) out.push(handle)
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}
