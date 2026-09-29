/**
 * App boundary — filesystem zones for sessions an app (or an app workflow)
 * spawns.
 *
 *   readOnly  the installed app source (dir, `.agentproto/`, `scripts/`, …)
 *   writable  the workflow run workspace (`~/.agentproto/runs/<runId>/`,
 *             `$run.workspace`) and the app `data/` dir
 *   hidden    host trees that must not be readable even though the OS
 *             sandbox alone would allow them (the daemon workspace, the host
 *             monorepo the app happens to be installed inside)
 *   else      denied
 *
 * One `AppBoundary` value drives every enforcement surface:
 *   - daemon file tools (`fs-tools.ts`) and `command_execute`
 *     (`command-tools.ts`) resolve paths through {@link resolveBoundaryPath};
 *   - the harness's native tools are confined by the OS sandbox
 *     (`@agentproto/command-sandbox`) built from {@link boundaryToSandboxZones};
 *   - the boundary rides on the session descriptor (`meta.appBoundary`) so the
 *     daemon gateway can recover a caller's boundary from its trusted
 *     `callerSessionId`, and children/restarts inherit it.
 */

import { existsSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { canonicalizePath, resolveCommandSandbox, type SandboxMode } from "@agentproto/command-sandbox"

export const APP_BOUNDARY_META_KEY = "appBoundary"

export type AppBoundaryEnforce = "required" | "best-effort"

export interface AppBoundary {
  readonly appId: string
  /** Base for relative paths in the daemon file tools — the app dir. */
  readonly root: string
  readonly readOnly: readonly string[]
  readonly writable: readonly string[]
  readonly hidden: readonly string[]
  readonly enforce: AppBoundaryEnforce
}

export class FsZoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FsZoneError"
  }
}

export function isPathWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Nearest ancestor of `dir` holding a `.git` entry (file or dir), if any. */
function findGitToplevel(dir: string): string | undefined {
  let cur = resolve(dir)
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur
    const parent = dirname(cur)
    if (parent === cur) return undefined
    cur = parent
  }
}

export interface BuildAppBoundaryInput {
  readonly app: {
    readonly appId: string
    readonly dir: string
    readonly dataDir?: string
    readonly boundaries?: { readonly enforce?: AppBoundaryEnforce }
  }
  /** The workflow run workspace root (`~/.agentproto/runs/<runId>/`). */
  readonly runWorkspace?: string
  /** Extra read-only trees (e.g. an explicit `app_run` cwd outside the app). */
  readonly extraReadOnly?: readonly string[]
  /** The daemon's own workspace root — hidden from the session. */
  readonly daemonWorkspace?: string
}

/**
 * Build the boundary for one app-spawned session. Creates the writable
 * directories (a missing bind source is skipped by bubblewrap, and an agent
 * cannot `mkdir` its way into a zone it cannot yet see).
 */
export function buildAppBoundary(input: BuildAppBoundaryInput): AppBoundary {
  const dir = resolve(input.app.dir)
  const readOnly = [dir, ...(input.extraReadOnly ?? []).map(p => resolve(p))]
  const writable: string[] = []
  if (input.app.dataDir) writable.push(resolve(input.app.dataDir))
  if (input.runWorkspace) writable.push(resolve(input.runWorkspace))
  for (const w of writable) {
    try {
      mkdirSync(w, { recursive: true })
    } catch {
      // Best-effort: an uncreatable zone is simply unusable; it does not widen anything.
    }
  }
  const canonDir = canonicalizePath(dir)
  const candidates = [input.daemonWorkspace, findGitToplevel(dir)]
  const hidden: string[] = []
  for (const c of candidates) {
    if (!c) continue
    const abs = resolve(c)
    // A hidden tree at or inside the app dir would hide the app from itself.
    if (isPathWithin(canonicalizePath(abs), canonDir)) continue
    if (!hidden.includes(abs)) hidden.push(abs)
  }
  return {
    appId: input.app.appId,
    root: dir,
    readOnly,
    writable,
    hidden,
    enforce: input.app.boundaries?.enforce ?? "best-effort",
  }
}

export function encodeAppBoundary(b: AppBoundary): string {
  return JSON.stringify(b)
}

/** Decode `meta.appBoundary`; `undefined` for absent or malformed values. */
export function boundaryFromMeta(
  meta: Readonly<Record<string, string>> | undefined,
): AppBoundary | undefined {
  const raw = meta?.[APP_BOUNDARY_META_KEY]
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw) as Partial<AppBoundary>
    const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every(e => typeof e === "string")
    if (
      typeof v.appId !== "string" ||
      typeof v.root !== "string" ||
      !strs(v.readOnly) ||
      !strs(v.writable) ||
      !strs(v.hidden)
    ) {
      return undefined
    }
    return {
      appId: v.appId,
      root: v.root,
      readOnly: v.readOnly,
      writable: v.writable,
      hidden: v.hidden,
      enforce: v.enforce === "required" ? "required" : "best-effort",
    }
  } catch {
    return undefined
  }
}

export function boundaryMeta(b: AppBoundary): Record<string, string> {
  return { [APP_BOUNDARY_META_KEY]: encodeAppBoundary(b) }
}

/** Human-readable zone summary, used in error messages and prompts. */
export function describeBoundary(b: AppBoundary): string {
  const ro = b.readOnly.join(", ") || "(none)"
  const rw = b.writable.join(", ") || "(none)"
  return `read-only: ${ro}; writable: ${rw}`
}

