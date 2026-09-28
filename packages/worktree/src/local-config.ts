import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import { ConfigError } from "./config.js"

/**
 * `<workspace>/.agentproto/worktree.json` — a LOCAL, host-owned worktree
 * lifecycle default, read straight off disk (never `git show`, never a
 * worktree's own tree). Same idea as `<workspace>/.agentproto/allowed-
 * commands.json` (`command-allowlist.ts`): a per-machine setting that lets
 * one host declare what a fresh worktree needs (a `node_modules` clone, a
 * per-worktree pnpm store) without committing that machine's paths into the
 * repo. `.agentproto/` is gitignored repo-wide (see this repo's own
 * `.gitignore`), so this file can never ride in on a branch — there is
 * nothing here for `config.ts`'s "only what a reviewer merged" guarantee to
 * defend against; the trust model is simply "whoever owns this machine's
 * filesystem".
 *
 * `workspace` is the SOURCE checkout — the same directory passed as
 * `provisionWorktreeTool`'s `repoRoot` — never the freshly created worktree
 * (which starts with no `.agentproto/worktree.json` of its own, since the
 * dir is gitignored and nothing copies it in).
 */
export const LOCAL_WORKTREE_CONFIG_REL = ".agentproto/worktree.json"

const localWriteFileEntrySchema = z.object({
  path: z.string().min(1, "writeFiles[].path must be non-empty"),
  content: z.string(),
  mode: z.enum(["create", "append"]).optional(),
})

const localWorktreeConfigSchema = z.object({
  copyGlobs: z.array(z.string()).optional(),
  /** Gitignored dirs/files cloned (copy-on-write where the filesystem
   *  supports it) from the source checkout into the worktree before
   *  `depsCmd` runs — see `clone.ts`. */
  cloneGlobs: z.array(z.string()).optional(),
  writeFiles: z.array(localWriteFileEntrySchema).optional(),
  depsCmd: z.string().optional(),
  linkPaths: z.array(z.string()).optional(),
})

export type LocalWriteFileEntry = z.infer<typeof localWriteFileEntrySchema>
export type LocalWorktreeConfig = z.infer<typeof localWorktreeConfigSchema>

/**
 * Parse + validate raw `worktree.json` text. Throws {@link ConfigError} on
 * malformed JSON or a schema violation — same failure shape as
 * `config.ts`'s `parseConfig`, so callers can handle both uniformly.
 */
export function parseLocalWorktreeConfig(raw: string): LocalWorktreeConfig {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(
      `${LOCAL_WORKTREE_CONFIG_REL} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const result = localWorktreeConfigSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ")
    throw new ConfigError(`${LOCAL_WORKTREE_CONFIG_REL} failed validation: ${issues}`)
  }
  return result.data
}

/**
 * Load `<workspace>/.agentproto/worktree.json` straight off disk. Returns
 * `null` when the file is absent (the common case — most workspaces don't
 * opt in). Throws {@link ConfigError} on a present-but-invalid file.
 */
export async function loadLocalWorktreeConfig(
  workspace: string,
): Promise<LocalWorktreeConfig | null> {
  const path = resolve(workspace, LOCAL_WORKTREE_CONFIG_REL)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  return parseLocalWorktreeConfig(raw)
}

const SLUG_PLACEHOLDER = /\{slug\}/g

/** Substitute the literal `{slug}` token for `slug` in `text`. */
export function applySlugPlaceholder(text: string, slug: string): string {
  return text.replace(SLUG_PLACEHOLDER, slug)
}

/**
 * Resolve a local config's `writeFiles` for one concrete worktree: expands
 * `{slug}` in `path`/`content` so a declarative entry (e.g. a pnpm
 * `virtualStoreDir` pointed outside the worktree) can be written once and
 * still land at a distinct, collision-free path per worktree.
 */
export function resolveLocalWriteFiles(
  files: readonly LocalWriteFileEntry[] | undefined,
  slug: string,
): LocalWriteFileEntry[] {
  return (files ?? []).map((file) => ({
    ...file,
    path: applySlugPlaceholder(file.path, slug),
    content: applySlugPlaceholder(file.content, slug),
  }))
}
