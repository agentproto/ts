/**
 * `defaults.apps.exposedTools`: the operator kill-switch for installed apps'
 * `exposes.tools` on the /mcp gateway. Read per request, like
 * `resolveMcpConfig`, so a `config_set` applies to the next call.
 *
 *   "read" (default)  access: read for every caller; write/approve only for a
 *                     caller whose AGENT.md opted in
 *   "off"             nothing is registered
 *   "all"             every declared tool, for every caller
 */

import { existsSync } from "node:fs"
import {
  exposedToolName,
  loadAppBundledTools,
  parseExposedTools,
  type AppExposedTool,
  type AppExposedToolAccess,
} from "@agentproto/app"
import type { AppRegistry } from "./app-registry.js"
import { loadConfig } from "./config.js"
import { DAEMON_TOOL_NAMES } from "./daemon-tool-names.generated.js"
import type { SpawnDefaultsConfig } from "./spawn-defaults.js"

export type ExposedToolsMode = "off" | "read" | "all"

export const DEFAULT_EXPOSED_TOOLS_MODE: ExposedToolsMode = "read"

export async function resolveExposedToolsMode(
  loadCfg: () => Promise<{ defaults?: SpawnDefaultsConfig }> = loadConfig,
): Promise<ExposedToolsMode> {
  try {
    const value = (await loadCfg()).defaults?.apps?.exposedTools
    return value === "off" || value === "all" ? value : DEFAULT_EXPOSED_TOOLS_MODE
  } catch {
    return DEFAULT_EXPOSED_TOOLS_MODE
  }
}

/** Whether `mode` lets a caller with no opt-in reach a tool of this access class. */
export function exposedAccessAllowed(mode: ExposedToolsMode, access: AppExposedToolAccess): boolean {
  return mode === "all" || (mode === "read" && access === "read")
}

/** Whether an AGENT opt-in list names this MCP tool (exact match: the AGENT.md `allow` pattern has no wildcard). */
export function exposedOptInMatches(optIn: readonly string[] | undefined, name: string): boolean {
  return optIn?.includes(name) ?? false
}

export interface PlannedExposedTool {
  readonly appId: string
  readonly entry: AppExposedTool
  /** The MCP name, from `exposedToolName`. */
  readonly name: string
  /** `entry.inputSchema`, else the bundled TOOL.md `inputs`. */
  readonly inputs: Record<string, unknown> | undefined
}

export interface SkippedExposedTool {
  readonly appId: string
  readonly name: string
  readonly reason: string
}

const APPROVAL_RE = /^approval/

/** The gateway plans on every request; warn once per distinct skip, not per request. */
const warnedSkips = new Set<string>()

/**
 * Every installed app's `exposes.tools`, re-checked against what only the
 * daemon knows: the apps.json record is re-validated (it can be hand-edited),
 * an `approval*` id/name is refused, and a name that is a daemon tool or was
 * already taken by an earlier app is skipped with a reason instead of
 * registered. Pure of any access policy: who sees what is decided by the caller.
 */
export async function planExposedTools(
  appRegistry: AppRegistry,
  extraReserved: Iterable<string> = [],
): Promise<{ tools: PlannedExposedTool[]; skipped: SkippedExposedTool[] }> {
  const reserved = new Set<string>([...DAEMON_TOOL_NAMES, ...extraReserved])
  const taken = new Map<string, string>()
  const tools: PlannedExposedTool[] = []
  const skipped: SkippedExposedTool[] = []

  for (const app of appRegistry.listApps()) {
    const declared = app.exposes?.tools
    if (!declared || declared.length === 0) continue
    const prefix = app.exposes?.prefix ?? "?"
    const skipAll = (reason: string): void => {
      for (const t of declared) skipped.push({ appId: app.appId, name: `${prefix}_${t.id}`, reason })
    }

    try {
      parseExposedTools(
        declared,
        app.exposes?.prefix,
        m => new Error(m),
        { daemonToolNames: DAEMON_TOOL_NAMES },
        app.exposes?.resources,
      )
    } catch (err) {
      skipAll(`invalid exposes.tools: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (!existsSync(app.dir)) {
      skipAll(`the app directory "${app.dir}" no longer exists`)
      continue
    }
    const bundled = await loadAppBundledTools(app.dir).then(
      b => b.tools,
      () => [],
    )

    for (const entry of declared) {
      const name = exposedToolName(prefix, entry)
      if (APPROVAL_RE.test(entry.id) || APPROVAL_RE.test(entry.mcpName ?? "") || APPROVAL_RE.test(name)) {
        skipped.push({ appId: app.appId, name, reason: "an approval* tool is never exposed by an app" })
        continue
      }
      if (reserved.has(name)) {
        skipped.push({ appId: app.appId, name, reason: "collides with a daemon tool" })
        continue
      }
      const holder = taken.get(name)
      if (holder !== undefined) {
        skipped.push({ appId: app.appId, name, reason: `already exposed by app "${holder}"` })
        continue
      }
      taken.set(name, app.appId)
      tools.push({
        appId: app.appId,
        entry,
        name,
        inputs: entry.inputSchema ?? bundled.find(t => t.id === entry.id)?.inputs,
      })
    }
  }
  for (const s of skipped) {
    const key = `${s.appId}\u0000${s.name}\u0000${s.reason}`
    if (warnedSkips.has(key)) continue
    warnedSkips.add(key)
    console.warn(`[app-exposed-tools] skipping "${s.name}" of app "${s.appId}": ${s.reason}.`)
  }
  return { tools, skipped }
}
