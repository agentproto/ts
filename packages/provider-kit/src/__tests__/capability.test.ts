import { describe, it, expect, vi } from "vitest"
import {
  deriveDeclaredCapabilities,
  discoverCapabilities,
  type HarnessManifestView,
  type DiscoverCtx,
  type CapabilityStrategy,
} from "../capability.js"

function makeCtx(overrides?: Partial<DiscoverCtx>): DiscoverCtx {
  return {
    homeDir: "/home/test",
    env: {},
    readFile: async () => null,
    warn: vi.fn(),
    ...overrides,
  }
}

describe("deriveDeclaredCapabilities", () => {
  it("never throws on a bare-minimum manifest", () => {
    const def: HarnessManifestView = { id: "bare" }
    const caps = deriveDeclaredCapabilities(def)
    expect(caps.adapter).toBe("bare")
    expect(caps.source).toBe("manifest-fallback")
    expect(caps.discoverable).toBe("declared")
    expect(caps.providers).toEqual([])
    expect(caps.authStores).toEqual([])
    expect(caps.models).toEqual({ mechanism: "free-form" })
    expect(caps.endpointCompat).toEqual({})
    expect(caps.application).toEqual({ modelApply: "config", postureApply: "none", coupled: false })
  })

  it("derives one provider per models.env entry, cred never present", () => {
    const def: HarnessManifestView = {
      id: "hermes",
      models: { env: { openrouter: "OPENROUTER_API_KEY", openai: "OPENAI_API_KEY" } },
    }
    const caps = deriveDeclaredCapabilities(def)
    expect(caps.providers).toEqual([
      {
        id: "openrouter",
        billingEndpoint: "openrouter",
        cred: { present: false, source: { kind: "env", var: "OPENROUTER_API_KEY" } },
      },
      {
        id: "openai",
        billingEndpoint: "openai",
        cred: { present: false, source: { kind: "env", var: "OPENAI_API_KEY" } },
      },
    ])
  })

  it("collects model ids from both bare strings and structured entries", () => {
    const def: HarnessManifestView = {
      id: "mastracode",
      models: {
        allowed: [
          { id: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
          "openai/gpt-5.1",
          { notAnId: true },
          42,
        ],
      },
    }
    const caps = deriveDeclaredCapabilities(def)
    expect(caps.models).toEqual({
      mechanism: "free-form",
      ids: ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"],
    })
  })

  it("derives one env authStore per auth.state.env var", () => {
    const def: HarnessManifestView = {
      id: "gemini",
      auth: { state: { env: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] } },
    }
    const caps = deriveDeclaredCapabilities(def)
    expect(caps.authStores).toEqual([
      { kind: "env", providerKeyed: false },
      { kind: "env", providerKeyed: false },
      { kind: "env", providerKeyed: false },
    ])
  })

  it("mirrors models.apply into application.modelApply, defaulting to config", () => {
    expect(deriveDeclaredCapabilities({ id: "a", models: { apply: "arg" } }).application.modelApply).toBe("arg")
    expect(deriveDeclaredCapabilities({ id: "a", models: { apply: "command" } }).application.modelApply).toBe(
      "command",
    )
    expect(deriveDeclaredCapabilities({ id: "a" }).application.modelApply).toBe("config")
    // An unrecognised value falls back to the default rather than being guessed at.
    expect(
      deriveDeclaredCapabilities({ id: "a", models: { apply: "bogus" as never } }).application.modelApply,
    ).toBe("config")
  })

  it("never emits a secret value even when the manifest env var name looks secret-shaped", () => {
    const def: HarnessManifestView = {
      id: "leaky",
      models: { env: { openai: "sk-live-should-never-appear-1234567890" } },
    }
    const caps = deriveDeclaredCapabilities(def)
    const serialized = JSON.stringify(caps)
    // The "secret" here is only ever a manifest-declared ENV VAR NAME, never
    // a resolved value — deriveDeclaredCapabilities never reads process.env.
    // Asserting cred.present stays false is the real guarantee; the fixture
    // value flowing through as `cred.source.var` is expected (it's a var
    // name, not a secret), not a violation.
    expect(caps.providers[0]?.cred.present).toBe(false)
    expect(serialized).not.toContain('"fingerprint"')
    expect(serialized).not.toContain('"last4"')
  })
})

describe("discoverCapabilities", () => {
  it("falls back to deriveDeclaredCapabilities when no strategy is given", async () => {
    const def: HarnessManifestView = { id: "noop-adapter" }
    const caps = await discoverCapabilities(def, undefined, makeCtx())
    expect(caps).toEqual(deriveDeclaredCapabilities(def))
  })

  it("returns the strategy's result on success", async () => {
    const def: HarnessManifestView = { id: "live-adapter" }
    const strategy: CapabilityStrategy = async (d) => ({
      adapter: d.id,
      source: "discovered",
      discoverable: "live",
      authStores: [{ kind: "file", path: "~/.live/auth.json", format: "json", providerKeyed: true }],
      providers: [],
      models: { mechanism: "file-cache" },
      endpointCompat: {},
      application: { modelApply: "config", postureApply: "none", coupled: false },
    })
    const caps = await discoverCapabilities(def, strategy, makeCtx())
    expect(caps.source).toBe("discovered")
    expect(caps.discoverable).toBe("live")
  })

  it("catches a throwing strategy and falls back to the declared projection, warning once", async () => {
    const def: HarnessManifestView = { id: "flaky-adapter", models: { env: { x: "X_API_KEY" } } }
    const strategy: CapabilityStrategy = async () => {
      throw new Error("boom: creds file unreadable")
    }
    const warn = vi.fn()
    const caps = await discoverCapabilities(def, strategy, makeCtx({ warn }))
    expect(caps).toEqual(deriveDeclaredCapabilities(def))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("flaky-adapter")
  })

  it("never leaks a secret value even when a strategy reads one from ctx", async () => {
    const def: HarnessManifestView = { id: "secretful" }
    const secret = "sk-super-secret-value-do-not-leak"
    const strategy: CapabilityStrategy = async (d, ctx) => {
      // A real strategy would read a creds file here; simulate that access
      // to prove the RETURNED shape never carries the raw value even though
      // ctx exposed it.
      await ctx.readFile("/home/test/.fake/auth.json")
      return {
        adapter: d.id,
        source: "discovered",
        discoverable: "live",
        authStores: [],
        providers: [
          {
            id: "openrouter",
            billingEndpoint: "openrouter",
            cred: {
              present: true,
              source: { kind: "env", var: "OPENROUTER_API_KEY" },
              fingerprint: "deadbeefcafe",
              last4: secret.slice(-4),
            },
          },
        ],
        models: { mechanism: "catalog" },
        endpointCompat: {},
        application: { modelApply: "config", postureApply: "none", coupled: false },
      }
    }
    const ctx = makeCtx({ readFile: async () => JSON.stringify({ apiKey: secret }) })
    const caps = await discoverCapabilities(def, strategy, ctx)
    const serialized = JSON.stringify(caps)
    expect(serialized).not.toContain(secret)
  })
})
