import { listAdaptersWithAcp, listHarnessCapabilities } from "./resolve.js"
import { listCatalogModelsFromInstalled } from "./catalog-models.js"
import { CATALOG } from "./catalog.js"
import type { DiscoveryRequest } from "./isolated-discovery.js"

// Discovery currently imports every installed adapter, including native ML / DB
// libraries. Ending this process releases those modules and native allocations;
// spawning an actual agent still resolves only its requested adapter in the daemon.
process.once("message", async (request: DiscoveryRequest) => {
  try {
    const result = request.kind === "adapters"
      ? await listAdaptersWithAcp(CATALOG)
      : request.kind === "capabilities"
        ? await listHarnessCapabilities({ adapter: request.adapter })
        : await listCatalogModelsFromInstalled(request.query)
    process.send?.({ ok: true, result }, () => process.exit(0))
  } catch (error) {
    process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) }, () => process.exit(1))
  }
})
