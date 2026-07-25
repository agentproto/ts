import { describe, it, expect, vi } from "vitest"
import type { DiscoverCtx } from "@agentproto/provider-kit"
import { deriveDeclaredCapabilities } from "@agentproto/provider-kit"
import { mastracode, mastracodeCapabilities } from "../index.js"

function makeCtx(): DiscoverCtx {
  return {
    homeDir: "/home/test",
    env: {},
    readFile: async () => null,
    warn: vi.fn(),
  }
}

describe("mastracodeCapabilities", () => {
  it("keeps the manifest-derived env-slot providers/models/authStores", async () => {
    const caps = await mastracodeCapabilities(mastracode, makeCtx())
    const declared = deriveDeclaredCapabilities(mastracode)
    expect(caps.providers).toEqual(declared.providers)
    expect(caps.models).toEqual(declared.models)
    expect(caps.authStores).toEqual(declared.authStores)
  })

  it("overrides application to the print arm's actual argv-based application contract", async () => {
    const caps = await mastracodeCapabilities(mastracode, makeCtx())
    expect(caps.application).toEqual({ modelApply: "arg", postureApply: "arg", coupled: false })
  })
})
