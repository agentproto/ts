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
      servers: { agentproto: { allowTools: ["file_write", "file_read"] } },
      warnings: [],
    })
  })

  it("a plain harness gets body + persona + boundaries as instructions, with a prefix warning", () => {
    const p = projectAgentToSpawn(input(scout()), {})
    expect(p.options).toBeUndefined()
    expect(p.instructions).toContain("You are a trip scout.")
    expect(p.instructions).toContain("Name: Scout")
    expect(p.instructions).toContain("Hard rules (these MUST be followed):\n- Never invent a sourceUrl")
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

  it("a limited channel that fits the text still takes `systemPrompt`", () => {
    const p = projectAgentToSpawn(input(scout()), {
      supportsSystemPrompt: true,
      systemPromptMaxChars: 100_000,
      deliversSessionSkills: true,
    })
    expect(p.systemPrompt).toContain("You are a trip scout.")
    expect(joined(p.warnings)).not.toMatch(/char system-prompt limit/)
  })

  it("a channel over its char limit degrades to instructions + a warning naming the limit", () => {
    const p = projectAgentToSpawn(input(scout()), {
      supportsSystemPrompt: true,
      systemPromptMaxChars: 10,
      deliversSessionSkills: true,
    })
    expect(p.systemPrompt).toBeUndefined()
    expect(p.instructions).toContain("You are a trip scout.")
    expect(joined(p.warnings)).toMatch(
      /the AGENT\.md text is \d+ chars, over this harness's 10-char system-prompt limit — delivered as the first prompt's prefix instead/,
    )
    // The rest of the projection is unaffected by the degraded channel.
    expect(p.tools).toEqual(["file_write", "file_read"])
    expect(p.skills).toEqual(["trip-research"])
  })

  it("declared string tools scope the gateway; native tools and structured refs are warned about", () => {
    const p = projectAgentToSpawn(input(scout()), {})
    expect(p.tools).toEqual(["file_write", "file_read"])
    expect(joined(p.warnings)).toMatch(/native tools stay available/)
    expect(joined(p.warnings)).toMatch(/1 structured tool ref\(s\)/)
  })

  describe("structured { kind: mcp } tool items", () => {
    const project = (tools: Parameters<typeof defineAgent>[0]["tools"]) =>
      projectAgentToSpawn(input(scout({ tools })), { agentManifestOption: "agent" })

    it("a structured item reaches the projection as that server's allowTools and denyTools", () => {
      const p = project([{ kind: "mcp", server: "github", allow: ["create_issue", "list_prs"], deny: ["delete_repo"] }])
      expect(p.servers).toEqual({
        github: { allowTools: ["create_issue", "list_prs"], denyTools: ["delete_repo"] },
      })
      expect(p.tools).toBeUndefined()
    })

    it("a server item with no allow admits the whole server (no allowTools)", () => {
      expect(project([{ kind: "mcp", server: "github" }]).servers).toEqual({ github: {} })
    })

    it("allow: [] admits nothing on that server", () => {
      expect(project([{ kind: "mcp", server: "github", allow: [] }]).servers).toEqual({
        github: { allowTools: [] },
      })
    })

    it("deny wins over allow within one item", () => {
      const p = project([{ kind: "mcp", server: "github", allow: ["a", "b"], deny: ["b"] }])
      expect(p.servers?.github).toEqual({ allowTools: ["a"], denyTools: ["b"] })
    })

    it("deny wins over another item of the same server admitting the tool", () => {
      const p = project([
        { kind: "mcp", server: "github", allow: ["a", "b"] },
        { kind: "mcp", server: "github", allow: [], deny: ["a"] },
      ])
      expect(p.servers?.github).toEqual({ allowTools: ["b"], denyTools: ["a"] })
    })

    it("a deny-only item (no allow) means the whole server minus the denied names", () => {
      const p = project([
        { kind: "mcp", server: "github", allow: ["a", "b"] },
        { kind: "mcp", server: "github", deny: ["a"] },
      ])
      expect(p.servers?.github).toEqual({ denyTools: ["a"] })
    })

    it("deny wins over a whole-server item of the same server", () => {
      const p = project([
        { kind: "mcp", server: "github" },
        { kind: "mcp", server: "github", deny: ["delete_repo"] },
      ])
      expect(p.servers?.github).toEqual({ denyTools: ["delete_repo"] })
    })

    it("deny wins over a bare string admitting the same built-in", () => {
      const p = project(["file_write", "file_read", { kind: "mcp", server: "agentproto", allow: [], deny: ["file_write"] }])
      expect(p.servers?.agentproto).toEqual({ allowTools: ["file_read"], denyTools: ["file_write"] })
      expect(p.tools).toEqual(["file_read"])
    })

    it("a deny on one server does not touch another", () => {
      const p = project([
        { kind: "mcp", server: "a", allow: ["x"] },
        { kind: "mcp", server: "b", allow: ["x"], deny: ["x"] },
      ])
      expect(p.servers).toEqual({ a: { allowTools: ["x"] }, b: { allowTools: [], denyTools: ["x"] } })
    })

    it("is no longer dropped with the 'structured tool ref' warning", () => {
      const p = projectAgentToSpawn(
        input(scout({ tools: [{ kind: "mcp", server: "github", allow: ["a"] }] })),
        {},
      )
      expect(joined(p.warnings)).not.toMatch(/structured tool ref/)
    })

    it("still warns about a structured ref that is not a server item", () => {
      const p = projectAgentToSpawn(input(scout({ tools: [{ kind: "mcp", server: "s" }, { ref: "@x/y" }] })), {})
      expect(joined(p.warnings)).toMatch(/1 structured tool ref\(s\)/)
    })
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
