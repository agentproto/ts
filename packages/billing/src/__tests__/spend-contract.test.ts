import { describe, it } from "vitest"
import { spendContractCases } from "../contract/index.js"
import { InMemoryStorage, ManualClock } from "../testing/index.js"
import { loadBillingManifestForTest } from "./cases-kit.js"

// The kit runs its own contract suite against its in-memory storage, the way a host runs it against its own.
const clock = new ManualClock(0)
describe("spend contract tests (exported suite)", () => {
  for (const c of spendContractCases({ stores: () => ({ storage: new InMemoryStorage(clock) }), clock, manifest: loadBillingManifestForTest("demo") })) it(c.name, c.run)
})
