/**
 * Bridges AIP-15 WORKFLOW.md `tool` steps to the daemon's ONE tool
 * surface — `dispatchTool`, the same in-process McpServer dispatch the
 * AIP-41 routine registrar (`routine-registrar.ts`) and the cron
 * scheduler (`cron-scheduler.ts`) already use for `kind:"tool"` actions.
 *
 * `compileWorkflow` (`@agentproto/workflow-runtime`) needs a `tools`
 * lookup (id → `ToolHandle`) and `candidates` (`DriverHandle[]`) to
 * resolve every `tool` step — see `compileWorkflow`'s `no tool
 * registered for '<id>'` error. Before this file, the daemon compiled
 * every WORKFLOW.md with `{ tools: {}, candidates: [] }`, so that error
 * fired for ANY `tool` step; only agent-step workflows ran.
 *
 * Rather than hand-author a typed `ToolHandle`/`DriverHandle` pair per
 * daemon tool (worktree_gc, command_execute, agent_start, …), this scans
 * the workflow's own step graph for the tool ids it actually references
 * and synthesizes passthrough contracts for exactly those — no schema
 * validation beyond what the dispatched daemon tool already does itself,
 * and no second dispatch path: every synthesized driver body ends in the
 * same `dispatchTool(name, inputs)` call as the routine/cron bridge.
 */

import { normalizeToolId, type DriverHandle, type ExecuteFn } from "@agentproto/driver"
import type { ToolHandle } from "@agentproto/tool"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { CompileWorkflowOptions } from "@agentproto/workflow-runtime"

export type DispatchTool = (
  name: string,
  inputs: Record<string, unknown>,
) => Promise<unknown>

type AnyStep = WorkflowHandle["steps"][number]

/** Recursively collect every `tool` step's normalized tool id in the step graph. */
function collectToolIds(steps: readonly AnyStep[], out: Set<string>): void {
  for (const step of steps) {
    switch (step.kind) {
      case "tool": {
        const ref = typeof step.tool === "string" ? step.tool : step.tool.entry
        out.add(normalizeToolId(ref))
        break
      }
      case "map":
      case "loop":
        collectToolIds(step.steps, out)
        break
      case "parallel":
        for (const branch of step.branches) collectToolIds(branch.steps, out)
        break
      default:
        break
    }
  }
}

/** A no-schema contract: the dispatched daemon tool validates its own input/output. */
function passthroughToolHandle(id: string): ToolHandle {
  return {
    id,
    name: id,
    description: `Daemon tool '${id}', dispatched via the routine/cron dispatchTool bridge.`,
    mutates: [],
    requires: { network: [], secrets: [], tools: [] },
    approval: "auto",
    riskLevel: 0,
    costClass: "trivial",
    timeoutMs: 30_000,
    tags: [],
    metadata: {},
    idempotent: false,
    driverConstraints: { forbid: [], requireKind: [] },
  }
}

/**
 * Unwrap the MCP `CallToolResult` shape `dispatchTool` returns (an
 * in-process call into a registered `server.tool(...)` handler) into a
 * plain value a later step's `$steps.<id>.*` ref can dot into. Mirrors
 * `cron-scheduler.ts`'s `summarizeToolResult`, but keeps the parsed value
 * instead of collapsing it to an ok/summary pair.
 */
function unwrapDispatchResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("content" in result)) return result
  const r = result as { content?: Array<{ text?: string }>; isError?: boolean }
  const text = (r.content ?? []).map(c => c.text ?? "").join("\n").trim()
  if (r.isError) throw new Error(text || "tool call failed")
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Build `compileWorkflow`'s `{ tools, candidates }` for one `WorkflowHandle`,
 * covering exactly the tool ids its steps reference (nested inside `map` /
 * `loop` / `parallel` bodies too). Empty when the workflow has no `tool`
 * steps, so agent-step-only workflows compile exactly as before.
 */
export function createDaemonToolRegistry(
  handle: WorkflowHandle,
  dispatchTool: DispatchTool,
): CompileWorkflowOptions {
  const toolIds = new Set<string>()
  collectToolIds(handle.steps, toolIds)

  const tools: Record<string, ToolHandle> = {}
  const execute: Record<string, ExecuteFn> = {}
  for (const id of toolIds) {
    tools[id] = passthroughToolHandle(id)
    execute[id] = async ({ input }) =>
      unwrapDispatchResult(await dispatchTool(id, (input ?? {}) as Record<string, unknown>))
  }

  if (toolIds.size === 0) return { tools, candidates: [] }

  const daemonDriver: DriverHandle = {
    id: "daemon-tool-dispatch",
    name: "Daemon tool dispatch",
    description:
      "Catch-all AIP-30 provider routing every referenced WORKFLOW.md tool step through the daemon's dispatchTool.",
    kind: "builtin",
    implements: [...toolIds].map(id => ({ tool: id, version: "*" })),
    execute,
    install: [],
    network: { egress: [], ingress: [] },
    region: ["global"],
    policyTags: [],
    tags: [],
    metadata: {},
  }

  return { tools, candidates: [daemonDriver] }
}
