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

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, resolve } from "node:path"

export const WORKSPACES_CONFIG_VERSION = 1 as const

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

/** The active workspace, or undefined when none is registered. Pure
 *  convenience to avoid re-implementing the lookup at every caller. */
export function getActiveWorkspace(
  config: WorkspacesConfig
): WorkspaceEntry | undefined {
  if (!config.active) return config.workspaces[0]
  return findWorkspace(config, config.active) ?? config.workspaces[0]
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
