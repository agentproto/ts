/**
 * `~/.agentproto/workspaces.json` — single source of truth for the
 * local agentproto control plane. Tracks which directories the user
 * has opted into as agentproto workspaces, plus which one is "active"
 * (the daemon's default working set when no workspace is named in
 * a tool call).
 *
 * Why a config file instead of recreating an MCP entry per workspace:
 *   - One daemon = one MCP entry in the user's IDE (clean to read in
 *     `claude mcp list`, no `dapper_willow` / `noble_lantern` spam).
 *   - The daemon walks `workspaces[]` at boot and exposes them all;
 *     tools that need a target take an optional `workspace` arg and
 *     fall back to `active` when omitted.
 *   - The CLI (`agentproto workspace add/list/remove/use`), the daemon,
 *     and the guilde-web onboarding dialog all read+write the same
 *     file, so changes from one surface are immediately visible to
 *     the others.
 *
 * File layout is intentionally boring (small, hand-editable JSON) —
 * future fields go on top, never break v1 readers.
 */

import { promises as fs, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, resolve } from "node:path"

export const WORKSPACES_CONFIG_VERSION = 1 as const

/** Where a workspace's code lives off this machine. Lets a sandbox spawn
 *  (`agent_start({ sandbox, workspaceSlug })`) clone the repo into the box
 *  instead of needing the host path. Holds no secret: `credentialRef` only
 *  names the keychain slot of the PAT used to clone and push. */
export interface WorkspaceRemote {
  /** `https://` clone URL, never carrying userinfo (no `user:token@`). */
  url: string
  /** Branch new work branches from when no explicit base is given
   *  (the box uses `origin/<defaultBranch>`). Absent ⇒ `main`. */
  defaultBranch?: string
  /** Keychain slot (`StoreRef.path`) holding the git PAT. */
  credentialRef?: string
}

export const DEFAULT_REMOTE_BRANCH = "main"

export interface WorkspaceEntry {
  /** Stable handle — what tools accept as `workspace`. Lowercase
   *  ASCII, hyphen-only. The CLI sanitises arbitrary names down to
   *  this shape so paste-from-finder Just Works. */
  slug: string
  /** Absolute filesystem path. Required absolute so the daemon can
   *  serve the workspace regardless of its own cwd. */
  path: string
  /** ISO-8601 — first time the entry was added. Pure metadata, no
   *  behavioural impact. */
  addedAt: string
  /** Last time the entry was touched (renamed, path edited, used as
   *  active). Lets the CLI sort by recency without an N+1 stat. */
  updatedAt: string
  /** Free-text label the user can attach so workspaces with similar
   *  slugs stay distinguishable in `agentproto workspace list`. */
  label?: string
  /** Optional off-machine clone source — see {@link WorkspaceRemote}. */
  remote?: WorkspaceRemote
}

export interface WorkspacesConfig {
  version: typeof WORKSPACES_CONFIG_VERSION
  /** Active workspace slug — daemon defaults to this when no
   *  `workspace` arg is passed. May be undefined when no workspaces
   *  are registered yet. */
  active?: string
  workspaces: WorkspaceEntry[]
}

export const DEFAULT_CONFIG_DIR = (): string =>
  resolve(homedir(), ".agentproto")
export const DEFAULT_CONFIG_PATH = (): string =>
  resolve(DEFAULT_CONFIG_DIR(), "workspaces.json")

/** Reduce arbitrary user input to a safe slug. Aligns with what most
 *  tooling validates against (`/^[a-z0-9][a-z0-9-]{0,63}$/`) so the
 *  daemon never has to encode it for URLs or filesystem paths. */
export function sanitizeSlug(input: string): string {
  const trimmed = input.trim().toLowerCase()
  const cleaned = trimmed
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  // Edge case: input was entirely non-conforming — fall back to a
  // generic so we never return an empty string.
  return cleaned || "workspace"
}

/** Read the config from disk. Returns an empty config (no workspaces,
 *  no active) when the file is missing — this is the legitimate
 *  first-boot state, not an error. */
