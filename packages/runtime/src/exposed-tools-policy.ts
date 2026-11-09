/**
 * `defaults.apps.exposedTools`: the operator kill-switch for installed apps'
 * `exposes.tools` on the /mcp gateway. Read per request, like
 * `resolveMcpConfig`, so a `config_set` applies to the next call.
 *
 *   "read" (default)  access: read for every caller; write/approve only for a
 *                     caller whose AGENT.md opted in
 *   "off"             nothing is registered
 *   "all"             every declared tool, for every caller
 *
 * Besides an AGENT.md opt-in, a write/approve tool reaches a caller through
 * its app's `requires.apps[].tools`: a session run from one of the consumer
 * app's own AGENT.md files is granted the listed provider tools, while the
 * provider is installed at a satisfying version ({@link exposedToolGrantsFor}).
 */

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  checkExposedTools,
  exposedToolName,
  loadAppBundledTools,
  parseExposedResources,
  versionSatisfies,
  type AppExposedTool,
  type AppExposedToolAccess,
  type AppRequirement,
} from "@agentproto/app"
import type { Grant } from "@agentproto/policy"
import type { AppRegistry, InstalledApp } from "./app-registry.js"
import { loadConfig } from "./config.js"
import { DAEMON_TOOL_NAMES } from "./daemon-tool-names.generated.js"
import { APP_AGENT_META_KEY } from "./sessions.js"
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

/** Why `providerVersion` fails `range`, or undefined when it satisfies it. A
 *  missing or malformed version fails closed. */
export function appVersionProblem(providerVersion: string | undefined, range: string): string | undefined {
  if (providerVersion === undefined) return "has no recorded version"
  try {
    return versionSatisfies(providerVersion, range) ? undefined : `is installed at version ${providerVersion}`
  } catch (err) {
    return `has an unusable version (${err instanceof Error ? err.message : String(err)})`
  }
}

/** The MCP names an installed app's `exposes.tools` compute (an entry with no
 *  computable name is left out: the gateway skips it too). */
export function exposedToolNamesOf(app: InstalledApp): string[] {
  const prefix = app.exposes?.prefix
  if (prefix === undefined) return []
  return (app.exposes?.tools ?? []).flatMap(entry => {
    try {
      return [exposedToolName(prefix, entry)]
    } catch {
      return []
    }
  })
}

/** A `requires.apps` entry that does not hold right now (AIP-53 `unmetRequires`). */
export type UnmetRequirement =
  | { readonly id: string; readonly reason: "not-installed" }
  | { readonly id: string; readonly reason: "version-mismatch"; readonly installed: string | null }
  | { readonly id: string; readonly reason: "tool-not-exposed"; readonly tools: readonly string[] }

/** Whether one `requires.apps` entry holds against the registry, and if not, why. */
function requirementStatus(appRegistry: AppRegistry, dep: AppRequirement): UnmetRequirement | { provider: InstalledApp } {
  const provider = appRegistry.getApp(dep.id)
  if (!provider) return { id: dep.id, reason: "not-installed" }
  if (dep.version !== undefined && appVersionProblem(provider.version, dep.version) !== undefined) {
    return { id: dep.id, reason: "version-mismatch", installed: provider.version ?? null }
  }
  if (dep.tools && dep.tools.length > 0) {
    const exposed = new Set(exposedToolNamesOf(provider))
    const dropped = dep.tools.filter(name => !exposed.has(name))
    if (dropped.length > 0) return { id: dep.id, reason: "tool-not-exposed", tools: dropped }
  }
  return { provider }
}

/** The consumer's unmet `requires.apps` entries, recomputed from the registry
 *  on every call, so installing or removing a provider changes it at once. */
export function unmetRequires(
  appRegistry: AppRegistry,
  requirements: readonly AppRequirement[] | undefined,
): UnmetRequirement[] {
  return (requirements ?? []).flatMap(dep => {
    const status = requirementStatus(appRegistry, dep)
    return "reason" in status ? [status] : []
  })
}

/**
 * The install/reload check that needs the installed provider: each
 * `requires.apps[i].tools[j]` must equal the MCP name of one of the provider's
 * `exposes.tools` entries. Returns the error naming every offending entry, or
 * undefined. A provider that is not installed is not checked: the entry is
 * reported in `unmetRequires` and grants nothing until it is.
 */
export function unexposedRequiredTools(
  appRegistry: AppRegistry,
  requirements: readonly AppRequirement[] | undefined,
): string | undefined {
  const problems: string[] = []
  ;(requirements ?? []).forEach((dep, i) => {
    const provider = appRegistry.getApp(dep.id)
    if (!provider || !dep.tools) return
    const names = exposedToolNamesOf(provider)
    const exposed = new Set(names)
    dep.tools.forEach((name, j) => {
      if (exposed.has(name)) return
      problems.push(
        `requires.apps[${i}].tools[${j}]: "${name}" is not exposed by "${dep.id}" (exposes: ${names.join(", ") || "none"})`,
      )
    })
  })
  return problems.length > 0 ? `${problems.join("; ")}.` : undefined
}

