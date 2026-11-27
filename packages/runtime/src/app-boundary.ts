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
 *   hostConfig  project config at the root of that host repo (`.git`,
 *             `.gitignore`, `.claude/`, `.codex/`, `.mcp.json`, `CLAUDE.md`,
 *             `AGENTS.md`),
 *             re-opened READ-ONLY inside the hidden tree for every app: git,
 *             rg and the harnesses walk up to the repo root to load it, and an
 *             unreadable settings file makes a harness start without the
 *             project's hooks and permission rules
 *   hostReads paths the app declares in `boundaries.hostReads` (relative to
 *             the host repo root: a sibling package's built CLI, a shared
 *             folder), re-opened READ-ONLY; refused when they resolve outside
 *             the host repo
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

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { canonicalizePath, resolveCommandSandbox, type SandboxMode } from "@agentproto/command-sandbox"
import { findSecretsInTree, isSecretFileName } from "./app-read-grants.js"

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
  /** Operator-granted read-only paths (a subset of `readOnly`, kept apart for
   *  audit: `describeBoundary`, `app_list`). Absent = none. */
  readonly readGrants?: readonly string[]
  /** Secret files/dirs inside a read grant, denied for read and write even
   *  though their parent is readable. Absent = none. */
  readonly unreadable?: readonly string[]
  /** Project config files/dirs at the root of a hidden host repo, re-opened
   *  read-only (a subset of `readOnly`, kept apart for audit). Absent = none.
   *  See {@link HOST_REPO_CONFIG_ENTRIES}. */
  readonly hostConfig?: readonly string[]
  /** Paths the app declared in `boundaries.hostReads` that resolved inside
   *  its host repo, re-opened read-only (a subset of `readOnly`, kept apart
   *  for audit). Absent = none. */
  readonly hostReads?: readonly string[]
}

/**
 * Entries at the root of a hidden host repo that tools load as project
 * config and that stay readable (never writable) for every app session:
 *   - git and rg walk up to `.git` (and read `.gitignore`) from any subdir,
 *     so `git status/log/ls-files` and `rg` work from the app dir;
 *   - Claude Code (checked on 2.1.x, cwd = the app dir inside a repo) reads
 *     `.claude/settings.json` from `cwd` only, but `.claude/settings.local.json`
 *     from `cwd` AND the git root (an EPERM there is the "Settings file could
 *     not be read" startup error), lists the root `.claude/commands/` and
 *     `.claude/agents/`, reads the root `.mcp.json` (project MCP scope), and
 *     probes `CLAUDE.md` / `AGENTS.md` in every ancestor;
 *   - Codex reads the project `.codex/` and the `AGENTS.md` chain from the
 *     git root down to `cwd`.
 * Loading instructions into context is a separate switch
 * (`isolateHostContext`): a readable `CLAUDE.md` is still excluded from the
 * session's context when the harness supports that.
 */
export const HOST_REPO_CONFIG_ENTRIES: readonly string[] = [
  ".git",
  ".gitignore",
  ".claude",
  ".codex",
  ".mcp.json",
  "CLAUDE.md",
  "AGENTS.md",
]

function realOrUndefined(p: string): string | undefined {
  try {
    return realpathSync(p)
  } catch {
    return undefined
  }
}

/**
 * `<repo>/<rel>` when it exists and its real path stays strictly inside the
 * repo (a symlink to elsewhere, `..`, or the repo root itself is refused), and
 * its name is not a conventional secret. Returns the reason otherwise.
 */
function insideHostRepo(repoRoot: string, realRoot: string, rel: string): { path: string } | { reason: string } {
  const p = resolve(repoRoot, rel)
  const real = realOrUndefined(p)
  if (real === undefined) return { reason: "path does not exist" }
  if (!isPathWithin(real, realRoot)) return { reason: "resolves outside the host repo" }
  if (real === realRoot) return { reason: "refusing the whole host repo; name the paths the app needs" }
  if (relative(realRoot, real).split("/").some(part => isSecretFileName(part))) return { reason: "refusing a secrets file" }
  return { path: p }
}

/** The git dirs a linked worktree's `.git` file points at (gitdir + commondir). */
function linkedGitDirs(repoRoot: string): string[] {
  const dotGit = join(repoRoot, ".git")
  try {
    if (!statSync(dotGit).isFile()) return []
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))
    if (!m) return []
    const gitDir = realOrUndefined(resolve(repoRoot, m[1]!.trim()))
    if (gitDir === undefined) return []
    const out = [gitDir]
    const commonFile = join(gitDir, "commondir")
    if (existsSync(commonFile)) {
      const common = realOrUndefined(resolve(gitDir, readFileSync(commonFile, "utf8").trim()))
      if (common !== undefined && !out.includes(common)) out.push(common)
    }
    return out
  } catch {
    return []
  }
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
    readonly boundaries?: { readonly enforce?: AppBoundaryEnforce; readonly hostReads?: readonly string[] }
  }
  /** The workflow run workspace root (`~/.agentproto/runs/<runId>/`). */
  readonly runWorkspace?: string
  /** Extra read-only trees (e.g. an explicit `app_run` cwd outside the app). */
  readonly extraReadOnly?: readonly string[]
  /** Operator-granted read-only paths for this app (already validated by
   *  `app-read-grants.ts`; never derived from the app manifest). */
  readonly readGrants?: readonly string[]
  /** The daemon's own workspace root — hidden from the session. */
  readonly daemonWorkspace?: string
  /** Where a refused `boundaries.hostReads` entry is reported. Defaults to
   *  `console.warn`. */
  readonly warn?: (line: string) => void
}

