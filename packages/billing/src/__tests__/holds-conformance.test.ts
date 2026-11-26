import { describe, it } from "vitest"
import { createHolds } from "../spend/index.js"
import { holdsConformanceCases, InMemoryStorage, ManualClock } from "../testing/index.js"

describe("holds conformance (the kit's own engine)", () => {
  const clock = new ManualClock(Date.UTC(2026, 10, 20, 12, 0, 0))
  const cases = holdsConformanceCases({
    storage: () => new InMemoryStorage(clock),
    clock,
    engine: storage => createHolds({ storage, clock }, { asset: "credits" }),
    asset: "credits",
  })
  for (const c of cases) it(c.name, c.run)
})