/**
 * The installed app whose own AGENT.md the session runs: `meta.appAgent`
 * (stamped by an `app_run` spawn), else the app that declares the session's
 * `meta.agentManifestPath` among its `agents`. Both are daemon-written at
 * spawn, never taken from a request. A child the session spawns runs its own
 * manifest, so it is not the app's agent.
 */
export function consumerAppOf(
  appRegistry: AppRegistry,
  meta: Readonly<Record<string, string>> | undefined,
): InstalledApp | undefined {
  const appId = meta?.[APP_AGENT_META_KEY]
  if (appId !== undefined) return appRegistry.getApp(appId)
  const manifest = meta?.agentManifestPath
  if (manifest === undefined) return undefined
  const target = resolve(manifest)
  return appRegistry
    .listApps()
    .find(app => app.agents.some(a => resolve(a.path) === target || resolve(join(a.path, "AGENT.md")) === target))
}

/** The key of one granted exposed tool: the provider app id and its MCP name. */
export function exposedToolGrantKey(appId: string, name: string): string {
  return `${appId}\u0000${name}`
}

/**
 * The provider tools `consumer`'s `requires.apps[].tools` grant right now, as
 * {@link exposedToolGrantKey} keys. All or nothing per entry: an entry whose
 * provider is missing, fails the version range or no longer exposes one of the
 * names grants none of them. Re-evaluated per call, so uninstalling the
 * provider drops the grant.
 */
export function requiredToolGrants(appRegistry: AppRegistry, consumer: InstalledApp | undefined): Set<string> {
  const grants = new Set<string>()
  for (const dep of consumer?.requiresApps ?? []) {
    if (!dep.tools || dep.tools.length === 0) continue
    const status = requirementStatus(appRegistry, dep)
    if ("reason" in status) continue
    for (const name of dep.tools) grants.add(exposedToolGrantKey(status.provider.appId, name))
  }
  return grants
}

/** The app-declared grants of a caller session, from its descriptor `meta`. */
export function exposedToolGrantsFor(
  appRegistry: AppRegistry,
  meta: Readonly<Record<string, string>> | undefined,
): Set<string> {
  return requiredToolGrants(appRegistry, consumerAppOf(appRegistry, meta))
}

/** Who is calling an exposed tool: the session, its AGENT.md opt-in, and its app grants. */
export interface ExposedToolCaller {
  readonly sessionId?: string | undefined
  readonly optIn?: readonly string[] | undefined
  /** {@link exposedToolGrantKey} keys from {@link exposedToolGrantsFor}. */
  readonly grants?: ReadonlySet<string> | undefined
  /** The session's tool deny grants (`SessionDescriptor.toolDenyGrants`). The
   *  gateway applies them through its wrapped server; a surface that runs an
   *  exposed tool without registering it applies them itself. */
  readonly denyGrants?: readonly Grant[] | undefined
}

/**
 * Whether `caller` may see and call this exposed tool: never in mode "off";
 * otherwise when the mode allows its access class, when the caller's AGENT.md
 * opted in by exact MCP name, or when its app's `requires.apps` grants it. A
 * deny rule is applied by the wrapped server the tool is registered on.
 */
export function exposedToolVisible(
  mode: ExposedToolsMode,
  tool: { readonly appId: string; readonly entry: AppExposedTool; readonly name: string },
  caller: ExposedToolCaller | undefined,
): boolean {
  if (mode === "off") return false
  return (
    exposedAccessAllowed(mode, tool.entry.access) ||
    exposedOptInMatches(caller?.optIn, tool.name) ||
    (caller?.grants?.has(exposedToolGrantKey(tool.appId, tool.name)) ?? false)
  )
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

/** A refused entry's MCP name when it still computes one, else its id. */
function refusedEntryName(prefix: string, entry: AppExposedTool | undefined, id: string): string {
  try {
    return entry ? exposedToolName(prefix, entry) : id
  } catch {
    return id
  }
}

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
    const skipAll = (reason: string, entries: readonly { readonly id: string }[] = declared): void => {
      for (const t of entries) skipped.push({ appId: app.appId, name: `${prefix}_${t.id}`, reason })
    }

    // Re-checked per entry: an invalid entry is skipped alone, its siblings stay.
    let valid: AppExposedTool[]
    try {
      const checked = checkExposedTools(declared, app.exposes?.prefix, m => new Error(m), {
        daemonToolNames: DAEMON_TOOL_NAMES,
      })
      valid = checked.tools
      for (const r of checked.refused) {
        skipped.push({
          appId: app.appId,
          name: refusedEntryName(prefix, declared[r.index], r.id),
          reason: `invalid exposes.tools entry: ${r.reason}`,
        })
      }
    } catch (err) {
      skipAll(`invalid exposes.tools: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (app.exposes?.resources !== undefined) {
      try {
        parseExposedResources(app.exposes.resources, m => new Error(m))
      } catch (err) {
        skipped.push({
          appId: app.appId,
          name: `${prefix}_resources`,
          reason: `invalid exposes.resources: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
    if (valid.length === 0) continue
    if (!existsSync(app.dir)) {
      skipAll(`the app directory "${app.dir}" no longer exists`, valid)
      continue
    }
    const bundled = await loadAppBundledTools(app.dir).then(
      b => b.tools,
      () => [],
    )

    for (const entry of valid) {
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
