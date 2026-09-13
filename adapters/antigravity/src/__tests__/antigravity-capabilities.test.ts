import { describe, it, expect, vi } from "vitest"
import type { DiscoverCtx } from "@agentproto/provider-kit"
import { deriveDeclaredCapabilities } from "@agentproto/provider-kit"
import { antigravity, antigravityCapabilities } from "../index.js"

function makeCtx(overrides?: Partial<DiscoverCtx>): DiscoverCtx {
  return {
    homeDir: "/home/test",
    env: {},
    readFile: async () => null,
    warn: vi.fn(),
    ...overrides,
  }
}

describe("antigravityCapabilities", () => {
  it("reports the strategy as discovered, but declared (no live/parse probing)", async () => {
    const caps = await antigravityCapabilities(antigravity, makeCtx())
    expect(caps.source).toBe("discovered")
    expect(caps.discoverable).toBe("declared")
  })

  it("keeps the manifest-derived models and authStores", async () => {
    const caps = await antigravityCapabilities(antigravity, makeCtx())
    const declared = deriveDeclaredCapabilities(antigravity)
    expect(caps.models).toEqual(declared.models)
    expect(caps.authStores).toEqual(declared.authStores)
  })

  it("overrides application to the print arm's argv-based contract", async () => {
    const caps = await antigravityCapabilities(antigravity, makeCtx())
    expect(caps.application).toEqual({ modelApply: "arg", postureApply: "arg", coupled: false })
  })

  it("declares no api-key providers (auth is a keyring-backed Google login)", async () => {
    const caps = await antigravityCapabilities(antigravity, makeCtx())
    expect(caps.providers).toEqual([])
  })
})