/**
 * Build the boundary for one app-spawned session. Creates the writable
 * directories (a missing bind source is skipped by bubblewrap, and an agent
 * cannot `mkdir` its way into a zone it cannot yet see).
 */
export function buildAppBoundary(input: BuildAppBoundaryInput): AppBoundary {
  const dir = resolve(input.app.dir)
  const grants = (input.readGrants ?? []).map(p => resolve(p))
  const readOnly = [dir, ...(input.extraReadOnly ?? []).map(p => resolve(p))]
  for (const g of grants) if (!readOnly.includes(g)) readOnly.push(g)
  const unreadable = grants.flatMap(g => findSecretsInTree(g))
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
  const gitRoot = findGitToplevel(dir)
  const candidates = [input.daemonWorkspace, gitRoot]
  const hidden: string[] = []
  const hostConfig: string[] = []
  const hostReads: string[] = []
  const openReadOnly = (p: string, audit: string[], scan: boolean): void => {
    if (!readOnly.includes(p)) readOnly.push(p)
    if (!audit.includes(p)) audit.push(p)
    // Same secret filter as operator read grants: a `.env` or key file
    // inside a re-opened dir stays masked.
    if (scan) for (const secret of findSecretsInTree(p)) if (!unreadable.includes(secret)) unreadable.push(secret)
  }
  for (const c of candidates) {
    if (!c) continue
    const abs = resolve(c)
    // A hidden tree at or inside the app dir would hide the app from itself.
    if (isPathWithin(canonicalizePath(abs), canonDir)) continue
    if (!hidden.includes(abs)) hidden.push(abs)
    // Only the repo the app lives in: that is the root git, rg and the
    // harnesses walk up to, and the only tree `hostReads` may name.
    if (c !== gitRoot) continue
    const realRoot = realOrUndefined(abs)
    if (realRoot === undefined) continue
    for (const name of HOST_REPO_CONFIG_ENTRIES) {
      const r = insideHostRepo(abs, realRoot, name)
      // `.git` holds no conventionally named secrets and is large: not scanned.
      if ("path" in r) openReadOnly(r.path, hostConfig, name !== ".git")
    }
    for (const g of linkedGitDirs(abs)) openReadOnly(g, hostConfig, false)
    for (const rel of input.app.boundaries?.hostReads ?? []) {
      const r =
        typeof rel !== "string" || rel.trim() === "" || isAbsolute(rel)
          ? { reason: "must be a non-empty path relative to the host repo root" }
          : insideHostRepo(abs, realRoot, rel)
      if ("path" in r) openReadOnly(r.path, hostReads, true)
      else (input.warn ?? console.warn)(`[app-boundary] app '${input.app.appId}': boundaries.hostReads '${String(rel)}' refused: ${r.reason}`)
    }
  }
  return {
    appId: input.app.appId,
    root: dir,
    readOnly,
    writable,
    hidden,
    enforce: input.app.boundaries?.enforce ?? "best-effort",
    ...(grants.length > 0 ? { readGrants: grants } : {}),
    ...(unreadable.length > 0 ? { unreadable } : {}),
    ...(hostConfig.length > 0 ? { hostConfig } : {}),
    ...(hostReads.length > 0 ? { hostReads } : {}),
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
      !strs(v.hidden) ||
      (v.readGrants !== undefined && !strs(v.readGrants)) ||
      (v.unreadable !== undefined && !strs(v.unreadable)) ||
      (v.hostConfig !== undefined && !strs(v.hostConfig)) ||
      (v.hostReads !== undefined && !strs(v.hostReads))
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
      ...(v.readGrants !== undefined ? { readGrants: v.readGrants } : {}),
      ...(v.unreadable !== undefined ? { unreadable: v.unreadable } : {}),
      ...(v.hostConfig !== undefined ? { hostConfig: v.hostConfig } : {}),
      ...(v.hostReads !== undefined ? { hostReads: v.hostReads } : {}),
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
  const granted = b.readGrants?.length ? `; operator-granted read-only: ${b.readGrants.join(", ")}` : ""
  const host = b.hostConfig?.length ? `; host repo config (read-only): ${b.hostConfig.join(", ")}` : ""
  const deps = b.hostReads?.length ? `; declared host repo reads (read-only): ${b.hostReads.join(", ")}` : ""
  return `read-only: ${ro}; writable: ${rw}${granted}${host}${deps}`
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
  if (b.unreadable && inAny(canon, b.unreadable)) {
    throw new FsZoneError(`path is a protected secret for app '${b.appId}': '${input}'`)
  }
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
  unreadable?: string[]
} {
  return {
    readOnly: [...b.readOnly],
    writable: [...b.writable],
    hidden: [...b.hidden],
    ...(b.unreadable?.length ? { unreadable: [...b.unreadable] } : {}),
  }
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
