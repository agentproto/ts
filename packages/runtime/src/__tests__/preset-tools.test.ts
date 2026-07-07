import { describe, expect, it } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { AdapterEntry } from "@agentproto/provider-kit"
import {
  listPresets,
  registerPresetTools,
  declaredPresetToProviderPreset,
  type PresetInfo,
  type DeclaredAdapterPreset,
} from "../preset-tools.js"

// ── fake McpServer that captures registered tools ──────────────────────────────

interface Registered {
  name: string
  description: string
  shape: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: "text"; text: string }[]
    isError?: boolean
  }>
}

function fakeServer(): { server: McpServer; tools: Registered[] } {
  const tools: Registered[] = []
  const server = {
    tool: (
      name: string,
      description: string,
      shape: Record<string, unknown>,
      handler: Registered["handler"],
    ) => {
      tools.push({ name, description, shape, handler })
    },
  } as unknown as McpServer
  return { server, tools }
}

// ── listPresets ────────────────────────────────────────────────────────────────

describe("listPresets", () => {
  it("maps every preset in the registry to a catalog entry", () => {
    const entries = listPresets({})
    // moonshot + openrouter ship in @agentproto/provider-presets today.
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(entries.map((e) => e.slug).sort()).toEqual(
      expect.arrayContaining(["moonshot", "openrouter"]),
    )
  })

  it("reports 'available' when the key env var is absent", () => {
    const entries = listPresets({})
    const moonshot = entries.find((e) => e.slug === "moonshot")!
    expect(moonshot).toBeTruthy()
    expect(moonshot.status).toBe("available")
    expect(moonshot.version).toBe("built-in")
    expect(moonshot.packageName).toBe("@agentproto/provider-presets")
  })

  it("reports 'ready' when the key env var is present (daemon env)", () => {
    const entries = listPresets({ MOONSHOT_API_KEY: "sk-test" })
    const moonshot = entries.find((e) => e.slug === "moonshot")!
    expect(moonshot.status).toBe("ready")

    // openrouter key still absent → stays available (per-preset, not all-or-nothing)
    const openrouter = entries.find((e) => e.slug === "openrouter")!
    expect(openrouter.status).toBe("available")
  })

  it("surfaces user-facing info (baseUrl/keyEnv/schemaFlavor/defaultModel) and never a key value", () => {
    const entries = listPresets({ MOONSHOT_API_KEY: "sk-secret" })
    const moonshot = entries.find((e) => e.slug === "moonshot") as
      | AdapterEntry<PresetInfo>
      | undefined
    expect(moonshot?.info).toMatchObject({
      schemaFlavor: "anthropic",
      baseUrl: "https://api.moonshot.ai/anthropic",
      keyEnv: "MOONSHOT_API_KEY",
      defaultModel: "kimi-k2.7-code",
    })
    // Security (Appendix B): no credential value anywhere in the entry/info.
    const serialised = JSON.stringify(moonshot)
    expect(serialised).not.toContain("sk-secret")
  })

  it("includes openrouter with no defaultModel (model chosen via the model option)", () => {
    const entries = listPresets({})
    const openrouter = entries.find((e) => e.slug === "openrouter")
    expect(openrouter?.info?.baseUrl).toBe("https://openrouter.ai/api/v1")
    expect(openrouter?.info?.keyEnv).toBe("OPENROUTER_API_KEY")
    expect(openrouter?.info?.defaultModel).toBeUndefined()
  })
})

// ── registerPresetTools / list_provider_presets ────────────────────────────────

describe("registerPresetTools", () => {
  it("registers a parameterless list_provider_presets tool", async () => {
    const { server, tools } = fakeServer()
    registerPresetTools(server)

    const listTool = tools.find((t) => t.name === "list_provider_presets")!
    expect(listTool).toBeTruthy()
    expect(listTool.shape).toEqual({})

    const res = await listTool.handler({})
    expect(res.isError).toBeFalsy()
    const entries = JSON.parse(res.content[0]!.text) as AdapterEntry<PresetInfo>[]
    expect(entries.length).toBeGreaterThanOrEqual(2)
    for (const e of entries) {
      // Honest two-state vocabulary: presets are always at least "available".
      expect(["available", "ready"]).toContain(e.status)
      expect(e.info?.keyEnv).toBeTruthy()
    }
  })

  it("never registers a setup tool (presets have no creds store)", () => {
    const { server, tools } = fakeServer()
    registerPresetTools(server)
    expect(tools.some((t) => t.name.startsWith("setup_"))).toBe(false)
  })
})

