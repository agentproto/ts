import {
  makeAdapterLister,
  type AdapterHandle,
  type AdapterLister,
  type SetupLedger,
} from "@agentproto/provider-kit"
import type { BrowserCapabilities } from "./capabilities.js"
import type { BrowserRegistry } from "./registry.js"
import type { BrowserLocation, BrowserProvider, BrowserTransport } from "./provider.js"

/** Safe descriptor listed per provider. Never carries credentials. */
export interface BrowserProviderInfo {
  id: string
  transport: BrowserTransport
  location: BrowserLocation
  capabilities: BrowserCapabilities
}

interface BrowserAdapterHandle extends AdapterHandle {
  readonly provider: BrowserProvider
}

// Providers with no config steps never need setup, so the ledger is not consulted.
const noopLedger: SetupLedger = {
  exists: async () => false,
  write: async () => {},
  read: async () => null,
}

/**
 * Build the standard provider-kit lister over a registry: every registered
 * provider is surfaced as an `AdapterEntry<BrowserProviderInfo>`. As with the
 * other kits, `check()` is never called while listing.
 */
export function makeBrowserProviderLister(opts: {
  registry: BrowserRegistry
  ledger?: SetupLedger
}): AdapterLister<BrowserProviderInfo> {
  const toHandle = (p: BrowserProvider): BrowserAdapterHandle => ({
    slug: p.id,
    name: p.name,
    version: p.version,
    description: p.description,
    requiresSetup: p.config.length > 0,
    check: p.check ? () => p.check!() : async () => true,
    provider: p,
  })

  return makeAdapterLister<BrowserAdapterHandle, BrowserProviderInfo>({
    catalog: [],
    resolver: async (slug) => {
      const p = opts.registry.get(slug)
      return p ? toHandle(p) : null
    },
    ledger: opts.ledger ?? noopLedger,
    discoverExtras: async () => opts.registry.list().map(toHandle),
    toInfo: ({ provider: p }) => ({
      id: p.id,
      transport: p.transport,
      location: p.location,
      capabilities: p.capabilities,
    }),
  })
}
