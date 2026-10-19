/**
 * Loads the REAL shipped `model-catalog-watch` app's `watch` WORKFLOW.md
 * (a pure declarative manifest, no `entry.mjs`) exactly as the daemon would
 * via `workflow_run_file`, and compiles + runs it end to end against a fake
 * `dispatchTool` and a fake agent host. Mirrors the pattern
 * `repo-maintenance-workflow.test.ts` uses for the sibling `repo-maintenance`
 * app. Separately validates the sibling ROUTINE.md's frontmatter against the
 * real AIP-41 schema.
 */

import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import matter from "gray-matter"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import type { AgentSessionHost } from "@agentproto/workflow-runtime"
import { routineFrontmatterSchema } from "@agentproto/routine"
import { createDaemonToolRegistry, type DispatchTool } from "../workflow-tool-registry.js"

const APP_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "model-catalog-watch",
)
const WORKFLOW_PATH = join(APP_DIR, ".agentproto", "workflows", "watch", "WORKFLOW.md")
const ROUTINE_PATH = join(APP_DIR, "routines", "model-catalog-watch-daily", "ROUTINE.md")

function mcpResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

describe("model-catalog-watch 'watch' workflow — shape", () => {
  it("loads and compiles with the expected top-level step sequence", async () => {
    const dispatchTool: DispatchTool = vi.fn(async () => mcpResult({}))
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    expect(handle.id).toBe("watch")
    const stepIds = handle.steps.map(s => `${s.id}:${s.kind}`)
    expect(stepIds).toEqual(["sync:tool", "diff:tool", "gate:gate", "digest:agent"])
    const compiled = compileWorkflow(handle, createDaemonToolRegistry(handle, dispatchTool))
    expect(compiled.id).toBe("watch")
  })
})

describe("model-catalog-watch 'watch' workflow — run", () => {
  it("feeds the diff step's structured output into the digest agent's prompt", async () => {
    const diff = {
      appeared: ["new-model"],
      removed: [],
      priceChanged: [],
      freeToPaid: [],
      paidToFree: [],
    }
    const dispatchTool: DispatchTool = vi.fn(async (name: string) => {
      if (name === "command_execute") return mcpResult({ exitCode: 0, stdout: "", stderr: "" })
      if (name === "catalog_diff") return mcpResult({ diff, asOf: "2026-10-19T00:00:00.000Z" })
      throw new Error(`unexpected tool ${name}`)
    })
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, createDaemonToolRegistry(handle, dispatchTool))

    let capturedPrompt = ""
    const host: AgentSessionHost = {
      spawn: vi.fn(async () => "sess_fake"),
      sendPromptAndWait: vi.fn(async (_sessionId: string, prompt: string) => {
        capturedPrompt = prompt
      }),
      resolveByLabel: vi.fn(() => undefined),
      readFinalMessage: vi.fn(async () => "Nothing changed."),
    }

    const { output } = await runWorkflow({ workflow: compiled, agents: host, input: {} })
    expect(output).toBeDefined()
    expect(capturedPrompt).toContain("new-model")
    expect(capturedPrompt).toContain("appeared")
  })
})

describe("model-catalog-watch-daily ROUTINE.md", () => {
  it("validates against the AIP-41 routine/v1 schema", () => {
    const raw = readFileSync(ROUTINE_PATH, "utf8")
    const { data } = matter(raw)
    const result = routineFrontmatterSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.schedule).toEqual({
        kind: "cron",
        cron: "0 6 * * *",
        timezone: "UTC",
        catchup: "skip",
      })
      expect(result.data.enabled).toBe(false)
    }
  })
})
