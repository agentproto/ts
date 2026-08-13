import { describe, it, expect, vi } from "vitest"
import type { DiscoverCtx } from "@agentproto/provider-kit"
import { deriveDeclaredCapabilities } from "@agentproto/provider-kit"
import { mastracodeInprocess, mastracodeInprocessCapabilities } from "../index.js"

function makeCtx(): DiscoverCtx {
  return {
    homeDir: "/home/test",
    env: {},
    readFile: async () => null,
    warn: vi.fn(),
  }
}

describe("mastracodeInprocessCapabilities", () => {
  it("reports the strategy as discovered, but declared (no live/parse probing)", async () => {
    const caps = await mastracodeInprocessCapabilities(mastracodeInprocess, makeCtx())
    expect(caps.source).toBe("discovered")
    expect(caps.discoverable).toBe("declared")
  })

  it("keeps the manifest-derived env-slot providers/models/authStores", async () => {
    const caps = await mastracodeInprocessCapabilities(mastracodeInprocess, makeCtx())
    const declared = deriveDeclaredCapabilities(mastracodeInprocess)
    expect(caps.providers).toEqual(declared.providers)
    expect(caps.models).toEqual(declared.models)
    expect(caps.authStores).toEqual(declared.authStores)
  })

  it("overrides application: config-applied model, env-applied posture, coupled (in-process)", async () => {
    const caps = await mastracodeInprocessCapabilities(mastracodeInprocess, makeCtx())
    expect(caps.application).toEqual({ modelApply: "config", postureApply: "env", coupled: true })
  })
})
