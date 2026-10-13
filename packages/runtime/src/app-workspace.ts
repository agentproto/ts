/**
 * App-owned workspaces — every installed app registers one entry in
 * `~/.agentproto/workspaces.json` (slug `app-<appSlug>`, `ownerApp: <appId>`)
 * so sessions the app spawns bucket under the app instead of "default" and
 * the app shows up in `agentproto workspace list`.
 *
 * This is the APP's workspace. It is unrelated to the DAEMON's workspace,
 * which `app-boundary.ts` deliberately keeps hidden from app sessions.
 */

import { mkdir, readdir, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { loadAppHandle } from "@agentproto/app-kit"
import {
  createGithubFilesystem,
  type BranchPolicy,
  type GitRunner,
  type GithubStorageConfig,
  type PrPolicy,
} from "@agentproto/storage-github"
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

/** Only github.com over HTTPS: the clone sends the user's token to the repo host. */
const GITHUB_REPO_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const DEFAULT_TOKEN_ENV = ["GITHUB_TOKEN", "GH_TOKEN"] as const

/** A WORKSPACE.md `storage: github` / `sync.mode: pull-push` declaration, validated. */
export interface DeclaredGithubWorkspace {
  /** Absolute clone destination (`config.mount_path`). */
  dir: string
  config: GithubStorageConfig
  /** Env var names that may hold the GitHub token, in priority order. */
  tokenEnv: readonly string[]
}

/** Test/host injection for the github clone path. */
export interface GithubWorkspaceOptions {
  /** Token lookup. Default: first set env var among the declared names. */
  resolveToken?: (envNames: readonly string[]) => string | undefined
  /** Overrides the clone URL (local origin in tests). Never read from the manifest:
   *  the token must only ever go to the validated github.com `repoUrl`. */
  cloneUrl?: string
  gitRunner?: GitRunner
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

/**
 * Parse an inline github storage declared in WORKSPACE.md:
 *
 *   storage.inline: { provider: github, config: { repo_url, mount_path, base_branch? },
 *                     sync: { mode: pull-push, push: { branch_policy?, pr_policy? } },
 *                     auth: { state: { env: [GITHUB_TOKEN] } } }
 *
 * `repo_url` may also be written `repoUrl`, etc. (camelCase, as in
 * `GithubStorageConfig`). Anything that doesn't meet every requirement —
 * other sync mode, non-github.com URL, relative or missing `mount_path` —
 * yields `undefined` so the caller falls back to the app dir.
 */
export function declaredGithubWorkspace(workspace: unknown): DeclaredGithubWorkspace | undefined {
  const inline = (workspace as { storage?: { inline?: Record<string, any> } } | undefined)?.storage?.inline
  if (!inline || inline.provider !== "github" || inline.sync?.mode !== "pull-push") return undefined
  const cfg: Record<string, unknown> = inline.config ?? {}
  const repoUrl = str(cfg.repoUrl) ?? str(cfg.repo_url)
  const dir = str(cfg.mountPath) ?? str(cfg.mount_path)
  if (!repoUrl || !GITHUB_REPO_URL.test(repoUrl) || !dir || !isAbsolute(dir)) return undefined
  const push: Record<string, unknown> = inline.sync?.push ?? {}
  const branchPolicy = str(push.branch_policy) ?? str(cfg.branchPolicy) ?? str(cfg.branch_policy)
  const prPolicy = str(push.pr_policy) ?? str(cfg.prPolicy) ?? str(cfg.pr_policy)
  const baseBranch = str(cfg.baseBranch) ?? str(cfg.base_branch) ?? str(cfg.branch)
  const declaredEnv = Array.isArray(inline.auth?.state?.env)
    ? (inline.auth.state.env as unknown[]).filter((n): n is string => typeof n === "string" && ENV_VAR_NAME.test(n))
    : []
  return {
    dir,
    config: {
      repoUrl,
      ...(baseBranch ? { baseBranch } : {}),
      ...(branchPolicy ? { branchPolicy: branchPolicy as BranchPolicy } : {}),
      ...(prPolicy ? { prPolicy: prPolicy as PrPolicy } : {}),
    },
    tokenEnv: declaredEnv.length > 0 ? declaredEnv : DEFAULT_TOKEN_ENV,
  }
}

/**
 * Make sure the declared github workspace exists on disk. Same guard as
 * `git-clone-workstation.ts`: clone only into an EMPTY (or missing) dir; a dir
 * that already holds a git checkout is accepted as-is (no fetch/merge here —
 * that is the sandbox lifecycle's job), and any other non-empty dir is refused
 * rather than overwritten.
 */
async function ensureGithubWorkspace(
  decl: DeclaredGithubWorkspace,
  opts: GithubWorkspaceOptions = {},
): Promise<{ ok: true; dir: string } | { ok: false; reason: string }> {
  const { dir } = decl
  await mkdir(dir, { recursive: true })
  const entries = await readdir(dir)
  if (entries.includes(".git")) return { ok: true, dir }
  if (entries.length > 0) {
    return { ok: false, reason: `"${dir}" is not empty and is not a git checkout — refusing to clone over it` }
  }
  const token = (opts.resolveToken ?? defaultResolveToken)(decl.tokenEnv)
  if (!token) {
    return { ok: false, reason: `no GitHub token (set one of ${decl.tokenEnv.join(", ")})` }
  }
  const config: GithubStorageConfig = {
    ...decl.config,
    ...(opts.cloneUrl !== undefined ? { cloneUrl: opts.cloneUrl } : {}),
  }
  const fs = createGithubFilesystem(
    config,
    { workspaceDir: dir, token },
    opts.gitRunner ? { gitRunner: opts.gitRunner } : {},
  )
  const res = await fs.pull(fs)
  return res.seeded ? { ok: true, dir } : { ok: false, reason: res.message ?? "clone failed" }
}

function defaultResolveToken(envNames: readonly string[]): string | undefined {
  for (const name of envNames) {
    const v = process.env[name]
    if (v) return v
  }
  return undefined
}

/**
 * The home directory a WORKSPACE.md (AIP-34) declares for its app: an inline
 * `local-fs` storage's `mount_path`, a `dev-local` storage's `root`, or the
 * clone of a `github` / `pull-push` storage (cloned on first use, see
 * `ensureGithubWorkspace`). Valid means absolute and an existing directory;
 * anything else (no WORKSPACE.md, a remote/ref storage, a missing path, a
 * failed clone) yields `undefined` and the caller falls back to the app dir.
 */
export async function declaredWorkspaceHome(
  workspace: unknown,
  github: GithubWorkspaceOptions = {},
): Promise<string | undefined> {
  const gh = declaredGithubWorkspace(workspace)
  if (gh) {
    try {
      const res = await ensureGithubWorkspace(gh, github)
      if (res.ok) return res.dir
      console.warn(`[app-workspace] github workspace not used: ${res.reason}`)
    } catch (err) {
      console.warn(`[app-workspace] github workspace not used: ${err instanceof Error ? err.message : String(err)}`)
    }
    return undefined
  }
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
  github?: GithubWorkspaceOptions
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
    const path = (await declaredWorkspaceHome(input.workspace, input.github)) ?? input.dir
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
