/**
 * Browser family on top of `@agentproto/adapter-kit` — Phase 3 (lightest
 * adoption: no creds, no wizard, no catalog file).
 *
 * Provides the kit-compatible types (`BrowserAdapterHandle`) and the
 * `makeBrowserAdapterLister` factory that wraps the existing injected
 * `listBrowserAdapters` / `resolveBrowserAdapter` functions in a standard
 * `AdapterLister<BrowserAdapterInfo>`.
 *
 * The resulting lister is passed as the `lister` option to
 * `registerBrowserTools`, which uses it to produce the same
 * `{ id, name, description, defaultPort }[]` JSON the legacy path emits
 * (output shape is unchanged — only the internal flow changes).
 *
 * Kit invariants honoured:
 *   - `check()` is NEVER called by the lister (OQ-5).
 *   - `BrowserAdapterInfo` carries no cred values (Appendix B).
 *   - `requiresSetup = false` → status is always "ready" without a ledger.
 */

import {
  makeAdapterLister,
  type AdapterHandle,
  type AdapterLister,
} from "@agentproto/adapter-kit"
import type {
  BrowserAdapterInfo,
  BrowserAdapterLister,
  BrowserAdapterResolver,
} from "./browser-tools.js"

// ── Handle ────────────────────────────────────────────────────────────────────

/**
 * Kit-compatible handle for a single in-process browser adapter.
 * `requiresSetup` is always `false` — browser adapters need no creds or
 * setup wizard, so the kit classifies them as "ready" on first resolution.
 */
export interface BrowserAdapterHandle extends AdapterHandle {
  readonly requiresSetup: false
  readonly defaultPort: number
}

function makeBrowserHandle(
  entry: { id: string; name: string; description: string; defaultPort: number },
  resolve?: BrowserAdapterResolver,
): BrowserAdapterHandle {
  return {
    slug: entry.id,
    name: entry.name,
    version: "built-in",
    description: entry.description,
    requiresSetup: false,
    defaultPort: entry.defaultPort,
    // check() is available for on-demand health probes but is never called
    // by the lister (kit invariant OQ-5). Returns true when the adapter
    // is present in the injected resolver map, false otherwise.
    check: async () => (resolve ? resolve(entry.id) != null : true),
  }
}

// ── Noop ledger ───────────────────────────────────────────────────────────────

// Browser adapters have requiresSetup=false, so the ledger result is
// irrelevant to status classification. A lightweight noop avoids any
// filesystem side-effects.
const noopLedger = {
  exists: async (_slug: string): Promise<boolean> => false,
  write: async (): Promise<void> => {},
  read: async (_slug: string) => null,
}

// ── Lister factory ────────────────────────────────────────────────────────────

/**
 * Build a kit-compatible `AdapterLister<BrowserAdapterInfo>` from the
 * existing injected browser adapter functions. The returned lister uses an
 * empty catalog and `discoverExtras` to surface the injected adapters, then
 * maps each resolved handle's fields into a `BrowserAdapterInfo` descriptor.
 *
 * The caller should pass the result as the `lister` option to
 * `registerBrowserTools`, which extracts `AdapterEntry.info` to preserve the
 * existing tool response shape.
 */
export function makeBrowserAdapterLister(opts: {
  listBrowserAdapters: BrowserAdapterLister
  resolveBrowserAdapter?: BrowserAdapterResolver
}): AdapterLister<BrowserAdapterInfo> {
  const { listBrowserAdapters, resolveBrowserAdapter } = opts

  return makeAdapterLister<BrowserAdapterHandle, BrowserAdapterInfo>({
    // Empty catalog — all adapters are discovered via discoverExtras below.
    catalog: [],
    // Resolver is never called with an empty catalog; noop is safe.
    resolver: async () => null,
    ledger: noopLedger,
    toInfo: (handle): BrowserAdapterInfo => ({
      id: handle.slug,
      name: handle.name,
      description: handle.description,
      defaultPort: handle.defaultPort,
    }),
    // Surface every injected adapter as a discovered extra. The kit will
    // call entryFor() on each, which reads ledger (returns false) and
    // computes status as "ready" because requiresSetup=false.
    discoverExtras: async () => {
      const entries = listBrowserAdapters()
      return entries.map(entry => makeBrowserHandle(entry, resolveBrowserAdapter))
    },
  })
}
