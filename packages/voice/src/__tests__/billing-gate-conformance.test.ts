import { describe, it } from "vitest"
import type { VoiceBillingGate } from "../billing-gate.js"
import { voiceBillingGateConformanceCases } from "../testing/index.js"

// A fictional host gate: accounts "rich" can pay, "poor" cannot.
const gate = (): VoiceBillingGate<{ id: string }, string> => ({
  onAuthorize: async c => (c === "rich" ? { ok: true, hold: { id: "h" } } : { ok: false, reason: "insufficient_funds" }),
  onCheckpoint: async () => ({ action: "continue" }),
  onSettle: async () => undefined,
})

describe("voice billing gate conformance (a fictional host gate)", () => {
  for (const c of voiceBillingGateConformanceCases({ gate, canPay: "rich", cannotPay: "poor" })) it(c.name, c.run)
})
