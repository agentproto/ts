import { describe, expect, it } from "vitest"
import { buildQuotaStatus as fromModelIntel } from "@agentproto/model-intel"
import { buildQuotaStatus as fromQuota } from "@agentproto/quota"

describe("model-intel quota re-exports", () => {
  it("re-exports the same buildQuotaStatus function as @agentproto/quota", () => {
    expect(fromModelIntel).toBe(fromQuota)
  })
})
