import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { defineAgent } from "@agentproto/agent"
import { parseAgentManifest } from "@agentproto/agent/manifest"
import { defineWorkflow } from "@agentproto/workflow"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { parseWorkspaceManifest } from "@agentproto/workspace/manifest"
import { defineApp } from "../define-app.js"

const reviewerBody =
  "You are a rigorous reviewer.\nReport findings. Change nothing.\nNever run gh pr merge."

function buildApp() {
  return defineApp({
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "@agentik/reviewer",
          description: "A PR reviewer bundled with its review workflow.",
          model: "claude-sonnet-5",
          boundaries: ["Never run gh pr merge"],
          workflows: [{ ref: "review-and-fix" }],
        }),
        body: reviewerBody,
      },
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "fixer",
          description: "Applies a fix (no body — prompt composes).",
          model: "claude-sonnet-5",
          workflows: [{ ref: "review-and-fix" }],
        }),
      },
    ],
    workflows: [
      defineWorkflow({
        id: "review-and-fix",
        name: "Review and fix",
        description: "Read the diff, report findings.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [
          { id: "review", kind: "tool", tool: "read_diff" },
          { id: "report", kind: "tool", tool: "post_review" },
        ],
      }),
    ],
  })
}

describe("emit — manifests round-trip through the loaders", () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-kit-emit-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("writes one AGENT.md per agent, body = the system prompt, frontmatter re-parses", async () => {
    const app = buildApp()
    const { agentPaths, workflowPaths } = await app.emit(dir)

    expect(Object.keys(agentPaths).sort()).toEqual(["@agentik/reviewer", "fixer"])
    expect(agentPaths["@agentik/reviewer"]).toMatch(/\.agentproto\/agents\/reviewer\/AGENT\.md$/)
    expect(workflowPaths).toHaveLength(1)

    const reviewer = parseAgentManifest(await readFile(agentPaths["@agentik/reviewer"]!, "utf8"))
    expect(reviewer.frontmatter.id).toBe("@agentik/reviewer")
    expect(reviewer.frontmatter.schema).toBe("agent/v1")
    // The AGENT.md body IS the system prompt (AIP-42).
    expect(reviewer.body.trim()).toBe(reviewerBody.trim())

    // The body-less agent emits an empty body and still re-parses.
    const fixer = parseAgentManifest(await readFile(agentPaths["fixer"]!, "utf8"))
    expect(fixer.frontmatter.id).toBe("fixer")
    expect(fixer.body.trim()).toBe("")
  })

  it("writes a shared WORKFLOW.md that loadWorkflowHandle resolves with matching steps", async () => {
    const app = buildApp()
    const { workflowPaths } = await app.emit(dir)
    expect(workflowPaths[0]).toMatch(/\.agentproto\/workflows\/review-and-fix\/WORKFLOW\.md$/)

    const handle = await loadWorkflowHandle(workflowPaths[0]!)
    expect(handle.id).toBe("review-and-fix")
    expect(handle.steps.map((s) => `${s.id}:${s.kind}`)).toEqual([
      "review:tool",
      "report:tool",
    ])
  })

  it("writes a root WORKSPACE.md (AIP-34) that parseWorkspaceManifest re-parses", async () => {
    const app = defineApp({
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "@acme/reviewer",
            description: "A reviewer in a workspace.",
            model: "claude-sonnet-5",
          }),
          body: "Review.",
        },
      ],
      workspace: {
        id: "@acme/reviewers",
        name: "Acme Reviewers",
        owner: { type: "guild", id: "guild_123", slug: "acme" },
      },
    })
    const { workspacePath, agentPaths } = await app.emit(dir)

    // WORKSPACE.md is the ROOT manifest; agents live under .agentproto/.
    expect(workspacePath).toMatch(/\/WORKSPACE\.md$/)
    expect(workspacePath).not.toMatch(/\.agentproto\//)
    expect(agentPaths["@acme/reviewer"]).toMatch(/\.agentproto\/agents\/reviewer\/AGENT\.md$/)

    const ws = parseWorkspaceManifest(await readFile(workspacePath!, "utf8"))
    expect(ws.frontmatter.schema).toBe("workspace/v1")
    expect(ws.frontmatter.id).toBe("@acme/reviewers")
    expect(ws.frontmatter.owner.type).toBe("guild")
    expect(ws.frontmatter.storage).toEqual({ inline: { provider: "local-fs", config: {} } })
  })

  it("omits WORKSPACE.md when the app has no workspace", async () => {
    const { workspacePath } = await buildApp().emit(dir)
    expect(workspacePath).toBeUndefined()
  })

  it("always writes a root APP.md with schema/agents/workflows refs relative to dir", async () => {
    const app = buildApp()
    const { appPath, agentPaths, workflowPaths } = await app.emit(dir)

    expect(appPath).toMatch(/\.agentproto\/APP\.md$/)
    const parsed = matter(await readFile(appPath, "utf8"))
    expect(parsed.data.schema).toBe("app/v1")
    expect(parsed.data.version).toBe("0.1.0")
    expect(parsed.data.id).toBeUndefined()
    expect(parsed.data.workspace).toBeUndefined()

    expect(parsed.data.agents).toEqual([
      { id: "@agentik/reviewer", path: ".agentproto/agents/reviewer/AGENT.md" },
      { id: "fixer", path: ".agentproto/agents/fixer/AGENT.md" },
    ])
    expect(parsed.data.workflows).toEqual([
      { id: "review-and-fix", path: ".agentproto/workflows/review-and-fix/WORKFLOW.md" },
    ])
    // The relative paths in APP.md must actually resolve to what emit wrote.
    expect(join(dir, parsed.data.agents[0].path)).toBe(agentPaths["@agentik/reviewer"])
    expect(join(dir, parsed.data.workflows[0].path)).toBe(workflowPaths[0])
  })

  it("writes app identity + the workspace id into APP.md when the app declares them", async () => {
    const app = defineApp({
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "@acme/reviewer",
            description: "A reviewer in a workspace.",
            model: "claude-sonnet-5",
          }),
          body: "Review.",
        },
      ],
      workspace: {
        id: "@acme/reviewers",
        name: "Acme Reviewers",
        owner: { type: "guild", id: "guild_123", slug: "acme" },
      },
      id: "@acme/reviewer-app",
      name: "Reviewer App",
      description: "Reviews PRs.",
    })
    const { appPath } = await app.emit(dir)
    const parsed = matter(await readFile(appPath, "utf8"))

    expect(parsed.data.id).toBe("@acme/reviewer-app")
    expect(parsed.data.name).toBe("Reviewer App")
    expect(parsed.data.version).toBe("0.1.0")
    expect(parsed.data.description).toBe("Reviews PRs.")
    expect(parsed.data.workspace).toBe("@acme/reviewers")
    // Body = the app description.
    expect(parsed.content.trim()).toBe("Reviews PRs.")
  })
})
