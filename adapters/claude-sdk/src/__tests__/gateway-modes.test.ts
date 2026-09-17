import { describe, expect, it } from "vitest"
import type { AgentCliModelEntry } from "@agentproto/driver-agent-cli"
import { listOpencodeAnthropicModelRefs } from "@agentproto/model-catalog/llm"
import { claudeSdk } from "../index.js"

describe("claude-sdk modes", () => {
  it("only exposes the native default mode", () => {
    expect((claudeSdk.modes ?? []).map((m) => m.id)).toEqual(["default"])
  })

  it("default mode is native Anthropic — no gateway env", () => {
    const m = (claudeSdk.modes ?? []).find((x) => x.id === "default")
    expect(m?.env).toBeUndefined()
    expect(m?.bin_args_append).toBeUndefined()
  })
})

describe("claude-sdk model routing", () => {
  it("advertises native Claude and gateway providers without adapter mode bindings", () => {
    const allowed = claudeSdk.models?.allowed ?? []
    const ids = allowed.map((m) => (typeof m === "string" ? m : m.id))
    expect(ids).toContain("claude-opus-4-8")
    expect(ids).toContain("kimi-k3")
    expect(ids).toContain("kimi-k2.7-code")
    expect(ids).toContain("z-ai/glm-5.2@openrouter")
    expect(ids).toContain("x-ai/grok-4.5@openrouter")

    const entries = allowed.filter((m): m is AgentCliModelEntry => typeof m !== "string")
    const byId = (id: string) => entries.find((e) => e.id === id)

    // Slice 4 removed hard-coded gateway modes. Gateway models now declare
    // their provider/biller only; the runtime resolver injects the correct
    // ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN.
    expect(byId("kimi-k3")).toEqual({ id: "kimi-k3", provider: "moonshot" })
    expect(byId("kimi-k2.7-code")).toEqual({ id: "kimi-k2.7-code", provider: "moonshot" })
    expect(byId("z-ai/glm-5.2@openrouter")).toEqual({ id: "z-ai/glm-5.2@openrouter", provider: "openrouter" })
    expect(byId("x-ai/grok-4.5@openrouter")).toEqual({ id: "x-ai/grok-4.5@openrouter", provider: "openrouter" })
    expect(byId("claude-opus-4-8")).toEqual({ id: "claude-opus-4-8", provider: "anthropic" })
  })

  it("curates the local llm-endpoint proxy models under the `@llm-endpoint` route (PR-5)", () => {
    const allowed = claudeSdk.models?.allowed ?? []
    const entries = allowed.filter((m): m is AgentCliModelEntry => typeof m !== "string")
    const byId = (id: string) => entries.find((e) => e.id === id)
    expect(byId("moonshot/kimi-k3@llm-endpoint")).toEqual({
      id: "moonshot/kimi-k3@llm-endpoint",
      provider: "llm-endpoint",
    })
    expect(byId("moonshot/kimi-k2.7-code@llm-endpoint")).toEqual({
      id: "moonshot/kimi-k2.7-code@llm-endpoint",
      provider: "llm-endpoint",
    })
    expect(byId("openai/gpt-4o-mini@llm-endpoint")).toEqual({
      id: "openai/gpt-4o-mini@llm-endpoint",
      provider: "llm-endpoint",
    })
  })

  it("curates the OpenAI gpt-5.6 series under the `@openrouter` route", () => {
    const allowed = claudeSdk.models?.allowed ?? []
    const entries = allowed.filter((m): m is AgentCliModelEntry => typeof m !== "string")
    const byId = (id: string) => entries.find((e) => e.id === id)
    expect(byId("openai/gpt-5.6-luna@openrouter")).toEqual({
      id: "openai/gpt-5.6-luna@openrouter",
      provider: "openrouter",
    })
    expect(byId("openai/gpt-5.6-sol@openrouter")).toEqual({
      id: "openai/gpt-5.6-sol@openrouter",
      provider: "openrouter",
    })
  })

  it("curates the Requesty models under the `@requesty` route, same as claude-code", () => {
    const allowed = claudeSdk.models?.allowed ?? []
    const entries = allowed.filter((m): m is AgentCliModelEntry => typeof m !== "string")
    const byId = (id: string) => entries.find((e) => e.id === id)
    expect(byId("sference/thinkingcap-qwen3.6-27b@requesty")).toEqual({
      id: "sference/thinkingcap-qwen3.6-27b@requesty",
      provider: "requesty",
    })
    expect(byId("sference/glm-5.2@requesty")).toEqual({
      id: "sference/glm-5.2@requesty",
      provider: "requesty",
    })
  })

  it("curates ONLY the Anthropic-surface OpenCode ids, derived from the catalog", () => {
    const allowed = claudeSdk.models?.allowed ?? []
    const entries = allowed.filter((m): m is AgentCliModelEntry => typeof m !== "string")
    const ids = (provider: string) =>
      entries.filter((e) => e.provider === provider).map((e) => e.id)

    // Both OpenCode endpoints serve three wire surfaces behind one base URL;
    // only the `/v1/messages` subset is reachable from this SDK. The menu is
    // derived from the catalog's generated per-model surface discriminator, so
    // it can never drift into offering an id the endpoint won't answer.
    expect(ids("opencode-go").sort()).toEqual(
      listOpencodeAnthropicModelRefs("opencode-go"),
    )
    expect(ids("opencode").sort()).toEqual(listOpencodeAnthropicModelRefs("opencode"))

    // Zen's Anthropic subset is the whole Claude family — the point of the route.
    expect(ids("opencode")).toContain("opencode/claude-sonnet-4-6")
    expect(ids("opencode")).toContain("opencode/claude-opus-5")
    // Membership, not an exact list: the roster is catalog-synced, and the
    // derived-menu equality above already pins the exact shape. union-alpha
    // joined Go's Anthropic surface after #1309 verified the original four
    // (same disease as #1328/#1331/#1332 — this is the last literal).
    for (const id of [
      "opencode-go/minimax-m2.5",
      "opencode-go/minimax-m2.7",
      "opencode-go/minimax-m3",
      "opencode-go/qwen3.8-flash",
    ]) {
      expect(ids("opencode-go")).toContain(id)
    }
    expect(ids("opencode-go")).not.toContain("opencode-go/glm-5.3")

    // No `@route` suffix: for these endpoints the route IS the leading segment.
    expect([...ids("opencode"), ...ids("opencode-go")].every((id) => !id.includes("@"))).toBe(
      true,
    )
  })
})
