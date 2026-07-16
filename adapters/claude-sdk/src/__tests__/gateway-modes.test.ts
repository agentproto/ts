import { describe, expect, it } from "vitest"
import type { AgentCliModelEntry } from "@agentproto/driver-agent-cli"
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

  it("advertises the gateway models alongside native Claude in allowed, each bound to its mode", () => {
    const allowed = claudeSdk.models?.allowed ?? []
    const ids = allowed.map((m) => (typeof m === "string" ? m : m.id))
    expect(ids).toContain("claude-opus-4-8") // native still there
    expect(ids).toContain("kimi-k2.7-code") // moonshot
    expect(ids).toContain("z-ai/glm-5.2") // openrouter

    const entries = allowed.filter((m): m is AgentCliModelEntry => typeof m !== "string")
    const byId = (id: string) => entries.find((e) => e.id === id)

    // THE bug this PR fixes: a gateway model with no mode binding spawns in
    // this adapter's default mode (native Anthropic), sending its id to the
    // wrong provider. Every gateway entry must carry the mode that pre-wires
    // ANTHROPIC_BASE_URL to reach it; a native entry needs no mode switch.
    expect(byId("kimi-k2.7-code")).toEqual({ id: "kimi-k2.7-code", provider: "moonshot", mode: "moonshot" })
    expect(byId("z-ai/glm-5.2")).toEqual({ id: "z-ai/glm-5.2", provider: "openrouter", mode: "openrouter" })
    expect(byId("claude-opus-4-8")).toEqual({ id: "claude-opus-4-8", provider: "anthropic" })
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

  it("SCRUBS leaked Claude-Code cloud-provider redirect toggles under a gateway base_url", () => {
    const env = spawnEnv(
      { baseUrl: MOONSHOT },
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
    // Any of these would make the SDK redirect the turn to a cloud provider
    // instead of the gateway base_url, wedging it forever.
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_ANTHROPIC_AWS).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_MANTLE).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_GATEWAY).toBeUndefined()
  })

  it("leaves Claude-Code cloud-provider redirect toggles intact in native mode", () => {
    const env = spawnEnv(
      {},
      {
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
      },
    )
    // A user legitimately running native Bedrock/Vertex must keep these.
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1")
    expect(env.CLAUDE_CODE_USE_VERTEX).toBe("1")
  })
})
