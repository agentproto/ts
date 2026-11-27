import { describe, expect, it } from "vitest"
import { createNaiveProvider } from "./naive.js"
import { RULES } from "./rules.js"

// Each rule must fail against the naive translation, or say why it passes (the guard is in the core).
describe("Stripe rules (naive translation)", () => {
  for (const r of RULES) {
    it(r.naivePasses ? `${r.id} passes on the naive translation too: ${r.naivePasses}` : `${r.id} fails on the naive translation`, async () => {
      let failure: Error | null = null
      try {
        await r.run(createNaiveProvider)
      } catch (e) {
        failure = e as Error
      }
      if (r.naivePasses) {
        expect(failure, `${r.id} is said to pass on the naive translation`).toBeNull()
        return
      }
      expect(failure, `${r.id} passed on the naive translation`).not.toBeNull()
      if (process.env.PRINT_NAIVE_FAILURES) console.log(`NAIVE ${r.id}: ${failure!.message.split("\n")[0]}`)
    })
  }
})
