/**
 * Registers installed apps' `exposes.tools` on the /mcp gateway as
 * `<prefix>_<name>` (docs/design/exposes-tools-contract.md §3, §4).
 *
 * The gateway rebuilds its McpServer on every request, so this reads the
 * registry fresh: an `app_install` is visible to the next `tools/list` with no
 * restart. Called with the FINAL wrapped server, so `?denyTools`, `?allowTools`
 * and the AGENT's deny grants (tool-deny-gate.ts) apply to these tools like to
 * every built-in.
 */

import { z, type ZodRawShape } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { AppRegistry } from "./app-registry.js"
import { performExposedToolCall, type AppToolCallDeps } from "./app-tools.js"
import {
  exposedAccessAllowed,
  exposedOptInMatches,
  planExposedTools,
  type ExposedToolsMode,
} from "./exposed-tools-policy.js"

const GENERIC_ARGS_SHAPE: ZodRawShape = {
  args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the underlying tool."),
}

/** A JSON-Schema object's properties as a zod raw shape; undefined when it is not a flat object schema. */
function shapeFromInputs(inputs: Record<string, unknown> | undefined): ZodRawShape | undefined {
  if (!inputs) return undefined
  try {
    const schema = z.fromJSONSchema(inputs as Parameters<typeof z.fromJSONSchema>[0]) as { shape?: unknown }
    return schema.shape && typeof schema.shape === "object" ? (schema.shape as ZodRawShape) : undefined
  } catch {
    return undefined
  }
}

export interface RegisterExposedAppToolsOptions {
  readonly appRegistry: AppRegistry
  readonly mode: ExposedToolsMode
  /** The caller session's `exposedToolOptIn`. Empty/absent for a host call. */
  readonly optIn?: readonly string[] | undefined
  readonly callImportedTool?: AppToolCallDeps["callImportedTool"]
}

/** Returns the names it tried to register (a surrounding allow/deny wrapper may still drop one). */
export async function registerExposedAppTools(
  server: McpServer,
  opts: RegisterExposedAppToolsOptions,
): Promise<string[]> {

  if (opts.mode === "off") return []
  const { tools } = await planExposedTools(opts.appRegistry)
  const registered: string[] = []
  for (const planned of tools) {
    const { entry, name, appId } = planned
    const visible = exposedAccessAllowed(opts.mode, entry.access) || exposedOptInMatches(opts.optIn, name)
    if (!visible) continue
    const shape = shapeFromInputs(planned.inputs)
    try {
      server.tool(
        name,
        entry.description,
        shape ?? GENERIC_ARGS_SHAPE,
        entry.access === "read" ? { readOnlyHint: true } : { destructiveHint: true },
        async (input: Record<string, unknown>) =>
          performExposedToolCall(
            opts.appRegistry,
            {
              appId,
              id: entry.id,
              args: shape ? input : ((input.args as Record<string, unknown> | undefined) ?? {}),
            },
            { ...(opts.callImportedTool ? { callImportedTool: opts.callImportedTool } : {}) },
          ),
      )
      registered.push(name)
    } catch (err) {
      console.warn(
        `[app-exposed-tools] could not register "${name}" of app "${appId}": ${err instanceof Error ? err.message : String(err)}.`,
      )
    }
  }
  return registered
}
