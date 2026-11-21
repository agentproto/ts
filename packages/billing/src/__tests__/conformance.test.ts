import { describe, it } from "vitest"
import { billingConformanceCases, FakeSettlementProvider, InMemoryBillingState, InMemoryStorage, ManualClock } from "../testing/index.js"

// The BILL-* cases against the in-memory stores and the fake provider.
const clock = new ManualClock(0)
const provider = new FakeSettlementProvider(`whsec-${globalThis.crypto.randomUUID()}`, "fake")

describe("BILL conformance (in-memory stores, fake provider)", () => {
  const cases = billingConformanceCases({
    clock,
    provider,
    stores: () => ({ storage: new InMemoryStorage(clock), state: new InMemoryBillingState() }),
  })
  for (const c of cases) it(c.name, c.run)
})
