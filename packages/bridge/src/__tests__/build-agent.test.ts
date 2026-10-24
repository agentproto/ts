import { describe, expect, it, vi } from "vitest"
import {
  defineAgent,
  parseAgentManifest,
  agentFromManifest,
  type AgentHandle,
} from "@agentproto/agent"
import { buildMastraAgent } from "../build-agent.js"
import { composeInstructions } from "../instructions.js"

// Fake AI-SDK-shaped model. Mastra accepts arbitrary objects on the
// `model` field as long as they satisfy `generate`/`stream` at call
// time; we never invoke the agent in tests, just construct it.
const fakeModel = { provider: "test", id: "test-model" }

const writerHandle: AgentHandle = defineAgent({
  schema: "agent/v1",
  id: "writer",
  description:
    "Long-form writing agent — drafts, briefs, editorial copy.",
  model: "anthropic/claude-opus-4-7",
  tools: ["@agentik/tools-standard/web-fetch"],
  memory: { scope: "per-conversation", retention_turns: 50 },
  autonomy: 7,
  boundaries: [
    "Never publish without explicit user approval — drafts only",
    "Cite sources for any factual claim",
  ],
  tags: ["writing"],
})

describe("buildMastraAgent", () => {
  it("constructs a Mastra Agent and returns diagnostics", async () => {
    const fakeTool = { id: "web-fetch", description: "fetch a URL" }
    const result = await buildMastraAgent(writerHandle, {
      resolveModel: () => fakeModel,
      resolveTool: (ref) =>
        typeof ref === "string" && ref.endsWith("/web-fetch")
          ? { name: "web_fetch", tool: fakeTool }
          : undefined,
    })

    expect(result.agent).toBeDefined()
    expect(result.agent.name).toBe("writer")
    expect(result.resolvedTools).toEqual(["web_fetch"])
    expect(result.droppedTools).toEqual([])
    expect(result.instructions).toContain("Hard rules")
    expect(result.instructions).toContain("Never publish")
  })

  it("falls back to description when no body is given", async () => {
    const result = await buildMastraAgent(writerHandle, {
      resolveModel: () => fakeModel,
    })
    expect(result.instructions.startsWith("Long-form writing agent")).toBe(true)
  })

  it("uses the markdown body as instructions when provided", async () => {
    const body = "# Writer\n\nYou draft long-form text.\n"
    const result = await buildMastraAgent(writerHandle, {
      resolveModel: () => fakeModel,
      body,
    })
    expect(result.instructions.startsWith("# Writer")).toBe(true)
    expect(result.instructions).toContain("You draft long-form text.")
  })

  it("drops unresolved tools with a warning by default", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await buildMastraAgent(writerHandle, {
      resolveModel: () => fakeModel,
      resolveTool: () => undefined,
    })
    expect(result.resolvedTools).toEqual([])
    expect(result.droppedTools).toEqual([
      "@agentik/tools-standard/web-fetch",
    ])
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("throws on unresolved tools in strict mode", async () => {
    await expect(
      buildMastraAgent(writerHandle, {
        resolveModel: () => fakeModel,
        resolveTool: () => undefined,
        strict: true,
      }),
    ).rejects.toThrow(/did not resolve/)
  })

  it("builds memory when buildMemory is provided", async () => {
    const fakeMemory = { kind: "fake-memory" }
    const buildMemory = vi.fn(() => fakeMemory)
    const result = await buildMastraAgent(writerHandle, {
      resolveModel: () => fakeModel,
      buildMemory,
    })
    expect(buildMemory).toHaveBeenCalledWith(writerHandle.memory)
    expect(result.agent).toBeDefined()
  })

  it("strips @owner/ prefix from id for the agent name", async () => {
    const namespaced = defineAgent({
      schema: "agent/v1",
      id: "@agentik/writer",
      description: "Namespaced writer",
      model: "anthropic/claude-opus-4-7",
    })
    const result = await buildMastraAgent(namespaced, {
      resolveModel: () => fakeModel,
    })
    expect(result.agent.name).toBe("writer")
    expect(result.agent.id).toBe("@agentik/writer")
  })

  it("round-trips through parseAgentManifest + agentFromManifest", async () => {
    const source = [
      "---",
      "schema: agent/v1",
      "id: round-trip",
      "description: Parsed from raw markdown",
      "model: anthropic/claude-opus-4-7",
      "boundaries:",
      "  - No deletes",
      "---",
      "",
      "# Round trip",
      "",
      "You exist to test the parse path.",
      "",
    ].join("\n")
    const parsed = parseAgentManifest(source)
    const handle = agentFromManifest(parsed)
    const result = await buildMastraAgent(handle, {
      resolveModel: () => fakeModel,
      body: parsed.body,
    })
    expect(result.instructions).toContain("# Round trip")
    expect(result.instructions).toContain("You exist to test the parse path.")
    expect(result.instructions).toContain("- No deletes")
  })
})

describe("composeInstructions", () => {
  it("appends boundaries as a hard-rules block", () => {
    const out = composeInstructions(writerHandle, "## body\n")
    expect(out).toContain("## body")
    expect(out).toContain("Hard rules")
    expect(out).toContain("- Never publish")
    expect(out).toContain("- Cite sources")
  })

  it("renders trait scores as a single line", () => {
    const handle = defineAgent({
      schema: "agent/v1",
      id: "trait-test",
      description: "test",
      model: "x/y",
      traits: { rigor: 9, warmth: 4 },
    })
    const out = composeInstructions(handle, undefined)
    expect(out).toContain("Trait scores (0-10): rigor=9, warmth=4")
  })

  it("inlines persona content when persona has an inline block", () => {
    const handle = defineAgent({
      schema: "agent/v1",
      id: "persona-test",
      description: "test",
      model: "x/y",
      persona: {
        inline: { name: "Alex", tone: "warm but direct" },
      },
    })
    const out = composeInstructions(handle, undefined)
    expect(out).toContain("Persona")
    expect(out).toContain("Name: Alex")
    expect(out).toContain("Tone: warm but direct")
  })
})