export async function loadWorkspacesConfig(
  path: string = DEFAULT_CONFIG_PATH()
): Promise<WorkspacesConfig> {
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: WORKSPACES_CONFIG_VERSION, workspaces: [] }
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `agentproto: ${path} is not valid JSON (${
        err instanceof Error ? err.message : String(err)
      }). Delete the file or fix it manually.`
    )
  }
  return normalizeConfig(parsed)
}

/** Sync twin of `loadWorkspacesConfig`, sharing its normalisation (and
 *  therefore its slug sanitisation) exactly.
 *
 *  Exists because bucket resolution runs on paths that cannot await: the
 *  sessions registry loads its history synchronously at construction so
 *  the dashboard has rows immediately, and flushes synchronously on
 *  `process.on("exit")` where Node won't await. Both need to know which
 *  slugs are registered. The file is <1KB, so the sync read is cheaper
 *  than the machinery to avoid it. */
export function loadWorkspacesConfigSync(
  path: string = DEFAULT_CONFIG_PATH()
): WorkspacesConfig {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: WORKSPACES_CONFIG_VERSION, workspaces: [] }
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `agentproto: ${path} is not valid JSON (${
        err instanceof Error ? err.message : String(err)
      }). Delete the file or fix it manually.`
    )
  }
  return normalizeConfig(parsed)
}

/** Write the config back. Creates the parent directory if missing.
 *  Atomic-ish: writes to a temp file first, then renames over the
 *  target — avoids the partial-write window where a concurrent reader
 *  sees half a JSON object. */
export async function saveWorkspacesConfig(
  config: WorkspacesConfig,
  path: string = DEFAULT_CONFIG_PATH()
): Promise<void> {
  const normalized = normalizeConfig(config)
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2) + "\n", "utf8")
  await fs.rename(tmp, path)
}

/**
 * Pure helpers — caller manages persistence. Returns a NEW config
 * (never mutates) so callers can compose multiple updates before
 * a single save.
 */
export function addWorkspace(
  config: WorkspacesConfig,
  input: { slug: string; path: string; label?: string }
): WorkspacesConfig {
  if (!isAbsolute(input.path)) {
    throw new Error(
      `addWorkspace: path must be absolute, got "${input.path}".`
    )
  }
  const slug = sanitizeSlug(input.slug)
  const now = new Date().toISOString()
  const existingIdx = config.workspaces.findIndex(w => w.slug === slug)
  const next: WorkspaceEntry = existingIdx >= 0
    ? {
        ...config.workspaces[existingIdx]!,
        path: input.path,
        ...(input.label !== undefined ? { label: input.label } : {}),
        updatedAt: now,
      }
    : {
        slug,
        path: input.path,
        ...(input.label ? { label: input.label } : {}),
        addedAt: now,
        updatedAt: now,
      }
  const workspaces = [...config.workspaces]
  if (existingIdx >= 0) workspaces[existingIdx] = next
  else workspaces.push(next)
  // First-add becomes active automatically — saves the user a
  // separate `workspace use` call right after a fresh `add`.
  const active = config.active ?? slug
  return { ...config, workspaces, active }
}

/** Throws unless `raw` is a plain `https://` URL with a host and no
 *  userinfo/query/fragment; returns it trimmed. A token embedded in a URL
 *  would land in git config, process args and logs — the credential belongs
 *  in `credentialRef`. */
export function validateRemoteUrl(raw: string): string {
  const trimmed = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`remote url "${trimmed}" is not a valid URL.`)
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `remote url must use https:// (got "${parsed.protocol}//") — ssh/git/http remotes are not supported.`
    )
  }
  if (!parsed.hostname) {
    throw new Error(`remote url "${trimmed}" has no host.`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "remote url must not embed credentials; store the token with " +
        "`agentproto workspace remote set <slug> --url … --token-stdin` instead."
    )
  }
  if (parsed.search || parsed.hash) {
    throw new Error("remote url must not carry a query string or fragment.")
  }
  return trimmed
}

/** Throws unless `raw` is a conservative git branch name; returns it trimmed.
 *  It is interpolated into shell commands inside the box, so the charset is
 *  deliberately narrow. */
