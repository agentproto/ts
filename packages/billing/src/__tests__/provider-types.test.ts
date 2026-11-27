import { describe, expect, it } from "vitest"
import type { SettlementProvider } from "../settlement.js"

describe("SettlementProvider type", () => {
  it("requires capabilities: a provider without them does not compile", () => {
    // @ts-expect-error `capabilities` is required on a SettlementProvider
    const p: SettlementProvider = {
      id: "bare",
      name: "Bare",
      env: { secretKey: "BARE_SECRET_KEY", webhookSecret: "BARE_WEBHOOK_SECRET", mode: "BARE_MODE" },
      verifyWebhook: async () => null,
      charge: async () => ({ ok: false, error: "unsupported" }),
      pay: async () => ({ ok: false, error: "unsupported" }),
    }
    expect(p.id).toBe("bare")
  })
})
