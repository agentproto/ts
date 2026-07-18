import { describe, it, expect } from "vitest"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { defineWorkspace } from "@agentproto/workspace"
import { defineApp, AppDefinitionError } from "../define-app.js"

function agent(id: string, workflows: { ref: string }[] = [{ ref: "review-and-fix" }]) {
  return defineAgent({
    schema: "agent/v1",
    id,
    description: `Agent ${id} bundled with its workflow.`,
    model: "claude-sonnet-5",
    workflows,
  })
}

function reviewWorkflow(id = "review-and-fix") {
  return defineWorkflow({
    id,
    name: "Review and fix",
    description: "Read the diff, report findings.",
    version: "0.1.0",
    inputs: {},
    outputs: {},
    steps: [{ id: "review", kind: "tool", tool: "read_diff" }],
  })
}

describe("defineApp — multi-agent + attachment invariant", () => {
  it("builds a frozen handle when agents ⇄ workflows match", () => {
    const app = defineApp({
      agents: [
        { agent: agent("@agentik/reviewer"), body: "You review." },
        { agent: agent("@agentik/fixer") }, // body optional
      ],
      workflows: [reviewWorkflow()],
    })
    expect(app.agents).toHaveLength(2)
    expect(app.agents[0]!.body).toBe("You review.")
    expect(app.agents[1]!.body).toBeUndefined()
    expect(Object.isFrozen(app)).toBe(true)
    expect(Object.isFrozen(app.agents)).toBe(true)
  })

  it("accepts a bare AgentHandle in agents[] (no body)", () => {
    const app = defineApp({
      agents: [agent("solo", [])],
    })
    expect(app.agents).toHaveLength(1)
    expect(app.agents[0]!.agent.id).toBe("solo")
  })

  it("carries attachments (any AIP handle) verbatim", () => {
    const company = { id: "acme", schema: "agentcompanies/v1" }
    const app = defineApp({
      agents: [agent("solo", [])],
      attach: [company],
    })
    expect(app.attachments).toEqual([company])
  })

  it("throws on an empty agents array", () => {
    expect(() => defineApp({ agents: [] })).toThrow(AppDefinitionError)
  })

  it("throws on a duplicate agent id", () => {
    expect(() =>
      defineApp({ agents: [agent("dup", []), agent("dup", [])] }),
    ).toThrow(/duplicate agent id/i)
  })

  it("throws when an agent references a workflow the app does not bundle", () => {
    expect(() =>
      defineApp({
        agents: [{ agent: agent("rev", [{ ref: "ghost" }]) }],
        workflows: [reviewWorkflow()],
      }),
    ).toThrow(AppDefinitionError)
  })

  it("throws when a bundled workflow is referenced by no agent (orphan)", () => {
    expect(() =>
      defineApp({
        agents: [agent("rev", [])],
        workflows: [reviewWorkflow()],
      }),
    ).toThrow(/no agent lists it/i)
  })

  it("accepts a workflow referenced by only one of several agents", () => {
    const app = defineApp({
      agents: [
        { agent: agent("rev", [{ ref: "review-and-fix" }]) },
        { agent: agent("bystander", []) },
      ],
      workflows: [reviewWorkflow()],
    })
    expect(app.workflows).toHaveLength(1)
  })

  it("normalizes a workspace shorthand to an AIP-34 handle with local-fs default", () => {
    const app = defineApp({
      agents: [agent("solo", [])],
      workspace: {
        id: "@acme/reviewers",
        name: "Acme Reviewers",
        owner: { type: "guild", id: "guild_123", slug: "acme" },
        // storage omitted → defaults to local-fs
      },
    })
    expect(app.workspace?.schema).toBe("workspace/v1")
    expect(app.workspace?.id).toBe("@acme/reviewers")
    expect(app.workspace?.owner.type).toBe("guild")
    expect(app.workspace?.storage).toEqual({ inline: { provider: "local-fs", config: {} } })
    expect(app.workspace?.version).toBe("0.1.0")
  })

  it("carries a pre-built defineWorkspace handle through unchanged", () => {
    const ws = defineWorkspace({
      schema: "workspace/v1",
      id: "@acme/reviewers",
      name: "Acme Reviewers",
      version: "2.0.0",
      owner: { type: "org", id: "org_1", slug: "acme" },
      storage: { inline: { provider: "github", config: {} } },
    })
    const app = defineApp({ agents: [agent("solo", [])], workspace: ws })
    expect(app.workspace).toBe(ws)
    expect(app.workspace?.version).toBe("2.0.0")
  })

  it("has no workspace when none is declared", () => {
    const app = defineApp({ agents: [agent("solo", [])] })
    expect(app.workspace).toBeUndefined()
  })

  it("rejects a malformed workspace shorthand with the AIP-34 diagnostic", () => {
    expect(() =>
      defineApp({
        agents: [agent("solo", [])],
        workspace: {
          id: "no-owner-segment", // fails the @<owner>/<ws> id pattern
          name: "Bad",
          owner: { type: "guild", id: "g", slug: "acme" },
        },
      }),
    ).toThrow(/defineWorkspace \(AIP-34\)/)
  })

  it("matches string and { ref } workflow refs by the same key", () => {
    const app = defineApp({
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "reviewer",
            description: "Uses a bare-string workflow ref.",
            model: "claude-sonnet-5",
            workflows: ["review-and-fix"],
          }),
        },
      ],
      workflows: [reviewWorkflow()],
    })
    expect(app.workflows[0]!.id).toBe("review-and-fix")
  })
})
