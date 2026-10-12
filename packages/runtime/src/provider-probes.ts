/**
 * Shared, bounded probes for provider-package discovery and import — the
 * sentinel / tunnel / sandbox registries' common "is this package there, and
 * can we load it?" layer. Internal: not re-exported from the package barrel,
 * consumed by the three family registries and their tests.
 *
 * Why this exists (measured on the live daemon, Node 22.22): every MCP POST
 * constructs a fresh server and registers the three adapter-tool families.
 * Each registration ran `discoverAdapterPackages()` — a fresh `node_modules`
 * walk — and then dynamic-`import()`ed every discovered package looking for a
 * family handle. pnpm's walker explicitly includes
 * `node_modules/.pnpm/node_modules` (the hoisted virtual store), which is NOT
 * on a bare import's resolution path from this module, so 13 of 27 discovered
 * adapters were physically on disk yet unimportable: 156
 * `ERR_MODULE_NOT_FOUND` loads in five seconds (13 packages x 2 families x 6
 * requests), plus `@agentproto/sandbox-modal` / `-daytona` on every sandbox
 * registration. Each miss enters Node 22's async ESM loader, whose error path
 * leaves an unreclaimed MessagePort behind — the ~77k native async handles /
 * 100-165% CPU-with-idle-JS finding that motivated this patch.
 *
 * What it fixes, without changing what a successful import returns:
 *   - a synchronous preflight (`import.meta.resolve`, the same resolver base
 *     and `import` conditions the dynamic import uses) answers "provably
 *     missing" before any `import()` runs, so a missing package never enters
 *     the async loader. When the runtime is bundled into the CLI
 *     (`tsup` `noExternal`), `import.meta.url` is the bundle's URL — the exact
 *     base the bundled dynamic import resolves from, so preflight and import
 *     can't disagree (npm-global, workspace or pnpm layouts alike);
 *   - probe results (module namespace or "missing") are cached in a bounded,
 *     TTL-expiring, concurrency-coalescing cache shared across families: one
 *     probe per specifier per window instead of one per request per family;
 *   - the discovered-package list is cached for 60s the same way.
 *
 * Only the module namespace is ever cached — it is credential-independent (and
 * identical to what Node's own ESM cache would hand back). Every provider
 * handle is rebuilt from the cached module on each request with that request's
 * own creds, so no credential-dependent instance and no MCP server is shared
 * across requests. Failures are cached too: negative probe results expire
 * after 60s and the next request retries. This bounds this cache's staleness,
 * not other resolver caches. There is no automatic install-triggered flush.
 * {@link invalidateProviderProbes} exists as an explicit invalidation seam
 * for callers that want an immediate refresh; it has no production caller
 * today, and this patch does not add one.
 *
 * No family metadata exists to filter on before import (discovery yields only
 * slug + packageName, and first-party `@agentproto/adapter-<slug>` names are
 * shared by agent, tunnel and sentinel conventions), so this deliberately
 * invents none: the safe pre-import filters used are the slug exclusions the
 * registries already apply plus synchronous resolvability.
 */

import {
  discoverAdapterPackages,
  type DiscoveredAdapter,
} from "@agentproto/provider-kit"

/** An imported provider package's namespace, narrowed to a property bag. */
export type ProviderModule = Record<string, unknown>

/** Anything with a family registry's third-party import seam. */
export interface ProviderProbe {
  /**
   * Import `specifier` through the probe: the module namespace on success,
   * `null` when the package is missing or fails to load. Results are cached,
   * concurrent calls are coalesced, and a package the sync preflight proves
   * missing never reaches an importer at all.
   */
  probe(specifier: string): Promise<ProviderModule | null>
}

/** Coalescing + TTL + LRU-bounded probe cache. */
export interface ProviderProbeCache extends ProviderProbe {
  /** Drop one cached probe (or all of them) — e.g. after an install. */
  invalidate(specifier?: string): void
  /** Live cache entries (bounded by `maxEntries`). */
  readonly size: number
}

export interface ProviderProbeCacheOptions {
  /**
   * Sync preflight: `true` means "an `import()` of this specifier is known to
   * fail — don't run it". Defaults to {@link missingSyncDefault}.
   */
  missingSync?: (specifier: string) => boolean
  /** Underlying loader — defaults to a real dynamic `import()`. */
  importModule?: (specifier: string) => Promise<ProviderModule>
  /** Clock, injectable for expiry tests. */
  now?: () => number
  /** Entry lifetime. Default 60s (matches the CLI's adapter-listing TTL). */
  ttlMs?: number
  /** Cache bound. Default 128 specifiers. */
  maxEntries?: number
}

