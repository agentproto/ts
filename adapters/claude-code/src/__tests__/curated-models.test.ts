import { describe, expect, it } from "vitest"
import type { AgentCliModelEntry } from "@agentproto/driver-agent-cli"
import { claudeCode } from "../index.js"

describe("claude-code curated models", () => {
  const allowed = claudeCode.models?.allowed ?? []
  const entries = allowed.filter(
    (m): m is AgentCliModelEntry => typeof m !== "string",
  )
  const byId = (id: string) => entries.find((e) => e.id === id)

  it("curates Kimi K3 through direct Moonshot and the local endpoint", () => {
    expect(byId("kimi-k3")).toEqual({
      id: "kimi-k3",
      provider: "moonshot",
    })
    expect(byId("moonshot/kimi-k3@llm-endpoint")).toEqual({
      id: "moonshot/kimi-k3@llm-endpoint",
      provider: "llm-endpoint",
    })
  })

  it("curates the OpenAI gpt-5.6 series under the `@openrouter` route", () => {
    // The two gpt-5.6 base products the deliverable curates, in the same
    // `vendor/product@openrouter` + `provider: "openrouter"` shape as the other
    // cross-vendor OpenRouter rows (z-ai/glm-5.2@openrouter, …). Routing is
    // resolved separately; the runtime injects ANTHROPIC_BASE_URL +
    // ANTHROPIC_AUTH_TOKEN for these Anthropic-native gateway spawns.
    expect(byId("openai/gpt-5.6-luna@openrouter")).toEqual({
      id: "openai/gpt-5.6-luna@openrouter",
      provider: "openrouter",
    })
    expect(byId("openai/gpt-5.6-sol@openrouter")).toEqual({
      id: "openai/gpt-5.6-sol@openrouter",
      provider: "openrouter",
    })
  })

  it("does NOT change the default model", () => {
    expect(claudeCode.models?.default).toBe("claude-sonnet-5")
  })
})
