import { describe, expect, it } from "vitest"
import { claudeSdk } from "../index.js"

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
  })

  it("openrouter pre-wires only the endpoint (model is caller-picked)", () => {
    const m = modeById("openrouter")
    expect(m?.env?.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api/v1")
    expect(m?.env?.CLAUDE_SDK_MODEL).toBeUndefined()
    expect(m?.bin_args_append ?? []).not.toContain("--thinking")
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
