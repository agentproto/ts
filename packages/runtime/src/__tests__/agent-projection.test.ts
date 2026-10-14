/**
 * `projectAgentToSpawn` — an AIP-42 AGENT.md projected onto spawn fields
 * for each capability combination a harness can report.
 */

import { describe, it, expect } from "vitest"
import { defineAgent, type AgentHandle } from "@agentproto/agent"
import { prefixPrompt, projectAgentToSpawn } from "../agent-projection.js"

const PATH = "/apps/trip/.agentproto/agents/scout/AGENT.md"

function scout(extra: Partial<Parameters<typeof defineAgent>[0]> = {}): AgentHandle {
  return defineAgent({
    schema: "agent/v1",
    id: "scout",
    description: "Scouts one zone.",
    model: "opencode-go/kimi-k2",
    boundaries: ["Never invent a sourceUrl", "Write only inside data/"],
    persona: { inline: { name: "Scout", tone: "terse" } },
    tools: ["file_write", "file_read", { ref: "@x/structured" }],
    skills: ["trip-research"],
    ...extra,
  })
}

const input = (handle: AgentHandle, body = "You are a trip scout.") => ({
  path: PATH,
  handle,
  body,
  ...(typeof handle.model === "string" ? { model: handle.model } : {}),
})

const joined = (w: string[]) => w.join("\n")

describe("projectAgentToSpawn", () => {
  it("a manifest-native adapter gets the AGENT.md path as its declared option, plus the gateway tool scope", () => {
    const p = projectAgentToSpawn(input(scout()), { agentManifestOption: "agent" })
    expect(p).toEqual({
      model: "opencode-go/kimi-k2",
      options: { agent: PATH },
      tools: ["file_write", "file_read"],
      warnings: [],
    })
  })

  it("a plain harness gets body + persona + boundaries as instructions, with a prefix warning", () => {
    const p = projectAgentToSpawn(input(scout()), {})
    expect(p.options).toBeUndefined()
    expect(p.instructions).toContain("You are a trip scout.")
    expect(p.instructions).toContain("Name: Scout")
    expect(p.instructions).toContain("Hard rules — these MUST be followed:\n- Never invent a sourceUrl")
    expect(joined(p.warnings)).toMatch(/no system-prompt channel.*boundaries, persona.*first prompt's prefix/)
  })

  it("an adapter with a system-prompt channel takes the text as `systemPrompt` — no instructions, no prefix warning", () => {
    const p = projectAgentToSpawn(input(scout()), {
      supportsSystemPrompt: true,
      deliversSessionSkills: true,
    })
    expect(p.systemPrompt).toContain("You are a trip scout.")
    expect(p.systemPrompt).toContain("Name: Scout")
    expect(p.systemPrompt).toContain("Never invent a sourceUrl")
    expect(p.instructions).toBeUndefined()
    expect(joined(p.warnings)).not.toMatch(/no system-prompt channel/)
    // Everything the plain-harness path still delivers (tools scope, skills)
    // rides along unchanged.
    expect(p.tools).toEqual(["file_write", "file_read"])
    expect(p.skills).toEqual(["trip-research"])
  })

  it("declared string tools scope the gateway; native tools and structured refs are warned about", () => {
    const p = projectAgentToSpawn(input(scout()), {})
    expect(p.tools).toEqual(["file_write", "file_read"])
    expect(joined(p.warnings)).toMatch(/native tools stay available/)
    expect(joined(p.warnings)).toMatch(/1 structured tool ref\(s\)/)
  })

  it("skills go to a harness with session-skill delivery", () => {
    const p = projectAgentToSpawn(input(scout()), { deliversSessionSkills: true })
    expect(p.skills).toEqual(["trip-research"])
    expect(joined(p.warnings)).not.toMatch(/cannot load skills/)
  })

  it("skills go to a harness with a `skills` option", () => {
    const p = projectAgentToSpawn(input(scout()), { declaredOptions: [{ id: "skills" }] })
    expect(p.skills).toEqual(["trip-research"])
  })

  it("a harness that can take no skills drops them with a warning", () => {
    const p = projectAgentToSpawn(input(scout()), { declaredOptions: [{ id: "model" }] })
    expect(p.skills).toBeUndefined()
    expect(joined(p.warnings)).toMatch(/cannot load skills — trip-research not delivered/)
  })

  it("a caller-pinned model wins over the AGENT.md model", () => {
    expect(projectAgentToSpawn(input(scout()), {}, "claude-sonnet-5").model).toBe("claude-sonnet-5")
    expect(projectAgentToSpawn(input(scout()), { agentManifestOption: "agent" }, "x/y").model).toBe("x/y")
  })

  it("an agent with no tools, skills or boundaries projects only its instructions", () => {
    const bare = defineAgent({ schema: "agent/v1", id: "bare", description: "Bare.", model: "x/y" })
    const p = projectAgentToSpawn({ path: PATH, handle: bare, body: "Do it." }, {})
    expect(p).toEqual({ instructions: "Do it.", warnings: [expect.stringMatching(/first prompt's prefix/)] })
  })

  it("falls back to the description when the body is empty", () => {
    const bare = defineAgent({ schema: "agent/v1", id: "bare", description: "Bare agent.", model: "x/y" })
    expect(projectAgentToSpawn({ path: PATH, handle: bare, body: "  " }, {}).instructions).toBe("Bare agent.")
  })
})

describe("prefixPrompt", () => {
  it("puts the instructions before the caller's ask", () => {
    expect(prefixPrompt("Rules.", "Go.")).toBe("Rules.\n\nGo.")
  })
  it("either side alone stands alone", () => {
    expect(prefixPrompt("Rules.", undefined)).toBe("Rules.")
    expect(prefixPrompt(undefined, "Go.")).toBe("Go.")
    expect(prefixPrompt("  ", "Go.")).toBe("Go.")
  })
})
