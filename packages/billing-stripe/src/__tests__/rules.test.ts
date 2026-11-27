import { describe, it } from "vitest"
import { createStripeProvider } from "../provider.js"
import { RULES } from "./rules.js"

describe("Stripe rules (this adapter)", () => {
  for (const r of RULES) it(`${r.id} ${r.title}`, () => r.run(createStripeProvider))
})