export function validateRemoteBranch(raw: string): string {
  const trimmed = raw.trim()
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed) ||
    trimmed.includes("..") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith(".lock")
  ) {
    throw new Error(`remote default branch "${trimmed}" is not a valid branch name.`)
  }
  return trimmed
}

/** Throws unless `raw` is a non-empty single-token keychain slot; returns it trimmed. */
export function validateCredentialRef(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || /\s/.test(trimmed)) {
    throw new Error("remote credentialRef must be a non-empty keychain slot name with no whitespace.")
  }
  return trimmed
}

/** Validate a candidate remote, returning a canonical copy. Throws on the
 *  first problem. */
export function validateWorkspaceRemote(input: WorkspaceRemote): WorkspaceRemote {
  return {
    url: validateRemoteUrl(input.url),
    ...(input.defaultBranch !== undefined
      ? { defaultBranch: validateRemoteBranch(input.defaultBranch) }
      : {}),
    ...(input.credentialRef !== undefined
      ? { credentialRef: validateCredentialRef(input.credentialRef) }
      : {}),
  }
}

/** Attach (or replace) the remote on an existing workspace. Throws when the
 *  slug is unknown or the remote is invalid. */
export function setWorkspaceRemote(
  config: WorkspacesConfig,
  slug: string,
  remote: WorkspaceRemote
): WorkspacesConfig {
  const sanitised = sanitizeSlug(slug)
  const validated = validateWorkspaceRemote(remote)
  const idx = config.workspaces.findIndex(w => w.slug === sanitised)
  if (idx < 0) {
    throw new Error(
      `setWorkspaceRemote: no workspace registered with slug "${sanitised}".`
    )
  }
  const workspaces = [...config.workspaces]
  workspaces[idx] = {
    ...workspaces[idx]!,
    remote: validated,
    updatedAt: new Date().toISOString(),
  }
  return { ...config, workspaces }
}

/** Drop the remote from a workspace. Throws when the slug is unknown; a
 *  workspace that had no remote is returned unchanged. */
export function unsetWorkspaceRemote(
  config: WorkspacesConfig,
  slug: string
): WorkspacesConfig {
  const sanitised = sanitizeSlug(slug)
  const idx = config.workspaces.findIndex(w => w.slug === sanitised)
  if (idx < 0) {
    throw new Error(
      `unsetWorkspaceRemote: no workspace registered with slug "${sanitised}".`
    )
  }
  const current = config.workspaces[idx]!
  if (current.remote === undefined) return config
  const { remote: _dropped, ...rest } = current
  const workspaces = [...config.workspaces]
  workspaces[idx] = { ...rest, updatedAt: new Date().toISOString() }
  return { ...config, workspaces }
}

export function removeWorkspace(
  config: WorkspacesConfig,
  slug: string
): WorkspacesConfig {
  const sanitised = sanitizeSlug(slug)
  const workspaces = config.workspaces.filter(w => w.slug !== sanitised)
  // If the removed workspace was active, hand off to whatever's
  // first — predictable and avoids leaving the daemon in an
  // unreachable state when the user removes the only one.
  let active = config.active
  if (active === sanitised) {
    active = workspaces[0]?.slug
  }
  const next: WorkspacesConfig = { ...config, workspaces }
  if (active !== undefined) next.active = active
  else delete next.active
  return next
}

export function setActiveWorkspace(
  config: WorkspacesConfig,
  slug: string
): WorkspacesConfig {
  const sanitised = sanitizeSlug(slug)
  if (!config.workspaces.some(w => w.slug === sanitised)) {
    throw new Error(
      `setActiveWorkspace: no workspace registered with slug "${sanitised}". ` +
        `Run \`agentproto workspace add <path> --slug ${sanitised}\` first.`
    )
  }
  return { ...config, active: sanitised }
}

export function findWorkspace(
  config: WorkspacesConfig,
  slug: string
): WorkspaceEntry | undefined {
  return config.workspaces.find(w => w.slug === sanitizeSlug(slug))
}

