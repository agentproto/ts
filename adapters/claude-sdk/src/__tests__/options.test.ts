import { describe, expect, it } from "vitest"
import {
  buildQueryOptions,
  DEFAULT_MODEL,
  UnroutedGatewayModelError,
  type ClaudeSdkConfig,
} from "../options.js"

/** Build options with a controlled base env so assertions on injected
 *  vars don't inherit anything from the test process's `process.env`. */
function build(
  config: ClaudeSdkConfig,
  env: Record<string, string | undefined> = {},
): ReturnType<typeof buildQueryOptions> {
  return buildQueryOptions({
    config,
    abortController: new AbortController(),
    env,
  })
}

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/anthropic"

/** The five internal model tiers the harness may request; a single-model
 *  gateway can only serve one, so gateway mode pins them all. */
const TIER_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
]

describe("buildQueryOptions — auth_token", () => {
  it("injects ANTHROPIC_AUTH_TOKEN from auth_token", () => {
    const opts = build({ authToken: "sk-moonshot-secret" })
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-moonshot-secret")
  })

  it("leaves ANTHROPIC_AUTH_TOKEN unset when auth_token is absent", () => {
    expect(build({}).env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })
})

describe("buildQueryOptions — gateway model-tier pinning", () => {
  it("pins every tier to the resolved model when base_url is set", () => {
    const opts = build({
      model: "kimi-k2.7-code",
      baseUrl: "https://api.moonshot.ai/anthropic",
    })
    expect(opts.env?.ANTHROPIC_BASE_URL).toBe("https://api.moonshot.ai/anthropic")
    for (const v of TIER_VARS) expect(opts.env?.[v]).toBe("kimi-k2.7-code")
  })

  it("pins tiers to DEFAULT_MODEL when base_url is set but model is omitted", () => {
    const opts = build({ baseUrl: "https://openrouter.ai/api/v1" })
    for (const v of TIER_VARS) expect(opts.env?.[v]).toBe(DEFAULT_MODEL)
  })

  it("leaves tier routing untouched in native mode (no base_url)", () => {
    const opts = build({ model: "claude-opus-4-8" })
    expect(opts.env?.ANTHROPIC_BASE_URL).toBeUndefined()
    for (const v of TIER_VARS) expect(opts.env?.[v]).toBeUndefined()
    // Native mode still pins the primary SDK model, just not the env tiers.
    expect(opts.model).toBe("claude-opus-4-8")
  })
})

describe("buildQueryOptions — gateway auth hygiene", () => {
  it("SCRUBS the ambient Anthropic key under a gateway base_url (no leak)", () => {
    const opts = build(
      { baseUrl: MOONSHOT_BASE_URL },
      { ANTHROPIC_API_KEY: "sk-ant-REAL" },
    )
    expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("resolves the bearer from auth_token when base_url is set", () => {
    const opts = build(
      { baseUrl: MOONSHOT_BASE_URL, authToken: "sk-explicit" },
      { ANTHROPIC_API_KEY: "sk-ant-REAL" },
    )
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-explicit")
    expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("resolves the bearer from ANTHROPIC_AUTH_TOKEN env when base_url is set", () => {
    const opts = build(
      { baseUrl: MOONSHOT_BASE_URL },
      { ANTHROPIC_AUTH_TOKEN: "sk-env-bearer", ANTHROPIC_API_KEY: "sk-ant-REAL" },
    )
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-env-bearer")
    expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("prefers an explicit auth_token over ANTHROPIC_AUTH_TOKEN env", () => {
    const opts = build(
      { baseUrl: MOONSHOT_BASE_URL, authToken: "sk-explicit" },
      { ANTHROPIC_AUTH_TOKEN: "sk-env-bearer" },
    )
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-explicit")
  })

  it("presents NO credential when a gateway has none — fail clean, never leak", () => {
    const opts = build(
      { baseUrl: MOONSHOT_BASE_URL },
      { ANTHROPIC_API_KEY: "sk-ant-REAL" },
    )
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("SCRUBS leaked Claude-Code cloud-provider redirect toggles under a gateway base_url", () => {
    const opts = build(
      { baseUrl: MOONSHOT_BASE_URL },
      {
        ANTHROPIC_API_KEY: "sk-ant-REAL",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_FOUNDRY: "1",
        CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
        CLAUDE_CODE_USE_MANTLE: "1",
        CLAUDE_CODE_USE_GATEWAY: "1",
      },
    )
    expect(opts.env?.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(opts.env?.CLAUDE_CODE_USE_VERTEX).toBeUndefined()
    expect(opts.env?.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined()
    expect(opts.env?.CLAUDE_CODE_USE_ANTHROPIC_AWS).toBeUndefined()
    expect(opts.env?.CLAUDE_CODE_USE_MANTLE).toBeUndefined()
    expect(opts.env?.CLAUDE_CODE_USE_GATEWAY).toBeUndefined()
  })

  it("leaves Claude-Code cloud-provider redirect toggles intact in native mode", () => {
    const opts = build(
      {},
      {
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
      },
    )
    expect(opts.env?.CLAUDE_CODE_USE_BEDROCK).toBe("1")
    expect(opts.env?.CLAUDE_CODE_USE_VERTEX).toBe("1")
  })
})

describe("buildQueryOptions — unrouted-model guard", () => {
  it("fails fast on a vendor/product model with no base_url (the dogfooding bug)", () => {
    expect(() => build({ model: "deepseek/deepseek-v4-flash-0731" })).toThrow(
      UnroutedGatewayModelError,
    )
    expect(() => build({ model: "deepseek/deepseek-v4-flash-0731" })).toThrow(
      /vendor\/product catalog ref/,
    )
  })

  it("names the offending model in the error message", () => {
    try {
      build({ model: "z-ai/glm-5.2" })
      expect.unreachable("expected buildQueryOptions to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(UnroutedGatewayModelError)
      expect((err as Error).message).toContain("z-ai/glm-5.2")
    }
  })

  it("does NOT throw once base_url routes the vendor/product model to its gateway", () => {
    expect(() =>
      build({
        model: "deepseek/deepseek-v4-flash-0731",
        baseUrl: "https://openrouter.ai/api",
      }),
    ).not.toThrow()
  })

  it("does NOT throw for a native claude-* model with no base_url", () => {
    expect(() => build({ model: "claude-opus-4-8" })).not.toThrow()
    expect(() => build({})).not.toThrow() // DEFAULT_MODEL is native
  })

  it("does NOT throw for a bare gateway-native id (no '/') with no base_url", () => {
    // Ambiguous with a yet-unlisted native id — deliberately out of scope for
    // this guard (see isVendorProductModelRef's doc). A real spawn always
    // pairs this shape with a base_url via route.gateway; this only documents
    // the guard's precise boundary.
    expect(() => build({ model: "kimi-k2.7-code" })).not.toThrow()
  })

  it("does NOT throw when a cloud-provider redirect toggle is already active", () => {
    expect(() =>
      build(
        { model: "deepseek/deepseek-v4-flash-0731" },
        { CLAUDE_CODE_USE_BEDROCK: "1" },
      ),
    ).not.toThrow()
  })
})

describe("buildQueryOptions — thinking", () => {
  it("enables extended thinking as { type: 'enabled' } when set", () => {
    expect(build({ thinking: true }).thinking).toEqual({ type: "enabled" })
  })

  it("leaves options.thinking unset by default", () => {
    expect(build({}).thinking).toBeUndefined()
  })
})

describe("buildQueryOptions — partial-message streaming", () => {
  it("always enables includePartialMessages so long turns stream (ring liveness + watchdog resets)", () => {
    // Unconditional: a long thinking / generation stretch must yield SDK
    // messages continuously, both to keep the daemon output ring advancing and
    // so the idle watchdog isn't tripped by a silent >90s thinking block.
    expect(build({}).includePartialMessages).toBe(true)
    expect(build({ thinking: true, baseUrl: "https://api.moonshot.ai/anthropic" }).includePartialMessages).toBe(true)
  })
})
