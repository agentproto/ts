/**
 * Registers installed apps' `exposes.tools` on the /mcp gateway as
 * `<prefix>_<name>` (docs/design/exposes-tools-contract.md §3, §4).
 *
 * The gateway rebuilds its McpServer on every request, so this reads the
 * registry fresh: an `app_install` is visible to the next `tools/list` with no
 * restart. Called with the FINAL wrapped server, so `?denyTools`, `?allowTools`
 * and the AGENT's deny grants (tool-deny-gate.ts) apply to these tools like to
 * every built-in.
 *
 * An `imported:` entry behaves like the original tool: its `_meta.ui` widget
 * link is copied onto `tools/list`, and the `ui://` URIs the app lists in
 * `exposes.resources` are relayed to the import on `resources/read`. Any other
 * URI stays unknown, and `resources/list` only shows the allowlisted ones.
 */

import { z, type ZodRawShape } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
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

/** How long `tools/list` waits on an import's tool list for a `_meta.ui` link. */
const IMPORTED_META_TIMEOUT_MS = 2_000

/** An imported tool as the daemon's import registry lists it. */
export interface ImportedToolMeta {
  readonly name: string
  readonly _meta?: Record<string, unknown> | undefined
}

export interface RegisterExposedAppToolsOptions {
  readonly appRegistry: AppRegistry
  readonly mode: ExposedToolsMode
  /** The caller session's `exposedToolOptIn`. Empty/absent for a host call. */
  readonly optIn?: readonly string[] | undefined
  readonly callImportedTool?: AppToolCallDeps["callImportedTool"]
  /** An import's tool list, from the registry's cache when it holds one;
   *  undefined when the import is unknown or unreachable. */
  readonly listImportedTools?: (alias: string) => Promise<readonly ImportedToolMeta[] | undefined>
  /** Relay one `resources/read` to an import; throws when it fails. */
  readonly readImportedResource?: (alias: string, uri: string) => Promise<ReadResourceResult>
}

/** `imported:<alias>/<tool>` split, or undefined for any other id. */
function importedRef(id: string): { alias: string; tool: string } | undefined {
  if (!id.startsWith("imported:")) return undefined
  const rest = id.slice("imported:".length)
  const slash = rest.indexOf("/")
  return slash === -1 ? undefined : { alias: rest.slice(0, slash), tool: rest.slice(slash + 1) }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/** Returns the names it tried to register (a surrounding allow/deny wrapper may still drop one). */
export async function registerExposedAppTools(
  server: McpServer,
  opts: RegisterExposedAppToolsOptions,
): Promise<string[]> {

  if (opts.mode === "off") return []
  const { tools } = await planExposedTools(opts.appRegistry)
  // One tool list per alias per request, from the import registry's cache.
  const importedLists = new Map<string, Promise<readonly ImportedToolMeta[] | undefined>>()
  const importedUiMeta = async (id: string): Promise<Record<string, unknown> | undefined> => {
    const ref = importedRef(id)
    if (!ref || !opts.listImportedTools) return undefined
    let list = importedLists.get(ref.alias)
    if (!list) {
      list = withTimeout(opts.listImportedTools(ref.alias).catch(() => undefined), IMPORTED_META_TIMEOUT_MS)
      importedLists.set(ref.alias, list)
    }
    const ui = (await list)?.find(t => t.name === ref.tool)?._meta?.ui
    return typeof ui === "object" && ui !== null && !Array.isArray(ui) ? { ui } : undefined
  }
  const registered: string[] = []
  for (const planned of tools) {
    const { entry, name, appId } = planned
    const visible = exposedAccessAllowed(opts.mode, entry.access) || exposedOptInMatches(opts.optIn, name)
    if (!visible) continue
    const shape = shapeFromInputs(planned.inputs)
    const meta = await importedUiMeta(entry.id)
    try {
      server.registerTool(
        name,
        {
          description: entry.description,
          inputSchema: shape ?? GENERIC_ARGS_SHAPE,
          annotations: entry.access === "read" ? { readOnlyHint: true } : { destructiveHint: true },
          ...(meta ? { _meta: meta } : {}),
        },
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
  registerExposedAppResources(server, opts, new Set(tools.map(t => t.appId)))
  return registered
}

/**
 * Each planned app's `exposes.resources`, registered as a resource whose read
 * is relayed to the app's imported servers (the aliases of its `imported:`
 * entries, first success wins). Only these URIs are registered, so the SDK
 * answers any other `resources/read` as unknown, even one an import serves.
 */
function registerExposedAppResources(
  server: McpServer,
  opts: RegisterExposedAppToolsOptions,
  plannedAppIds: ReadonlySet<string>,
): void {
  const read = opts.readImportedResource
  if (!read) return
  for (const app of opts.appRegistry.listApps()) {
    const uris = app.exposes?.resources
    if (!uris || uris.length === 0 || !plannedAppIds.has(app.appId)) continue
    const aliases = [
      ...new Set((app.exposes?.tools ?? []).flatMap(t => importedRef(t.id)?.alias ?? [])),
    ]
    if (aliases.length === 0) continue
    for (const uri of uris) {
      try {
        server.registerResource(uri, uri, { description: `${app.appId} view, relayed from its imported MCP server.` }, async () => {
          let lastError: unknown
          for (const alias of aliases) {
            try {
              return await read(alias, uri)
            } catch (err) {
              lastError = err
            }
          }
          throw lastError instanceof Error ? lastError : new Error(`resource ${uri} could not be read.`)
        })
      } catch (err) {
        console.warn(
          `[app-exposed-tools] could not register resource "${uri}" of app "${app.appId}": ${err instanceof Error ? err.message : String(err)}.`,
        )
      }
    }
  }
}
