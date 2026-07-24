/**
 * Loads the REAL shipped dogfood workflow (`packages/worktree/routines/
 * worktree-gc-notify/WORKFLOW.md` + its `entry.mjs`) exactly as the daemon
 * would via `workflow_run_file`, and runs it end to end against a fake
 * `dispatchTool` — no live daemon, no real `worktree_gc` execution, no
 * network call to hosted agentpush. Proves the three tool/transform steps
 * (`gc` → `format` → `notify`) actually compile and thread data correctly,
 * not just that the files parse.
 */

import { describe, it, expect, vi } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import { createDaemonToolRegistry, type DispatchTool } from "../workflow-tool-registry.js"

const WORKFLOW_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "worktree",
  "routines",
  "worktree-gc-notify",
  "WORKFLOW.md",
)

function mcpResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

describe("worktree-gc-notify dogfood workflow", () => {
  it("loads, compiles, and runs gc → format → notify end to end", async () => {
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "worktree_gc") {
        return mcpResult({
          mode: "apply",
          outcomes: [
            { path: "/repo/_worktrees/a", branch: "wt/a", result: "reclaimed" },
            { path: "/repo/_worktrees/b", branch: "wt/b", result: "held" },
          ],
        })
      }
      if (name === "command_execute") {
        return mcpResult({ exitCode: 0, stdout: "", stderr: "" })
      }
      throw new Error(`unexpected tool '${name}'`)
    })

    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, createDaemonToolRegistry(handle, dispatchTool))
    await runWorkflow({ workflow: compiled, input: {} })

    expect(calls).toHaveLength(2)
    expect(calls[0]!.name).toBe("worktree_gc")
    expect(calls[0]!.inputs).toEqual({
      apply: true,
      salvageDirty: false,
      repoRoot:
        "/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentproto/ts",
    })

    expect(calls[1]!.name).toBe("command_execute")
    expect(calls[1]!.inputs.command).toBe("bash")
    const stdin = calls[1]!.inputs.stdin as string
    const body = JSON.parse(stdin)
    expect(body.to).toEqual({ channel: "telegram", address: "6371794295" })
    expect(body.content.text).toMatch(/worktree-gc/)
    expect(body.content.text).toMatch(/1 reclaimed/)
    expect(body.content.text).toMatch(/1 held/)
    expect(body.content.text).toMatch(/reaped: wt\/a/)
  })
})
