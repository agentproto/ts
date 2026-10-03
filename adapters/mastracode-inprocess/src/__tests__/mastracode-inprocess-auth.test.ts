import { describe, it, expect } from "vitest"
import { mastracodeInprocess } from "../index.js"

describe("mastracode-inprocess auth declaration", () => {
  it("declares the anthropic- and openai-scoped external subscriptions (same logins as the print-arm mastracode adapter)", () => {
    expect(mastracodeInprocess.authSubscription).toEqual([
      { external: true, provider: "anthropic" },
      { external: true, provider: "openai" },
    ])
  })
})