// ── adapter-declared presets (AIP-45 `presets` manifest field) ─────────────────

const deepseekDirect: DeclaredAdapterPreset = {
  id: "deepseek-direct",
  label: "DeepSeek (direct)",
  description: "DeepSeek's Anthropic-compatible endpoint.",
  schemaFlavor: "anthropic",
  baseUrl: "https://api.deepseek.com/anthropic",
  keyEnv: "DEEPSEEK_API_KEY",
  scrubEnv: ["ANTHROPIC_API_KEY"],
  defaultModel: "deepseek-v4-pro",
  homepage: "https://platform.deepseek.com",
}

describe("declaredPresetToProviderPreset", () => {
  it("normalizes a full declaration to the canonical shape", () => {
    const p = declaredPresetToProviderPreset(deepseekDirect)
    expect(p).toMatchObject({
      id: "deepseek-direct",
      label: "DeepSeek (direct)",
      schemaFlavor: "anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      keyEnv: "DEEPSEEK_API_KEY",
      scrubEnv: ["ANTHROPIC_API_KEY"],
      defaultModel: "deepseek-v4-pro",
      homepage: "https://platform.deepseek.com",
    })
  })

  it("defaults scrubEnv to [] and description to '' when omitted", () => {
    const p = declaredPresetToProviderPreset({
      id: "bare",
      label: "Bare",
      schemaFlavor: "openai",
      baseUrl: "https://example.com/v1",
      keyEnv: "BARE_API_KEY",
    })
    expect(p.scrubEnv).toEqual([])
    expect(p.description).toBe("")
    expect(p.defaultModel).toBeUndefined()
    expect(p.homepage).toBeUndefined()
  })
})

describe("listPresets — adapter-declared merge", () => {
  it("appends an adapter-declared preset not in the built-in registry", () => {
    const entries = listPresets({}, [deepseekDirect])
    const slugs = entries.map((e) => e.slug)
    expect(slugs).toContain("deepseek-direct")
    const ds = entries.find((e) => e.slug === "deepseek-direct")!
    expect(ds.info!.baseUrl).toBe("https://api.deepseek.com/anthropic")
    expect(ds.info!.defaultModel).toBe("deepseek-v4-pro")
  })

  it("reports 'ready' for an adapter-declared preset when its key env is set", () => {
    const entries = listPresets({ DEEPSEEK_API_KEY: "sk-ds" }, [deepseekDirect])
    const ds = entries.find((e) => e.slug === "deepseek-direct")!
    expect(ds.status).toBe("ready")
  })

  it("ignores an adapter-declared id that collides with a built-in (registry wins)", () => {
    const collision: DeclaredAdapterPreset = {
      id: "moonshot",
      label: "Fake Moonshot",
      schemaFlavor: "anthropic",
      baseUrl: "https://evil.example/anthropic",
      keyEnv: "FAKE_MOONSHOT_KEY",
    }
    const entries = listPresets({}, [collision])
    const moonshot = entries.filter((e) => e.slug === "moonshot")
    expect(moonshot).toHaveLength(1)
    // Built-in facts win — the fake base URL / key env did not override.
    expect(moonshot[0]!.info!.baseUrl).toBe("https://api.moonshot.ai/anthropic")
    expect(moonshot[0]!.info!.keyEnv).toBe("MOONSHOT_API_KEY")
  })

  it("defaults to the built-in registry only when no adapter presets are passed", () => {
    const baseline = listPresets({}).map((e) => e.slug).sort()
    const none = listPresets({}, []).map((e) => e.slug).sort()
    expect(none).toEqual(baseline)
  })
})