/** Default probe-cache tuning, exported so tests can assert against it. */
export const PROBE_TTL_MS = 60_000
export const PROBE_MAX_ENTRIES = 128
/** Default discovery-list caching, exported for the same reason. */
export const DISCOVERY_TTL_MS = 60_000
export const DISCOVERY_MAX_ENTRIES = 8

/**
 * `import.meta.resolve` as it exists here: Node >= 20.9 exposes it as a
 * synchronous module-scoped function; module runners that rewrite `import.meta`
 * (vite/vitest) may not, and TypeScript's `ImportMeta` type predates it.
 */
type ImportMetaWithResolve = ImportMeta & {
  resolve?: (specifier: string) => string
}

/**
 * Synchronous "will this import definitely fail?" check — the guard that keeps
 * missing packages out of Node 22's async loader.
 *
 * `import.meta.resolve(specifier)` answers with the SAME resolver base and the
 * SAME `import` conditions a dynamic `import()` of the same specifier uses (it
 * is this module's own `import.meta`, i.e. the URL a bundled `import()` would
 * resolve from), and it throws `ERR_MODULE_NOT_FOUND` — synchronously, without
 * entering the async ESM loader — exactly when the package is absent from this
 * resolution tree. Only that code means "definitely missing". Verified against
 * the pnpm workspace: all 13 virtual-store-only adapters and both unpublished
 * sandbox placeholders resolve-fail here AND fail `import()` with
 * `ERR_MODULE_NOT_FOUND`.
 *
 * Deliberately NOT `require.resolve`: the `require` condition set is narrower
 * than `import`, so a perfectly importable package whose exports map offers an
 * `import` target but no `require`/`default` target looks missing there
 * (`MODULE_NOT_FOUND` or `ERR_PACKAGE_PATH_NOT_EXPORTED`) and would be
 * silently dropped as a provider.
 *
 * Every other condition must still reach the loader:
 *   - no `import.meta.resolve` at all (module runners that rewrite
 *     `import.meta`) → answer `false` and let the normal dynamic import decide;
 *   - `ERR_PACKAGE_PATH_NOT_EXPORTED`, `ERR_INVALID_MODULE_SPECIFIER`, … →
 *     `false`: not decidable as missing, so `import()` runs and its own error
 *     becomes the cached negative.
 */
export function missingSyncDefault(specifier: string): boolean {
  const meta = import.meta as ImportMetaWithResolve
  if (typeof meta.resolve !== "function") return false
  try {
    meta.resolve(specifier)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
  }
}

interface ProbeEntry {
  expires: number
  value: ProviderModule | null
}

/**
 * Build an independent probe cache. The registries use the shared instance
 * ({@link sharedProviderProbe}); tests build their own with fake clock,
 * loader and preflight to cover expiry, coalescing and invalidation without
 * touching the real module system.
 */
export function createProviderProbeCache(
  opts: ProviderProbeCacheOptions = {},
): ProviderProbeCache {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? PROBE_TTL_MS
  const maxEntries = Math.max(1, opts.maxEntries ?? PROBE_MAX_ENTRIES)
  const missingSync = opts.missingSync ?? missingSyncDefault
  const importModule =
    opts.importModule ??
    ((specifier: string): Promise<ProviderModule> => import(specifier))

  const entries = new Map<string, ProbeEntry>()
  const pending = new Map<string, Promise<ProviderModule | null>>()
  // Bumped by invalidate() so an in-flight probe started before the
  // invalidation can't write its now-stale result back into the cache.
  let generation = 0

  const probe = (specifier: string): Promise<ProviderModule | null> => {
    const found = entries.get(specifier)
    if (found && found.expires > now()) {
      // Refresh recency for the LRU bound; the expiry itself is unchanged.
      entries.delete(specifier)
      entries.set(specifier, found)
      return Promise.resolve(found.value)
    }
    if (found) entries.delete(specifier)

    const inFlight = pending.get(specifier)
    if (inFlight) return inFlight

    const startedGeneration = generation
    const run = (async (): Promise<ProviderModule | null> => {
      if (missingSync(specifier)) return null
      try {
        return await importModule(specifier)
      } catch {
        // Not importable / wrong shape: the registries treat null as
        // "supported but not installed", partial discovery beats failing the
        // whole listing.
        return null
      }
    })()
    const tracked = run
      .then((value): ProviderModule | null => {
        if (generation === startedGeneration) {
          entries.delete(specifier)
          entries.set(specifier, { expires: now() + ttlMs, value })
          while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value
            if (oldest === undefined) break
            entries.delete(oldest)
          }
        }
        return value
      })
      .finally(() => {
        if (pending.get(specifier) === tracked) pending.delete(specifier)
      })
    pending.set(specifier, tracked)
    return tracked
  }

  return {
    probe,
    invalidate(specifier?: string): void {
      generation++
      if (specifier === undefined) {
        entries.clear()
        pending.clear()
        return
      }
      entries.delete(specifier)
      pending.delete(specifier)
    },
    get size(): number {
      return entries.size
    },
  }
}

