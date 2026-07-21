import { describe, expect, it } from "vitest"
import type { AgentCliModelEntry } from "@agentproto/driver-agent-cli"
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
    expect(ids).toContain("kimi-k2.7-code")
    expect(ids).toContain("z-ai/glm-5.2")

    const entries = allowed.filter((m): m is AgentCliModelEntry => typeof m !== "string")
    const byId = (id: string) => entries.find((e) => e.id === id)

    // Slice 4 removed hard-coded gateway modes. Gateway models now declare
    // their provider/biller only; the runtime resolver injects the correct
    // ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN.
    expect(byId("kimi-k2.7-code")).toEqual({ id: "kimi-k2.7-code", provider: "moonshot" })
    expect(byId("z-ai/glm-5.2")).toEqual({ id: "z-ai/glm-5.2", provider: "openrouter" })
    expect(byId("claude-opus-4-8")).toEqual({ id: "claude-opus-4-8", provider: "anthropic" })
  })
})
