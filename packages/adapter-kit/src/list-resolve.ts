/**
 * List / resolve factories (§3). Families compose these to build their
 * injected list/resolve functions. The runtime package keeps importing zero
 * concrete adapters — everything flows through the injected `load` / `toInfo`.
 *
 * Per OQ-5: `makeAdapterLister` NEVER calls `handle.check()`. Status comes
 * solely from resolvability + ledger/creds existence.
 */

import type { CredsStore } from "./creds-store.js"
import type { SetupLedger } from "./ledger.js"
import { computeStatus } from "./status.js"
import type {
  AdapterCatalog,
  AdapterEntry,
  AdapterHandle,
  AdapterLister,
  AdapterResolver,
} from "./types.js"

export interface MakeAdapterResolverOpts<THandle> {
  /**
   * Try to load the handle for a slug. Throw = not installed.
   * Conventionally a dynamic import of `@<scope>/adapter-<slug>`.
   */
  load: (slug: string) => Promise<THandle>
}

/**
 * Wrap a throwing `load` into a resolver that returns `null` on failure
 * (the "not installed / not importable" signal the status engine reads).
 */
export function makeAdapterResolver<THandle>(
  opts: MakeAdapterResolverOpts<THandle>
): AdapterResolver<THandle> {
  return async (slug: string): Promise<THandle | null> => {
    try {
      return await opts.load(slug)
    } catch {
      return null
    }
  }
}

export interface MakeAdapterListerOpts<THandle extends AdapterHandle, TInfo> {
  catalog: AdapterCatalog
  resolver: AdapterResolver<THandle>
  ledger: SetupLedger
  /** Optional; when present its `exists()` is fed into the status engine. */
  credsStore?: CredsStore<unknown>
  /** Extract the safe descriptor from a resolved handle. Never include secrets. */
  toInfo: (handle: THandle) => TInfo
  /**
   * Optional family-specific discovery of handles NOT in the catalog
   * (the agent-CLI node_modules walker, or the browser injected map).
   * Returned handles whose slug is already in the catalog are ignored;
   * the rest are appended sorted by slug. Per OQ-5 their `check()` is
   * never invoked here either — they are already resolved handles.
   */
  discoverExtras?: () => Promise<THandle[]>
}

/**
 * Build the family's lister. The lister:
 *   1. Iterates the catalog in order.
 *   2. Resolves each slug, reads ledger.exists() + optional credsStore.exists(),
 *      and classifies via computeStatus(). Never calls handle.check().
 *   3. Appends discovered extras (not in catalog) sorted by slug.
 */
export function makeAdapterLister<THandle extends AdapterHandle, TInfo>(
  opts: MakeAdapterListerOpts<THandle, TInfo>
): AdapterLister<TInfo> {
  const { catalog, resolver, ledger, credsStore, toInfo, discoverExtras } = opts

  async function entryFor(
    handle: THandle,
    fallback: {
      slug: string
      name: string
      description: string
      packageName: string
      hint?: string
    }
  ): Promise<AdapterEntry<TInfo>> {
    const ledgerExists = await ledger.exists(handle.slug)
    const credsExist = credsStore
      ? await credsStore.exists(handle.slug)
      : undefined
    const status = computeStatus({
      resolved: true,
      requiresSetup: handle.requiresSetup,
      ledgerExists,
      credsExist,
    })
    return {
      slug: handle.slug,
      name: handle.name || fallback.name,
      description: handle.description || fallback.description,
      packageName: fallback.packageName,
      ...(fallback.hint !== undefined ? { hint: fallback.hint } : {}),
      status,
      version: handle.version,
      info: toInfo(handle),
    }
  }

  return async (): Promise<AdapterEntry<TInfo>[]> => {
    const out: AdapterEntry<TInfo>[] = []
    const seen = new Set<string>()

    // 1 + 2 — catalog entries, in catalog order.
    for (const entry of catalog) {
      seen.add(entry.slug)
      const handle = await resolver(entry.slug)
      if (!handle) {
        // Not importable → "supported" (known but not installed).
        out.push({
          slug: entry.slug,
          name: entry.name,
          description: entry.description,
          packageName: entry.packageName,
          ...(entry.hint !== undefined ? { hint: entry.hint } : {}),
          status: "supported",
          version: "not installed",
        })
        continue
      }
      out.push(await entryFor(handle, entry))
    }

    // 3 — discovered extras not in the catalog, sorted by slug.
    if (discoverExtras) {
      const extras = await discoverExtras()
      const fresh = extras
        .filter((h) => !seen.has(h.slug))
        .sort((a, b) => a.slug.localeCompare(b.slug))
      for (const handle of fresh) {
        if (seen.has(handle.slug)) continue
        seen.add(handle.slug)
        out.push(
          await entryFor(handle, {
            slug: handle.slug,
            name: handle.name,
            description: handle.description,
            packageName: `@agentproto/adapter-${handle.slug}`,
          })
        )
      }
    }

    return out
  }
}