/** Resolve a path through `realpathSync` so symlinked roots (macOS `/tmp` →
 *  `/private/tmp`, a symlinked volume, …) compare equal to their real
 *  location. Falls back to a lexical `resolve` when the path doesn't exist
 *  on disk — `realpathSync` throws on ENOENT, and a not-yet-existing path
 *  still needs a comparable value. */
function canonical(p: string): string {
  try {
    return realpathSync(resolve(p))
  } catch {
    return resolve(p)
  }
}

/** Find a workspace whose path is an ancestor of (or equal to) the
 *  given directory. Returns the most specific match (longest path)
 *  when multiple workspaces nest under the same root. */
export function findWorkspaceByPath(
  config: WorkspacesConfig,
  dir: string
): WorkspaceEntry | undefined {
  const resolved = canonical(dir)
  const candidates = config.workspaces
    .filter(w => {
      const wPath = canonical(w.path)
      return resolved.startsWith(wPath + "/") || resolved === wPath
    })
    .sort((a, b) => b.path.length - a.path.length)
  return candidates[0]
}

/** The active workspace, or undefined when none is registered. Pure
 *  convenience to avoid re-implementing the lookup at every caller. */
export function getActiveWorkspace(
  config: WorkspacesConfig
): WorkspaceEntry | undefined {
  if (!config.active) return config.workspaces[0]
  return findWorkspace(config, config.active) ?? config.workspaces[0]
}

/** Lenient read of a hand-editable `remote` block: an invalid one (non-https
 *  URL, URL with userinfo, bad branch) is dropped rather than failing the
 *  whole file, mirroring how malformed workspace entries are skipped. */
function parseStoredRemote(raw: unknown): WorkspaceRemote | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.url !== "string") return undefined
  try {
    return validateWorkspaceRemote({
      url: r.url,
      ...(typeof r.defaultBranch === "string" ? { defaultBranch: r.defaultBranch } : {}),
      ...(typeof r.credentialRef === "string" ? { credentialRef: r.credentialRef } : {}),
    })
  } catch {
    return undefined
  }
}

/**
 * Coerce arbitrary parsed JSON into a valid config. Skips entries
 * with missing required fields rather than throwing — partial recovery
 * is friendlier than "your config file is corrupted, here's a stack
 * trace". Logs nothing here; the CLI shells that consume this should
 * decide whether to surface a warning.
 */
function normalizeConfig(parsed: unknown): WorkspacesConfig {
  if (!parsed || typeof parsed !== "object") {
    return { version: WORKSPACES_CONFIG_VERSION, workspaces: [] }
  }
  const obj = parsed as Record<string, unknown>
  const workspaces: WorkspaceEntry[] = []
  if (Array.isArray(obj.workspaces)) {
    for (const entry of obj.workspaces) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      const slug = typeof e.slug === "string" ? sanitizeSlug(e.slug) : ""
      const path = typeof e.path === "string" ? e.path : ""
      if (!slug || !path) continue
      const addedAt =
        typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString()
      const updatedAt = typeof e.updatedAt === "string" ? e.updatedAt : addedAt
      const we: WorkspaceEntry = { slug, path, addedAt, updatedAt }
      if (typeof e.label === "string" && e.label.trim()) {
        we.label = e.label.trim()
      }
      const remote = parseStoredRemote(e.remote)
      if (remote) we.remote = remote
      workspaces.push(we)
    }
  }
  // De-dupe by slug (last wins) — the file is hand-editable so a
  // typo could have produced two entries with the same slug.
  const dedup = new Map<string, WorkspaceEntry>()
  for (const w of workspaces) dedup.set(w.slug, w)
  const finalList = Array.from(dedup.values())
  const active =
    typeof obj.active === "string" && finalList.some(w => w.slug === obj.active)
      ? (obj.active as string)
      : finalList[0]?.slug
  const out: WorkspacesConfig = {
    version: WORKSPACES_CONFIG_VERSION,
    workspaces: finalList,
  }
  if (active !== undefined) out.active = active
  return out
}
