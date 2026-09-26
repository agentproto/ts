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
import { defineTool } from "@agentproto/tool"
import { defineWorkflow } from "@agentproto/workflow"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import type { DriverHandle, ExecuteFn } from "@agentproto/driver"
import {
  createDaemonToolRegistry,
  mergeAppAndDaemonToolRegistry,
  type AppToolRegistry,
  type DispatchTool,
} from "../workflow-tool-registry.js"

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

/** A minimal, directly-constructed DriverHandle (no `defineDriver` call
 *  needed) implementing exactly one tool id — stands in for an app-bundled
 *  driver `loadAppBundledTools` would have produced from a real DRIVER.md. */
function fakeDriver(id: string, toolId: string, execute: DriverHandle["execute"][string]): DriverHandle {
  return {
    id,
    name: id,
    description: `Fake driver '${id}' for tests.`,
    kind: "builtin",
    implements: [{ tool: toolId, version: "*" }],
    execute: { [toolId]: execute },
    install: [],
    network: { egress: [], ingress: [] },
    region: ["global"],
    policyTags: [],
    tags: [],
    metadata: {},
  }
}

describe("mergeAppAndDaemonToolRegistry (BRIEF-D)", () => {
  it("passes the daemon registry through unchanged when the app registry is undefined", () => {
    const handle = defineWorkflow({
      name: "One tool",
      id: "merge-none",
      description: "A single daemon-dispatched tool step.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [{ id: "one", kind: "tool", tool: "demo.step" }],
    })
    const daemon = createDaemonToolRegistry(handle, vi.fn())
    const merged = mergeAppAndDaemonToolRegistry(daemon, undefined)
    expect(merged.tools).toBe(daemon.tools)
    expect(merged.candidates).toBe(daemon.candidates)
  })

  it("an app tool id wins over a daemon tool of the same id, and onOverride fires once", async () => {
    const dispatchTool: DispatchTool = vi.fn(async () => {
      throw new Error("daemon dispatch should never run — the app driver should win")
    })

    const handle = defineWorkflow({
      name: "App override",
      id: "merge-override",
      description: "A single tool step whose id an app tool bundles too.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [{ id: "one", kind: "tool", tool: "shared.tool", inputs: { n: "$input.n" } }],
    })

    const daemonRegistry = createDaemonToolRegistry(handle, dispatchTool)
    expect(Object.keys(daemonRegistry.tools)).toEqual(["shared.tool"])

    const appTool = defineTool({
      id: "shared.tool",
      name: "Shared tool",
      description: "An app-bundled tool with the same id as a daemon tool.",
      version: "1.0.0",
    })
    const appDriverExecute: ExecuteFn = vi.fn(async ({ input }) => ({
      n: (input as { n: number }).n * 100,
    }))
    const appRegistry: AppToolRegistry = {
      tools: { "shared.tool": appTool },
      candidates: [fakeDriver("app-driver", "shared.tool", appDriverExecute)],
    }

    const overridden: string[] = []
    const merged = mergeAppAndDaemonToolRegistry(daemonRegistry, appRegistry, {
      onOverride: id => overridden.push(id),
    })
    expect(overridden).toEqual(["shared.tool"])
    // The catch-all daemon driver dropped out entirely — its only id was overridden.
    expect(merged.candidates).toHaveLength(1)
    expect(merged.candidates[0]!.id).toBe("app-driver")

    const compiled = compileWorkflow(handle, merged)
    const { output } = await runWorkflow({ workflow: compiled, input: { n: 3 } })
    expect((output as { n: number }).n).toBe(300)
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it("a mixed workflow still dispatches a non-overridden id through the daemon passthrough", async () => {
    const calls: string[] = []
    const dispatchTool: DispatchTool = vi.fn(async name => {
      calls.push(name)
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] }
    })

    const handle = defineWorkflow({
      name: "Mixed",
      id: "merge-mixed",
      description: "One app tool step and one daemon-only tool step.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        { id: "app-step", kind: "tool", tool: "app.only" },
        { id: "daemon-step", kind: "tool", tool: "daemon.only" },
      ],
    })

    const daemonRegistry = createDaemonToolRegistry(handle, dispatchTool)
    const appTool = defineTool({
      id: "app.only",
      name: "App only",
      description: "Only the app implements this id.",
      version: "1.0.0",
    })
    const appExecute: ExecuteFn = async () => ({ ok: true })
    const appRegistry: AppToolRegistry = {
      tools: { "app.only": appTool },
      candidates: [fakeDriver("app-driver", "app.only", appExecute)],
    }

    const merged = mergeAppAndDaemonToolRegistry(daemonRegistry, appRegistry)
    // The daemon catch-all driver keeps 'daemon.only' — 'app.only' was stripped out of it.
    const daemonCandidate = merged.candidates.find(c => c.id === "daemon-tool-dispatch")!
    expect(daemonCandidate.implements.map(e => e.tool)).toEqual(["daemon.only"])

    const compiled = compileWorkflow(handle, merged)
    await runWorkflow({ workflow: compiled, input: {} })
    expect(calls).toEqual(["daemon.only"])
  })
})
