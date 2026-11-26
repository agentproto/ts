import { describe, it } from "vitest"
import { loadBillingManifest } from "../manifest/index.js"
import { billingUsageConformanceCases, InMemoryStorage, ManualClock } from "../testing/index.js"
import { REFERENCE_MANIFEST } from "../testing/reference-manifest.js"

describe("BILL-USE conformance (the kit on its reference manifest)", () => {
  const manifest = loadBillingManifest(REFERENCE_MANIFEST)
  const clock = new ManualClock(Date.UTC(2026, 10, 20, 12, 0, 0))
  for (const c of billingUsageConformanceCases({ manifest, stores: () => ({ storage: new InMemoryStorage(clock) }) })) it(c.name, c.run)
})
