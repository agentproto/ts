import { describe, it, expect, vi } from "vitest"
import type { DiscoverCtx } from "@agentproto/provider-kit"
import { hermes, hermesCapabilities } from "../index.js"

function makeCtx(files: Record<string, string>, env: Record<string, string | undefined> = {}): DiscoverCtx {
  return {
    homeDir: "/home/test",
    env,
    readFile: async (path: string) => (path in files ? files[path]! : null),
    warn: vi.fn(),
  }
}

describe("hermesCapabilities", () => {
  it("parses credential_pool into providers, preserving an explicit key_env verbatim", async () => {
    const ctx = makeCtx({
      "/home/test/.hermes/auth.json": JSON.stringify({
        credential_pool: [
          {
            provider: "kimi",
            key_env: "KIMI_API_KEY",
            fingerprint: "abc123def456",
            base_url: "https://api.moonshot.ai/v1",
          },
          { provider: "openrouter", base_url: "https://openrouter.ai/api/v1" },
        ],
      }),
    })
    const caps = await hermesCapabilities(hermes, ctx)
    expect(caps.source).toBe("discovered")
    expect(caps.discoverable).toBe("live")

    const kimi = caps.providers.find((p) => p.id === "kimi")
    expect(kimi).toBeDefined()
    // The load-bearing assertion: hermes' native kimi/moonshot slot is
    // KIMI_API_KEY — this must never be normalized/derived to MOONSHOT_API_KEY.
    expect(kimi?.cred.source).toEqual({ kind: "env", var: "KIMI_API_KEY" })
    expect(kimi?.cred.present).toBe(true)
    expect(kimi?.cred.fingerprint).toBe("abc123def456")
    expect(kimi?.baseUrl).toBe("https://api.moonshot.ai/v1")

    const openrouter = caps.providers.find((p) => p.id === "openrouter")
    // No key_env in the fixture — falls back to the pool file itself as the
    // credential's origin rather than guessing an env var name.
    expect(openrouter?.cred.source).toEqual({
      kind: "file",
      path: "~/.hermes/auth.json",
      pointer: "credential_pool[provider=openrouter]",
    })
  })

  it("declares the hermes auth.json file store", async () => {
    const caps = await hermesCapabilities(hermes, makeCtx({}))
    expect(caps.authStores).toEqual([
      { kind: "file", path: "~/.hermes/auth.json", format: "json", providerKeyed: true },
    ])
  })

  it("reads model ids from provider_models_cache.json when present, and marks stale when absent", async () => {
    const withCache = await hermesCapabilities(
      hermes,
      makeCtx({
        "/home/test/.hermes/provider_models_cache.json": JSON.stringify({
          models: ["z-ai/glm-5.2@openrouter", "deepseek/deepseek-v4-pro@openrouter"],
        }),
      }),
    )
    expect(withCache.models).toEqual({
      mechanism: "file-cache",
      ref: "hermes model --refresh",
      ids: ["z-ai/glm-5.2@openrouter", "deepseek/deepseek-v4-pro@openrouter"],
      stale: false,
    })

    const withoutCache = await hermesCapabilities(hermes, makeCtx({}))
    expect(withoutCache.models).toEqual({
      mechanism: "file-cache",
      ref: "hermes model --refresh",
      stale: true,
    })
  })

  it("never throws on a malformed auth.json — warns and returns empty providers", async () => {
    const warn = vi.fn()
    const ctx = makeCtx({ "/home/test/.hermes/auth.json": "{not json" })
    ctx.warn = warn
    const caps = await hermesCapabilities(hermes, ctx)
    expect(caps.providers).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("never emits a raw credential value", async () => {
    const ctx = makeCtx({
      "/home/test/.hermes/auth.json": JSON.stringify({
        credential_pool: [{ provider: "openrouter", key_env: "OPENROUTER_API_KEY" }],
      }),
    })
    const caps = await hermesCapabilities(hermes, ctx)
    const serialized = JSON.stringify(caps)
    expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]/)
  })
})
