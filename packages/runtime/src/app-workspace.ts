/**
 * App-owned workspaces — every installed app registers one entry in
 * `~/.agentproto/workspaces.json` (slug `app-<appSlug>`, `ownerApp: <appId>`)
 * so sessions the app spawns bucket under the app instead of "default" and
 * the app shows up in `agentproto workspace list`.
 *
 * This is the APP's workspace. It is unrelated to the DAEMON's workspace,
 * which `app-boundary.ts` deliberately keeps hidden from app sessions.
 */

import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { loadAppHandle } from "@agentproto/app-kit"
import {
  addWorkspace,
  findWorkspace,
  loadWorkspacesConfig,
  removeWorkspace,
  sanitizeSlug,
  saveWorkspacesConfig,
  DEFAULT_CONFIG_PATH,
} from "./workspaces-config.js"

export function appWorkspaceSlug(appId: string): string {
  return sanitizeSlug(`app-${appId.replace(/^@/, "").replace(/\//g, "-")}`)
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The home directory a WORKSPACE.md (AIP-34) declares for its app: an inline
 * `local-fs` storage's `mount_path`, or a `dev-local` storage's `root`. Valid
 * means absolute and an existing directory; anything else (no WORKSPACE.md, a
 * remote/ref storage, a missing path) yields `undefined` and the caller falls
 * back to the app dir.
 */
export async function declaredWorkspaceHome(workspace: unknown): Promise<string | undefined> {
  const storage = (workspace as { storage?: { inline?: { provider?: unknown; config?: Record<string, unknown> } } } | undefined)
    ?.storage
  const inline = storage?.inline
  if (!inline || typeof inline.provider !== "string") return undefined
  const raw =
    inline.provider === "local-fs"
      ? inline.config?.mount_path
      : inline.provider === "dev-local"
        ? inline.config?.root
        : undefined
  if (typeof raw !== "string" || !isAbsolute(raw)) return undefined
  return (await isDirectory(raw)) ? raw : undefined
}

export interface RegisterAppWorkspaceInput {
  appId: string
  /** The installed app dir — the default workspace path. */
  dir: string
  /** The `workspace` of the loaded app handle, when it declares one. */
  workspace?: unknown
  configPath?: string
}

/**
 * Register (or update the path of) the app's workspace. Idempotent. Returns
 * the slug the app owns, or `undefined` when registration was skipped: the
 * slug is taken by a workspace this app doesn't own (a user's, or another
 * app's — a user workspace is never clobbered) or the config is unwritable.
 */
export async function registerAppWorkspace(input: RegisterAppWorkspaceInput): Promise<string | undefined> {
  const configPath = input.configPath ?? DEFAULT_CONFIG_PATH()
  const slug = appWorkspaceSlug(input.appId)
  try {
    const path = (await declaredWorkspaceHome(input.workspace)) ?? input.dir
    const config = await loadWorkspacesConfig(configPath)
    const existing = findWorkspace(config, slug)
    if (existing && existing.ownerApp !== input.appId) return undefined
    if (existing && existing.path === path) return slug
    await saveWorkspacesConfig(
      addWorkspace(config, { slug, path, label: input.appId, ownerApp: input.appId }),
      configPath,
    )
    return slug
  } catch (err) {
    console.warn(
      `[app-workspace] could not register workspace for app "${input.appId}": ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }
}

/** The slug of the workspace this app owns, if it is registered (read-only). */
export async function ownedAppWorkspaceSlug(appId: string, configPath?: string): Promise<string | undefined> {
  try {
    const ws = findWorkspace(await loadWorkspacesConfig(configPath ?? DEFAULT_CONFIG_PATH()), appWorkspaceSlug(appId))
    return ws?.ownerApp === appId ? ws.slug : undefined
  } catch {
    return undefined
  }
}

/**
 * Lazy backfill for apps installed before app-owned workspaces existed:
 * returns the app's workspace slug, registering it (re-reading WORKSPACE.md
 * for the declared home) when missing.
 */
export async function ensureAppWorkspace(
  input: { appId: string; dir: string; configPath?: string },
): Promise<string | undefined> {
  const owned = await ownedAppWorkspaceSlug(input.appId, input.configPath)
  if (owned) return owned
  const workspace = await loadAppHandle(input.dir).then(h => h.workspace, () => undefined)
  return registerAppWorkspace({
    appId: input.appId,
    dir: input.dir,
    workspace,
    ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
  })
}

/** Remove the app's workspace, only if it is owned by this very app. */
export async function unregisterAppWorkspace(appId: string, configPath?: string): Promise<boolean> {
  const path = configPath ?? DEFAULT_CONFIG_PATH()
  try {
    const config = await loadWorkspacesConfig(path)
    const ws = findWorkspace(config, appWorkspaceSlug(appId))
    if (!ws || ws.ownerApp !== appId) return false
    await saveWorkspacesConfig(removeWorkspace(config, ws.slug), path)
    return true
  } catch (err) {
    console.warn(
      `[app-workspace] could not remove workspace for app "${appId}": ${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}
