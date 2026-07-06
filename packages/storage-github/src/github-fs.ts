/**
 * `GithubFilesystem` — implements `SyncTree` against a local working-tree
 * directory AND `WorkspaceSync` for the pull/push lifecycle. The factory
 * slot in `defineGithubStorage` returns one of these; callers feature-detect
 * the sync surface with `hasWorkspaceSync(fs)` from `@agentproto/storage`.
 *
 * Paths are workspace-relative; the filesystem resolves them against
 * `workspaceDir` from the factory context. `walk` skips `.git`.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import {
  createGithubWorkspaceSync,
  type GithubWorkspaceSyncOpts,
} from "./github-sync.js"
import type { GithubFactoryContext, GithubStorageConfig } from "./types.js"
import type { SyncTree, WorkspaceSync } from "@agentproto/storage"

/** Filesystem + sync surface for a github-backed workspace. */
export type GithubFilesystem = SyncTree & WorkspaceSync

/**
 * Create a `GithubFilesystem` bound to `workspaceDir`. The `WorkspaceSync`
 * surface (`pull`/`push`) is wired in via `createGithubWorkspaceSync` so
 * `hasWorkspaceSync(fs)` returns true.
 *
 * `extra` is for test injection (`gitRunner`, `prCreator`); production
 * callers omit it.
 */
export function createGithubFilesystem(
  config: GithubStorageConfig,
  ctx: GithubFactoryContext,
  extra: Partial<Pick<GithubWorkspaceSyncOpts, "gitRunner" | "prCreator">> = {},
): GithubFilesystem {
  const tree: SyncTree = {
    async exists(path: string): Promise<boolean> {
      try {
        await stat(join(ctx.workspaceDir, path))
        return true
      } catch {
        return false
      }
    },
    async readFile(path: string): Promise<string> {
      return readFile(join(ctx.workspaceDir, path), "utf8")
    },
    async writeFile(path: string, content: string): Promise<void> {
      const full = join(ctx.workspaceDir, path)
      const slash = full.lastIndexOf(sep)
      if (slash > 0) await mkdir(full.slice(0, slash), { recursive: true })
      await writeFile(full, content)
    },
    async walk(path: string): Promise<readonly string[]> {
      const root = join(ctx.workspaceDir, path)
      const out: string[] = []
      async function recurse(dir: string): Promise<void> {
        let entries: Dirent[]
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (e.name === ".git") continue
          const full = join(dir, e.name)
          if (e.isDirectory()) {
            await recurse(full)
          } else {
            out.push(relative(ctx.workspaceDir, full).split(sep).join("/"))
          }
        }
      }
      await recurse(root)
      return out
    },
  }

  const sync = createGithubWorkspaceSync(config, ctx, extra)
  return { ...tree, ...sync }
}
