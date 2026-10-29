import { describe, expect, it } from "vitest"
import { defineAgent } from "../define-agent.js"
import { agentFrontmatterSchema } from "../schema.js"

const base = {
  schema: "agent/v1" as const,
  id: "synthetic",
  description: "A synthetic agent.",
  model: "provider/model",
}

const parseTools = (tools: unknown[]) => agentFrontmatterSchema.safeParse({ ...base, tools })

describe("AIP-42 structured tool item { kind: mcp, server, allow?, deny? }", () => {
  it("accepts the structured item next to the AIP-54 ref forms", () => {
    const result = parseTools([
      "plain-builtin",
      { ref: "tool:katchy/search" },
      { kind: "mcp", server: "github" },
      { kind: "mcp", server: "github", allow: ["create_issue"], deny: ["delete_repo"] },
      { kind: "mcp", server: "empty", allow: [] },
    ])
    expect(result.success).toBe(true)
  })

  it("keeps the structured item on the typed handle", () => {
    const handle = defineAgent({
      ...base,
      tools: [{ kind: "mcp", server: "github", allow: ["a"], deny: ["b"] }],
    })
    expect(handle.tools).toEqual([{ kind: "mcp", server: "github", allow: ["a"], deny: ["b"] }])
  })

  it.each([
    ["a missing server", { kind: "mcp", allow: ["a"] }],
    ["a '/' in the server", { kind: "mcp", server: "gh/hub" }],
    ["a '/' in an allowed name", { kind: "mcp", server: "github", allow: ["github/create_issue"] }],
    ["a '/' in a denied name", { kind: "mcp", server: "github", deny: ["github/x"] }],
    ["an empty server", { kind: "mcp", server: "" }],
    ["an extra key", { kind: "mcp", server: "github", scope: {} }],
    ["an unknown kind", { kind: "http", server: "github" }],
    ["a non-string name", { kind: "mcp", server: "github", allow: [3] }],
    ["allow that is not a list", { kind: "mcp", server: "github", allow: "a" }],
  ])("refuses %s", (_label, item) => {
    expect(parseTools([item]).success).toBe(false)
  })

  it("refuses a malformed item through defineAgent too", () => {
    expect(() => defineAgent({ ...base, tools: [{ kind: "mcp" }] as never })).toThrow()
  })
})
