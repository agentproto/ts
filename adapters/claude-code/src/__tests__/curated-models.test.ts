import { describe, expect, it } from "vitest"
import type { AgentCliModelEntry } from "@agentproto/driver-agent-cli"
import { listOpencodeAnthropicModelRefs } from "@agentproto/model-catalog/llm"
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

  it("curates ONLY the Anthropic-surface OpenCode ids, derived from the catalog", () => {
    const ids = (provider: string) =>
      entries.filter((e) => e.provider === provider).map((e) => e.id)

    // Both OpenCode endpoints serve three wire surfaces behind one base URL
    // and only the `/v1/messages` subset is reachable from the claude binary,
    // so the menu is derived from the catalog's generated per-model surface
    // discriminator rather than hand-typed — an id the endpoint can't answer
    // can never appear here.
    expect(ids("opencode-go").sort()).toEqual(
      listOpencodeAnthropicModelRefs("opencode-go"),
    )
    expect(ids("opencode").sort()).toEqual(listOpencodeAnthropicModelRefs("opencode"))

    // Zen's subset is the whole Claude family (the valuable path: this harness
    // on real Claude models against a Zen balance); Go's is a small
    // Anthropic-surface set.
    expect(ids("opencode")).toContain("opencode/claude-sonnet-4-6")
    // Membership, not an exact list: the roster is catalog-synced, and the
    // derived-menu equality above already pins the exact shape. union-alpha
    // joined Go's Anthropic surface after #1309 verified the original four —
    // an exact literal here reddens every sync that gains a model (cf. #1328,
    // #1331).
    for (const id of [
      "opencode-go/minimax-m2.5",
      "opencode-go/minimax-m2.7",
      "opencode-go/minimax-m3",
      "opencode-go/qwen3.8-flash",
    ]) {
      expect(ids("opencode-go")).toContain(id)
    }
    // The OpenAI-flavored majority of Go stays out — it 404s on /v1/messages.
    expect(ids("opencode-go")).not.toContain("opencode-go/glm-5.3")

    // No `@route` suffix: for these endpoints the route IS the leading segment.
    expect(byId("opencode/claude-sonnet-4-6")).toEqual({
      id: "opencode/claude-sonnet-4-6",
      provider: "opencode",
    })
  })

  it("does NOT change the default model", () => {
    expect(claudeCode.models?.default).toBe("claude-sonnet-5")
  })
})
