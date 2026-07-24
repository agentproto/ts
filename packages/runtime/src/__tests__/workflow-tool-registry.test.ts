/**
 * Proves the daemon-boot gap this file fixes: before `createDaemonToolRegistry`
 * existed, `packages/runtime/src/index.ts` compiled every WORKFLOW.md with
 * `{ tools: {}, candidates: [] }`, so a `tool` step always failed to resolve
 * ("no tool registered for '<id>'") — only agent-step workflows ran. This test
 * builds the registry the same way `index.ts` now does and runs a real
 * 2-`tool`-step workflow (with a `$steps.<id>.*` value-ref between them)
 * through the actual `compileWorkflow` + `runWorkflow` engine, dispatching
 * through a fake `dispatchTool` — no live daemon required.
 */

import { describe, it, expect, vi } from "vitest"
import { defineWorkflow } from "@agentproto/workflow"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import { createDaemonToolRegistry, type DispatchTool } from "../workflow-tool-registry.js"

/** MCP `CallToolResult` shape — what `dispatchTool` (the in-process McpServer
 *  call) actually returns, per `index.ts`'s `dispatchToolBox.fn`. */
function mcpResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

describe("createDaemonToolRegistry", () => {
  it("compiles + runs a 2-tool-step WORKFLOW.md, threading $steps refs through dispatchTool", async () => {
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "demo.step-one") return mcpResult({ n: (inputs.n as number) * 2 })
      if (name === "demo.step-two") return mcpResult({ n: (inputs.n as number) + 10 })
      throw new Error(`unexpected tool '${name}'`)
    })

    const handle = defineWorkflow({
      name: "Double then add via daemon dispatch",
      id: "daemon-double-add",
      description: "Double the input via one daemon tool, then add ten via another.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        { id: "one", kind: "tool", tool: "demo.step-one", inputs: { n: "$input.n" } },
        { id: "two", kind: "tool", tool: "demo.step-two", inputs: { n: "$steps.one.n" } },
      ],
    })

    const registry = createDaemonToolRegistry(handle, dispatchTool)
    const compiled = compileWorkflow(handle, registry)
    const { output } = await runWorkflow({ workflow: compiled, input: { n: 5 } })

    expect((output as { n: number }).n).toBe(20) // 5 → double 10 → +10 → 20
    expect(calls).toEqual([
      { name: "demo.step-one", inputs: { n: 5 } },
      { name: "demo.step-two", inputs: { n: 10 } },
    ])
  })

  it("surfaces a dispatchTool isError result as a thrown step failure", async () => {
    const dispatchTool: DispatchTool = vi.fn(async () => ({
      content: [{ type: "text", text: "boom: worktree is dirty" }],
      isError: true,
    }))

    const handle = defineWorkflow({
      name: "Failing dispatch",
      id: "daemon-fail",
      description: "A single tool step whose dispatch reports isError.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [{ id: "one", kind: "tool", tool: "demo.fails", inputs: {} }],
    })

    const compiled = compileWorkflow(handle, createDaemonToolRegistry(handle, dispatchTool))
    await expect(runWorkflow({ workflow: compiled, input: {} })).rejects.toThrow(
      /boom: worktree is dirty/,
    )
  })

  it("returns an empty registry for a workflow with no tool steps — unaffected by this change", () => {
    const handle = defineWorkflow({
      name: "No tools",
      id: "no-tools",
      description: "A suspend step only — no tool steps at all.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [{ id: "wait", kind: "suspend", resume: { on: ["human:ack"] } }],
    })

    const registry = createDaemonToolRegistry(handle, vi.fn())
    expect(registry.tools).toEqual({})
    expect(registry.candidates).toEqual([])
  })
})