function inAny(canon: string, zones: readonly string[]): boolean {
  return zones.some(z => isPathWithin(canon, canonicalizePath(z)))
}

/**
 * Resolve a caller-supplied path against the boundary. Relative paths anchor
 * at `boundary.root`. Symlinks are resolved (realpath of the longest existing
 * prefix) before the zone check, so a link inside a writable zone that points
 * at app source cannot be used to write through it. Comparison is
 * case-sensitive: a case-variant spelling fails closed.
 */
export function resolveBoundaryPath(
  b: AppBoundary,
  input: string,
  mode: "read" | "write",
): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new FsZoneError("path must be a non-empty string")
  }
  const candidate = isAbsolute(input) ? normalize(input) : normalize(join(b.root, input))
  const canon = canonicalizePath(candidate)
  if (mode === "write") {
    if (inAny(canon, b.writable)) return candidate
    if (inAny(canon, b.readOnly)) {
      throw new FsZoneError(
        `path is read-only for app '${b.appId}': '${input}' (app source cannot be modified). ` +
          `Writable zones: ${b.writable.join(", ") || "(none)"}`,
      )
    }
    throw new FsZoneError(
      `path is outside the app boundary of '${b.appId}': '${input}'. ` +
        `Writable zones: ${b.writable.join(", ") || "(none)"}`,
    )
  }
  if (inAny(canon, b.readOnly) || inAny(canon, b.writable)) return candidate
  throw new FsZoneError(
    `path is outside the app boundary of '${b.appId}': '${input}'. Readable zones: ${[...b.readOnly, ...b.writable].join(", ")}`,
  )
}

/** Sandbox zones for `@agentproto/command-sandbox` / the agent-cli driver. */
export function boundaryToSandboxZones(b: AppBoundary): {
  readOnly: string[]
  writable: string[]
  hidden: string[]
} {
  return { readOnly: [...b.readOnly], writable: [...b.writable], hidden: [...b.hidden] }
}

export interface BoundaryEnforcementInput {
  /** `agent_start.commandSandbox` / workflow step value, if the caller set one. */
  readonly commandSandbox?: SandboxMode
  /** Adapter accepts `fsZones` (native tools confined by the OS sandbox). */
  readonly harnessSupportsFsZones: boolean
  /** Test seam; defaults to probing the platform backend. */
  readonly backendAvailable?: boolean
}

export interface BoundaryEnforcement {
  readonly enforced: boolean
  /** Why the native-tool zones cannot be enforced (empty when enforced). */
  readonly reasons: readonly string[]
}

/**
 * Can the native-tool half of the boundary be enforced for this spawn? The
 * daemon-file-tool half is always enforced (identity-based, in-process); this
 * decides whether the harness's own Bash/Write/Edit are confined too.
 */
export function assessBoundaryEnforcement(input: BoundaryEnforcementInput): BoundaryEnforcement {
  const reasons: string[] = []
  if (!input.harnessSupportsFsZones) {
    reasons.push("the selected harness/adapter cannot confine its native tools to fs zones")
  }
  if (input.commandSandbox === "off") {
    reasons.push('commandSandbox is explicitly "off"')
  }
  const backend = input.backendAvailable ?? resolveCommandSandbox() !== null
  if (!backend) {
    reasons.push(`no OS sandbox backend is available on ${process.platform} (needs macOS Seatbelt or Linux bubblewrap)`)
  }
  return { enforced: reasons.length === 0, reasons }
}

export const APP_BOUNDARY_UNENFORCEABLE = "app_boundary_unenforceable"

export function unenforceableMessage(b: AppBoundary, reasons: readonly string[]): string {
  return (
    `app '${b.appId}' declares boundaries.enforce "required" but its fs zones cannot be enforced ` +
    `for native tools: ${reasons.join("; ")}.`
  )
}

export function unenforceableWarning(b: AppBoundary, reasons: readonly string[]): string {
  return (
    `app boundary for '${b.appId}' is NOT enforced on this session's native tools ` +
    `(${reasons.join("; ")}). Daemon file tools remain confined; the harness's own ` +
    `Bash/Write/Edit are not.`
  )
}

/**
 * Start options that re-apply a boundary to a respawned adapter (session
 * restart / lazy in-place resume). The original spawn already emitted any
 * warning, so this only re-derives what the harness can enforce — and refuses
 * when the app requires enforcement that is no longer possible.
 */
export function boundaryRestartOptions(
  b: AppBoundary,
  caps: {
    supportsFsZones?: boolean
    supportsHostContextIsolation?: boolean
    commandSandbox?: SandboxMode
  },
): {
  fsZones?: ReturnType<typeof boundaryToSandboxZones>
  isolateHostContext?: true
} {
  const enforcement = assessBoundaryEnforcement({
    harnessSupportsFsZones: caps.supportsFsZones === true,
    ...(caps.commandSandbox ? { commandSandbox: caps.commandSandbox } : {}),
  })
  if (!enforcement.enforced && b.enforce === "required") {
    throw new FsZoneError(`${APP_BOUNDARY_UNENFORCEABLE}: ${unenforceableMessage(b, enforcement.reasons)}`)
  }
  return {
    ...(enforcement.enforced ? { fsZones: boundaryToSandboxZones(b) } : {}),
    ...(caps.supportsHostContextIsolation ? { isolateHostContext: true as const } : {}),
  }
}
