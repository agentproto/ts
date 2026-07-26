import { describe, it, expect, vi } from "vitest"
import type { DiscoverCtx } from "@agentproto/provider-kit"
import { deriveDeclaredCapabilities } from "@agentproto/provider-kit"
import { mastracode, mastracodeCapabilities } from "../index.js"

function makeCtx(overrides?: Partial<DiscoverCtx>): DiscoverCtx {
  return {
    homeDir: "/home/test",
    env: {},
    readFile: async () => null,
    warn: vi.fn(),
    ...overrides,
  }
}

describe("mastracodeCapabilities", () => {
  it("keeps the manifest-derived models and authStores", async () => {
    const caps = await mastracodeCapabilities(mastracode, makeCtx())
    const declared = deriveDeclaredCapabilities(mastracode)
    expect(caps.models).toEqual(declared.models)
    expect(caps.authStores).toEqual(declared.authStores)
  })

  it("overrides application to the print arm's actual argv-based application contract", async () => {
    const caps = await mastracodeCapabilities(mastracode, makeCtx())
    expect(caps.application).toEqual({ modelApply: "arg", postureApply: "arg", coupled: false })
  })

  it("declares every provider as api-key only (no subscription bearer path)", async () => {
    const caps = await mastracodeCapabilities(mastracode, makeCtx())
    expect(caps.providers.map((p) => p.id).sort()).toEqual(["anthropic", "google", "openai", "openrouter"])
    // No oauth-bearer / authSubscription surface is declared anywhere.
    expect(caps.providers.every((p) => p.cred.source.kind === "env")).toBe(true)
  })

  it("tags the wire protocol each provider speaks", async () => {
    const caps = await mastracodeCapabilities(mastracode, makeCtx())
    const byId = Object.fromEntries(caps.providers.map((p) => [p.id, p]))
    expect(byId.anthropic?.apiMode).toBe("anthropic")
    expect(byId.openai?.apiMode).toBe("chat_completions")
    expect(byId.openrouter?.apiMode).toBe("chat_completions")
    // Google uses the Gemini SDK, not an OpenAI-compatible wire protocol.
    expect(byId.google?.apiMode).toBeUndefined()
  })

  it("reports env presence without leaking the credential value", async () => {
    const caps = await mastracodeCapabilities(
      mastracode,
      makeCtx({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-deadbeef" } }),
    )
    const anthropic = caps.providers.find((p) => p.id === "anthropic")
    expect(anthropic?.cred.present).toBe(true)
    const serialized = JSON.stringify(caps)
    expect(serialized).not.toContain("deadbeef")
    expect(serialized).not.toContain("sk-ant-api03")
  })

  it("reports env absence when the var is not set", async () => {
    const caps = await mastracodeCapabilities(mastracode, makeCtx())
    expect(caps.providers.every((p) => p.cred.present === false)).toBe(true)
  })
})
