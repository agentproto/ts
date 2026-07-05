import { describe, expect, it } from "vitest"
import { claudeSdk } from "../index.js"
import { buildQueryOptions, type ClaudeSdkConfig } from "../options.js"

const MOONSHOT = "https://api.moonshot.ai/anthropic"

/** Resolve the spawn env buildQueryOptions would set, for a given config +
 *  injected ambient env (so tests never touch process.env). */
function spawnEnv(
  config: ClaudeSdkConfig,
  env: Record<string, string | undefined>,
) {
  const built = buildQueryOptions({
    config,
    abortController: new AbortController(),
    env,
  })
  return built.env ?? {}
}

/** The manifest is validated against the AIP-45 zod schema at definition time
 *  (defineAgentCli), so a bad mode shape would throw on import — these tests
 *  lock the wiring each gateway preset ships. */
describe("claude-sdk gateway modes", () => {
  const modeById = (id: string) =>
    (claudeSdk.modes ?? []).find((m) => m.id === id)

  it("exposes default, moonshot, and openrouter modes", () => {
    expect((claudeSdk.modes ?? []).map((m) => m.id)).toEqual(
      expect.arrayContaining(["default", "moonshot", "openrouter"]),
    )
  })

  it("moonshot pre-wires the endpoint, default model, and --thinking", () => {
    const m = modeById("moonshot")
    expect(m?.env?.ANTHROPIC_BASE_URL).toBe("https://api.moonshot.ai/anthropic")
    // cli.ts falls back to CLAUDE_SDK_MODEL when no --model is passed.
    expect(m?.env?.CLAUDE_SDK_MODEL).toBe("kimi-k2.7-code")
    // Kimi rejects a request without extended thinking.
    expect(m?.bin_args_append).toContain("--thinking")
    // Declares its conventional credential source.
    expect(m?.env?.CLAUDE_SDK_GATEWAY_KEY_ENV).toBe("MOONSHOT_API_KEY")
  })

  it("openrouter pre-wires only the endpoint (model is caller-picked)", () => {
    const m = modeById("openrouter")
    expect(m?.env?.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api/v1")
    expect(m?.env?.CLAUDE_SDK_MODEL).toBeUndefined()
    expect(m?.bin_args_append ?? []).not.toContain("--thinking")
    expect(m?.env?.CLAUDE_SDK_GATEWAY_KEY_ENV).toBe("OPENROUTER_API_KEY")
  })

  it("default mode is native Anthropic — no gateway env", () => {
    expect(modeById("default")?.env).toBeUndefined()
  })

  it("advertises the gateway models alongside native Claude in allowed", () => {
    const allowed = claudeSdk.models?.allowed ?? []
    expect(allowed).toContain("claude-opus-4-8") // native still there
    expect(allowed).toContain("kimi-k2.7-code") // moonshot
    expect(allowed).toContain("z-ai/glm-5.2") // openrouter
  })
})

describe("claude-sdk gateway auth resolution", () => {
  it("SCRUBS the ambient Anthropic key under a gateway base_url (no leak)", () => {
    const env = spawnEnv(
      { baseUrl: MOONSHOT },
      { ANTHROPIC_API_KEY: "sk-ant-REAL" },
    )
    // The real Anthropic key must never be sent to Moonshot.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("resolves the bearer from the mode's conventional key env", () => {
    const env = spawnEnv(
      { baseUrl: MOONSHOT },
      {
        CLAUDE_SDK_GATEWAY_KEY_ENV: "MOONSHOT_API_KEY",
        MOONSHOT_API_KEY: "sk-moon",
        ANTHROPIC_API_KEY: "sk-ant-REAL",
      },
    )
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-moon")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("prefers an explicit auth_token over the conventional key", () => {
    const env = spawnEnv(
      { baseUrl: MOONSHOT, authToken: "sk-explicit" },
      { CLAUDE_SDK_GATEWAY_KEY_ENV: "MOONSHOT_API_KEY", MOONSHOT_API_KEY: "sk-moon" },
    )
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-explicit")
  })

  it("presents NO credential when a gateway has none — fail clean, never leak", () => {
    const env = spawnEnv({ baseUrl: MOONSHOT }, { ANTHROPIC_API_KEY: "sk-ant-REAL" })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("leaves native Anthropic (API key OR subscription) untouched", () => {
    const env = spawnEnv({}, { ANTHROPIC_API_KEY: "sk-ant-REAL" })
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-REAL")
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it("honours an explicit bearer (e.g. subscription token) in native mode", () => {
    const env = spawnEnv({ authToken: "sub-token" }, {})
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sub-token")
  })
})
