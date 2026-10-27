import { describe, it, expect, vi } from "vitest"
import {
  buildResearcherArgs,
  createResearcherHarness,
  DEFAULT_RESEARCH_SCHEMA,
  renderResearcherPrompt,
} from "../harnesses/researcher.js"

describe("buildResearcherArgs", () => {
  it("defaults to hermes adapter; omits model from args (sent via /model turn)", () => {
    const args = buildResearcherArgs({})
    expect(args.adapter).toBe("hermes")
    // hermes does not declare model as a manifest option — omitted from spawn args
    expect(args.model).toBeUndefined()
  })

  it("omits prompt from spawn args (injected as explicit turn in createResearcherHarness)", () => {
    const args = buildResearcherArgs({})
    // prompt is delivered as a controlled turn post-spawn to avoid turn-end races
    expect(args.prompt).toBeUndefined()
  })

  it("merges searchMcp into mcpServers", () => {
    const searchMcp = { name: "search", transport: "http" as const, ref: "bureau:search" }
    const args = buildResearcherArgs({ searchMcp })
    expect(args.mcpServers).toBeDefined()
    expect(args.mcpServers).toContainEqual(expect.objectContaining({ name: "search" }))
  })

  it("merges searchMcp with existing mcpServers", () => {
    const existing = [{ name: "gh", transport: "http" as const }]
    const searchMcp = { name: "search", transport: "http" as const }
    const args = buildResearcherArgs({ mcpServers: existing, searchMcp })
    expect(args.mcpServers).toHaveLength(2)
    expect(args.mcpServers).toContainEqual(expect.objectContaining({ name: "gh" }))
    expect(args.mcpServers).toContainEqual(expect.objectContaining({ name: "search" }))
  })

  it("respects model override (stored for /model turn, not in spawn args)", () => {
    const args = buildResearcherArgs({ model: "openai/gpt-4o" })
    // model override is NOT in spawn args — createResearcherHarness sends it as /model turn
    expect(args.model).toBeUndefined()
  })

  it("passes cwd through", () => {
    const args = buildResearcherArgs({ cwd: "/tmp/research" })
    expect(args.cwd).toBe("/tmp/research")
  })

  it("passes label through", () => {
    const args = buildResearcherArgs({ label: "market-research-q3" })
    expect(args.label).toBe("market-research-q3")
  })
})

describe("DEFAULT_RESEARCH_SCHEMA", () => {
  it("has findings, sources, confidence keys", () => {
    expect(DEFAULT_RESEARCH_SCHEMA).toHaveProperty("findings")
    expect(DEFAULT_RESEARCH_SCHEMA).toHaveProperty("sources")
    expect(DEFAULT_RESEARCH_SCHEMA).toHaveProperty("confidence")
  })

  it("findings and sources are string type hints", () => {
    expect(DEFAULT_RESEARCH_SCHEMA.findings).toBe("string[]")
    expect(DEFAULT_RESEARCH_SCHEMA.sources).toBe("string[]")
  })

  it("confidence is a union type hint", () => {
    expect(DEFAULT_RESEARCH_SCHEMA.confidence).toBe("low | medium | high")
  })
})

describe("renderResearcherPrompt", () => {
  it("includes researcher agent instruction and English directive", () => {
    const prompt = renderResearcherPrompt({})
    expect(prompt).toContain("researcher agent")
    expect(prompt).toContain("gather")
    expect(prompt).toContain("evidence")
    expect(prompt).toContain("Always reply in English")
  })

  it("renders default schema as JSON", () => {
    const prompt = renderResearcherPrompt({})
    expect(prompt).toContain('"findings"')
    expect(prompt).toContain('"string[]"')
  })

  it("renders custom outputSchema", () => {
    const prompt = renderResearcherPrompt({
      outputSchema: { results: "object[]", summary: "string" },
    })
    // schema section uses the custom schema
    expect(prompt).toContain('"results"')
    expect(prompt).toContain('"summary"')
    // format hint is hardcoded — still contains "findings"
    expect(prompt).toContain("findings")
  })
})

describe("createResearcherHarness", () => {
  it("sends /model turn, drains it, injects system prompt, drains it, returns handle", async () => {
    const fakeWait = { sessionId: "sess_r", event: "turn-end" }
    const fakeSession = { id: "sess_r", status: "running", startedAt: new Date().toISOString() }
    const client = {
      start: vi.fn().mockResolvedValue(fakeSession),
      prompt: vi.fn().mockResolvedValue(undefined),
      waitForAny: vi.fn().mockResolvedValue(fakeWait),
    } as any
    const handle = await createResearcherHarness(client, {})
    expect(handle.sessionId).toBe("sess_r")
    expect(handle.adapter).toBe("hermes")
    // call order: /model turn, then system prompt turn
    expect(client.prompt).toHaveBeenNthCalledWith(1, "sess_r", "/model z-ai/glm-5.2")
    expect(client.prompt).toHaveBeenNthCalledWith(2, "sess_r", expect.stringContaining("researcher agent"))
    // two waitForAny calls: model-switch drain + system-prompt drain
    expect(client.waitForAny).toHaveBeenCalledTimes(2)
    expect(client.waitForAny).toHaveBeenNthCalledWith(1, ["sess_r"], { event: "turn-end", timeoutMs: 15_000 })
    expect(client.waitForAny).toHaveBeenNthCalledWith(2, ["sess_r"], { event: "turn-end", timeoutMs: 30_000 })
    expect(handle.model).toBe("z-ai/glm-5.2")
  })

  it("passes model override through handle and /model turn", async () => {
    const fakeWait = { sessionId: "sess_r2", event: "turn-end" }
    const fakeSession = { id: "sess_r2", status: "running", startedAt: new Date().toISOString() }
    const client = {
      start: vi.fn().mockResolvedValue(fakeSession),
      prompt: vi.fn().mockResolvedValue(undefined),
      waitForAny: vi.fn().mockResolvedValue(fakeWait),
    } as any
    const handle = await createResearcherHarness(client, { model: "openai/gpt-4o" })
    expect(client.prompt).toHaveBeenNthCalledWith(1, "sess_r2", "/model openai/gpt-4o")
    expect(handle.model).toBe("openai/gpt-4o")
  })
})