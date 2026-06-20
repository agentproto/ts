/**
 * self_inspect — MCP tool that lets an agent query its own AIP-42 manifest
 * without knowing its disk path.
 *
 * The agent supplies its logical `id`; the runtime resolves
 * `<workspace>/.agents/<id>/AGENT.md`, loads it via `agentVerbs`, resolves
 * each tool and routine ref to a `{ id, description }` summary, and returns
 * `{ agentPath, tools, routines }`.
 *
 * Injection mechanism: the workspace path is captured in the
 * `registerSelfInspectTool` closure at server-creation time (same pattern as
 * `registerFsTools`). The agent provides its logical id (known from its own
 * system-prompt frontmatter) — not an absolute path.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { join } from "node:path"
import { agentVerbs } from "@agentproto/agent"
import { toolVerbs } from "@agentproto/tool"
import { routineVerbs } from "@agentproto/routine"

export interface RefSummary {
  id: string
  description: string
}

export interface SelfInspectResult {
  agentPath: string
  tools: RefSummary[]
  routines: RefSummary[]
}

/**
 * Reduce one AIP-27 ref block (from an agent's `tools[]`) to `{id, description}`.
 *
 * - `file:` → load the TOOL.md and extract `id` + `description` from the handle.
 *   `baseDir` is the workspace root (tools live at `<workspace>/tools/<id>/TOOL.md`
 *   by the AIP-14 `pathOf` convention, or wherever the file pointer says).
 * - `inline:` → use the inline params directly.
 * - `ref:` or `string` → surface the ref identifier as the id (registry resolution
 *   requires an external resolver not available here at inspect time).
 */
export async function summarizeToolRef(
  raw: unknown,
  workspace: string,
): Promise<RefSummary> {
  if (typeof raw === "string") {
    return { id: raw, description: "(string ref — not locally resolved)" }
  }
  if (typeof raw !== "object" || raw === null) {
    return { id: String(raw), description: "(unknown ref shape)" }
  }
  const block = raw as { ref?: string; file?: string; inline?: Record<string, unknown> }
  if (block.file) {
    try {
      const handle = await toolVerbs.resolve(
        { file: block.file },
        { baseDir: workspace },
      )
      return { id: handle.id, description: handle.description ?? "" }
    } catch {
      return { id: block.file, description: "(file ref — could not load)" }
    }
  }
  if (block.inline) {
    return {
      id: String(block.inline.id ?? ""),
      description: String(block.inline.description ?? ""),
    }
  }
  if (block.ref) {
    return { id: block.ref, description: "(ref — not locally resolved)" }
  }
  return { id: JSON.stringify(raw), description: "(unknown ref shape)" }
}

/**
 * Same logic for AIP-41 routine refs. Routines live at
 * `<workspace>/.routines/<id>/ROUTINE.md` by `routineSpec.pathOf` convention.
 */
export async function summarizeRoutineRef(
  raw: unknown,
  workspace: string,
): Promise<RefSummary> {
  if (typeof raw === "string") {
    return { id: raw, description: "(string ref — not locally resolved)" }
  }
  if (typeof raw !== "object" || raw === null) {
    return { id: String(raw), description: "(unknown ref shape)" }
  }
  const block = raw as { ref?: string; file?: string; inline?: Record<string, unknown> }
  if (block.file) {
    try {
      const handle = await routineVerbs.resolve(
        { file: block.file },
        { baseDir: workspace },
      )
      return { id: handle.id, description: handle.description ?? "" }
    } catch {
      return { id: block.file, description: "(file ref — could not load)" }
    }
  }
  if (block.inline) {
    return {
      id: String(block.inline.id ?? ""),
      description: String(block.inline.description ?? ""),
    }
  }
  if (block.ref) {
    return { id: block.ref, description: "(ref — not locally resolved)" }
  }
  return { id: JSON.stringify(raw), description: "(unknown ref shape)" }
}

/**
 * Core logic, extracted for testability.
 * Throws with `{ error, message }` on `agent_not_found`.
 */
export async function selfInspect(
  agentId: string,
  workspace: string,
): Promise<SelfInspectResult> {
  const agentPath = join(workspace, ".agents", agentId, "AGENT.md")

  let handle: Awaited<ReturnType<typeof agentVerbs.load>>["handle"]
  try {
    const result = await agentVerbs.load(agentPath)
    handle = result.handle
  } catch (err) {
    const e = new Error(
      `No AGENT.md found for agent '${agentId}' at '${agentPath}'. ` +
        `Ensure an AGENT.md exists at <workspace>/.agents/${agentId}/AGENT.md.`,
    )
    ;(e as NodeJS.ErrnoException).code = "agent_not_found"
    throw e
  }

  const rawTools = (handle.tools ?? []) as unknown[]
  const rawRoutines = (handle.routines ?? []) as unknown[]

  const [tools, routines] = await Promise.all([
    Promise.all(rawTools.map((r) => summarizeToolRef(r, workspace))),
    Promise.all(rawRoutines.map((r) => summarizeRoutineRef(r, workspace))),
  ])

  return { agentPath, tools, routines }
}

/**
 * Register the `self_inspect` MCP tool on `server`.
 *
 * The workspace path is injected at registration time; the agent only needs to
 * supply its logical `id` at call time — not a disk path. This is called from
 * `createMcpServer` whenever a workspace is provided.
 */
export function registerSelfInspectTool(
  server: McpServer,
  opts: { workspace: string },
): void {
  server.tool(
    "self_inspect",
    "Return this agent's AIP-42 manifest summary (tools + routines) without requiring knowledge of disk paths. " +
      "Pass the agent's logical `id` (the `id:` field in its AGENT.md frontmatter); the runtime resolves it to " +
      "`<workspace>/.agents/<agentId>/AGENT.md`. Returns `{ agentPath, tools, routines }` — each item has at " +
      "minimum `{ id, description }`. File refs are loaded; string/ref refs are surfaced as-is.",
    {
      agentId: z
        .string()
        .min(1)
        .describe(
          "The agent's logical id (e.g. 'writer'). Matches the `id:` field in the AGENT.md frontmatter. " +
            "The runtime resolves this to `<workspace>/.agents/<agentId>/AGENT.md` — " +
            "you do not need to know the absolute disk path.",
        ),
    },
    async ({ agentId }) => {
      try {
        const result = await selfInspect(agentId, opts.workspace)
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "agent_not_found", message }, null, 2),
            },
          ],
          isError: true,
        }
      }
    },
  )
}
