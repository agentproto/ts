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

  it("carries optional app identity through to the handle, defaulting version when id is set", () => {
    const app = defineApp({
      agents: [agent("solo", [])],
      id: "@acme/reviewers-app",
      name: "Reviewers",
      description: "A reviewer app.",
    })
    expect(app.id).toBe("@acme/reviewers-app")
    expect(app.name).toBe("Reviewers")
    expect(app.version).toBe("0.1.0")
    expect(app.description).toBe("A reviewer app.")
  })

  it("keeps an explicit version instead of the default when id is set", () => {
    const app = defineApp({ agents: [agent("solo", [])], id: "app-1", version: "2.3.0" })
    expect(app.version).toBe("2.3.0")
  })

  it("leaves id/name/version/description undefined when none is given", () => {
    const app = defineApp({ agents: [agent("solo", [])] })
    expect(app.id).toBeUndefined()
    expect(app.name).toBeUndefined()
    expect(app.version).toBeUndefined()
    expect(app.description).toBeUndefined()
  })

  it("throws on an empty (but present) app id", () => {
    expect(() => defineApp({ agents: [agent("solo", [])], id: "  " })).toThrow(AppDefinitionError)
  })

  it("carries ui/artifacts/dev through to the handle, frozen", () => {
    const app = defineApp({
      agents: [agent("solo", [])],
      ui: {
        html: "<html><body>Hi</body></html>",
        title: "Solo Panel",
        tools: ["read_file"],
        csp: { connectDomains: ["api.example.com"] },
      },
      artifacts: [{ type: "report", description: "A generated report." }],
      dev: {
        launch: [{ name: "dev", runtimeExecutable: "node", runtimeArgs: ["server.js"], port: 3000 }],
      },
    })
    expect(app.ui?.title).toBe("Solo Panel")
    expect(app.ui?.tools).toEqual(["read_file"])
    expect(app.ui?.csp).toEqual({ connectDomains: ["api.example.com"] })
    expect(app.artifacts).toEqual([{ type: "report", description: "A generated report." }])
    expect(app.dev?.launch).toEqual([
      { name: "dev", runtimeExecutable: "node", runtimeArgs: ["server.js"], port: 3000 },
    ])
    expect(Object.isFrozen(app.ui)).toBe(true)
    expect(Object.isFrozen(app.artifacts)).toBe(true)
    expect(Object.isFrozen(app.artifacts![0])).toBe(true)
    expect(Object.isFrozen(app.dev)).toBe(true)
    expect(Object.isFrozen(app.dev!.launch)).toBe(true)
    expect(Object.isFrozen(app.dev!.launch[0])).toBe(true)
  })

  it("throws when ui.html is missing or empty", () => {
    expect(() =>
      defineApp({ agents: [agent("solo", [])], ui: { html: "" } }),
    ).toThrow(/ui\.html/)
    expect(() =>
      defineApp({ agents: [agent("solo", [])], ui: { html: "   " } }),
    ).toThrow(/ui\.html/)
  })

  it("throws when dev.launch is present but empty", () => {
    expect(() =>
      defineApp({ agents: [agent("solo", [])], dev: { launch: [] } }),
    ).toThrow(/dev\.launch/)
  })

  it("leaves ui/artifacts/dev undefined when none given", () => {
    const app = defineApp({ agents: [agent("solo", [])] })
    expect(app.ui).toBeUndefined()
    expect(app.artifacts).toBeUndefined()
    expect(app.dev).toBeUndefined()
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
