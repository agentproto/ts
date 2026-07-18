import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineAgent } from "@agentproto/agent"
import { parseAgentManifest } from "@agentproto/agent/manifest"
import { defineWorkflow } from "@agentproto/workflow"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { defineApp } from "../define-app.js"

const systemPrompt =
  "You are a rigorous reviewer.\nReport findings. Change nothing.\nNever run gh pr merge."

function buildApp() {
  return defineApp({
    agent: defineAgent({
      schema: "agent/v1",
      id: "@agentik/reviewer",
      description: "A PR reviewer agent bundled with its review workflow.",
      model: "claude-sonnet-5",
      boundaries: ["Never run gh pr merge"],
      workflows: [{ ref: "review-and-fix" }],
    }),
    systemPrompt,
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

  it("writes AGENT.md whose body is the system prompt and frontmatter re-parses", async () => {
    const app = buildApp()
    const { agentPath, workflowPaths } = await app.emit(dir)

    expect(agentPath).toMatch(/\.agents\/reviewer\/AGENT\.md$/)
    expect(workflowPaths).toHaveLength(1)

    const raw = await readFile(agentPath, "utf8")
    const parsed = parseAgentManifest(raw)
    expect(parsed.frontmatter.id).toBe("@agentik/reviewer")
    expect(parsed.frontmatter.schema).toBe("agent/v1")
    // The AGENT.md body IS the system prompt (AIP-42).
    expect(parsed.body.trim()).toBe(systemPrompt.trim())
  })

  it("writes a WORKFLOW.md that loadWorkflowHandle resolves with matching steps", async () => {
    const app = buildApp()
    const { workflowPaths } = await app.emit(dir)

    const handle = await loadWorkflowHandle(workflowPaths[0]!)
    expect(handle.id).toBe("review-and-fix")
    expect(handle.steps.map((s) => `${s.id}:${s.kind}`)).toEqual([
      "review:tool",
      "report:tool",
    ])
  })
})