/** The process-wide import-probe cache every family registry shares. */
export const sharedProviderProbe: ProviderProbeCache = createProviderProbeCache()

/** How a registry obtains the discovered-package list (injectable in tests). */
export type AdapterDiscoverer = (
  opts?: { start?: string },
) => Promise<readonly DiscoveredAdapter[]>

export interface AdapterDiscoveryCacheOptions {
  /** Underlying walker — defaults to the provider-kit scanner. */
  discover?: AdapterDiscoverer
  /** Clock, injectable for expiry tests. */
  now?: () => number
  /** Entry lifetime. Default 60s. */
  ttlMs?: number
  /** Cache bound (distinct `start` roots). Default 8. */
  maxEntries?: number
}

/** TTL-expiring, coalescing, bounded cache over `discoverAdapterPackages`. */
export interface AdapterDiscoveryCache {
  /** Discover adapter packages, reusing the cached list while it is fresh. */
  discover(opts?: { start?: string }): Promise<readonly DiscoveredAdapter[]>
  /** Drop the cached list(s) — e.g. after an install adds a package. */
  invalidate(): void
  /** Live cache entries. */
  readonly size: number
}

interface DiscoveryEntry {
  expires: number
  value: readonly DiscoveredAdapter[]
}

/**
 * Build an independent discovery cache (tests inject a fake walker/clock).
 * Mirrors `createProviderProbeCache`: bounded, coalesced, generation-guarded.
 */
export function createAdapterDiscoveryCache(
  opts: AdapterDiscoveryCacheOptions = {},
): AdapterDiscoveryCache {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? DISCOVERY_TTL_MS
  const maxEntries = Math.max(1, opts.maxEntries ?? DISCOVERY_MAX_ENTRIES)
  const discover =
    opts.discover ??
    ((discoverOpts?: { start?: string }) => discoverAdapterPackages(discoverOpts))

  const entries = new Map<string, DiscoveryEntry>()
  const pending = new Map<string, Promise<readonly DiscoveredAdapter[]>>()
  let generation = 0

  const run = (key: string, discoverOpts?: { start?: string }) => {
    const found = entries.get(key)
    if (found && found.expires > now()) {
      entries.delete(key)
      entries.set(key, found)
      return Promise.resolve(found.value)
    }
    if (found) entries.delete(key)

    const inFlight = pending.get(key)
    if (inFlight) return inFlight

    const startedGeneration = generation
    const tracked = Promise.resolve()
      .then(() => discover(discoverOpts))
      .then((value) => {
        if (generation === startedGeneration) {
          entries.delete(key)
          entries.set(key, { expires: now() + ttlMs, value })
          while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value
            if (oldest === undefined) break
            entries.delete(oldest)
          }
        }
        return value
      })
      .finally(() => {
        if (pending.get(key) === tracked) pending.delete(key)
      })
    pending.set(key, tracked)
    return tracked
  }

  return {
    discover(discoverOpts?: { start?: string }) {
      return run(discoverOpts?.start ?? "", discoverOpts)
    },
    invalidate(): void {
      generation++
      entries.clear()
      pending.clear()
    },
    get size(): number {
      return entries.size
    },
  }
}

/** The process-wide discovery cache shared by the sentinel/tunnel registries. */
export const sharedAdapterDiscovery: AdapterDiscoveryCache =
  createAdapterDiscoveryCache()

/**
 * Explicit invalidation seam: drop cached discovery lists and import probes
 * so a previously-missing provider can be probed again immediately instead
 * of waiting out the TTL. Meant for callers that know an install changed
 * what resolves — it has no production caller today, and this patch does not
 * add one: without a call here, these caches retry after their TTLs expire
 * (`PROBE_TTL_MS` / `DISCOVERY_TTL_MS`, 60s each). With no argument every
 * probe is dropped.
 */
export function invalidateProviderProbes(specifier?: string): void {
  sharedProviderProbe.invalidate(specifier)
  sharedAdapterDiscovery.invalidate()
}
