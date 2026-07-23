/**
 * Salvage-before-discard (PLAN.md §5.2 layer 4). `worktree archive` re-earns
 * its name by snapshotting a worktree's uncommitted state before it removes
 * anything: `git diff HEAD` → `changes.patch`, plus a byte-copy of every
 * unignored untracked file, into
 * `~/.agentproto/worktree-salvage/<repoName>/<slug>-<tipSha7>-<date>/` with a
 * `MANIFEST.json`. Every file is fsynced before this returns — only once the
 * snapshot is durable does the caller proceed to force-remove.
 *
 * Deliberately forge-independent: no PR lookup here. This writer's only job
 * is "don't lose bytes before deletion," not classification — `ls --status`
 * (status.ts) already owns the forge-derived `integration` axis, and gc
 * (PR-D) is where a salvage manifest and a status entry would be cross-
 * referenced, not here.
 */

import { copyFile, mkdir, open, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { execArgv } from "./exec.js"
import { computeProvenance, type ProvenanceInfo } from "./provenance.js"

export const SALVAGE_ROOT = (): string => resolve(homedir(), ".agentproto", "worktree-salvage")

export interface SalvageManifest {
  repo: string
  /** `null` for a detached HEAD. */
  branch: string | null
  tipSha: string
  createdAt: string
  /** Relative paths of every unignored untracked file that was copied in. */
  untrackedFiles: string[]
  /** Whether `changes.patch` has any content (tracked-file changes existed). */
  hasPatch: boolean
  provenance: ProvenanceInfo
}

export interface SalvageWorktreeInput {
  /** The main repo root — the stable spawn anchor for this worktree's git reads (see `listUntrackedFiles`'s doc). */
  repoRoot: string
  repoName: string
  worktreePath: string
  branch: string | null
  tipSha: string
  /** Identifies this worktree in the salvage directory name, e.g. its slug or branch. */
  slug: string
  sessionsPath?: string
  /** Injectable clock so tests can freeze `createdAt` / the directory name. */
  now?: () => string
  /** Override for `~/.agentproto/worktree-salvage` — tests use a temp dir. */
  salvageRoot?: string
}

export interface SalvageResult {
  dir: string
  manifest: SalvageManifest
}

/**
 * Untracked, non-ignored files in the worktree — the same class `git
 * worktree remove` refuses without `--force`. Spawn `cwd` is `repoRoot`, not
 * `worktreePath` — a linked worktree can be removed by a concurrent `gc`
 * reap (or a racing status read) while this call is in flight, and a spawn
 * whose `cwd` no longer exists fails `ENOENT` on the COMMAND itself (a
 * Node/libuv quirk), not the directory — see `exec.ts`'s `execGit`, which
 * anchors the same way.
 */
async function listUntrackedFiles(repoRoot: string, worktreePath: string): Promise<string[]> {
  const res = await execArgv("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"], repoRoot)
  if (res.exitCode !== 0) {
    throw new Error(`git ls-files --others failed in ${worktreePath} (exit ${res.exitCode}): ${res.stderr.trim()}`)
  }
  return res.stdout.split("\n").filter(Boolean)
}

/** `git diff HEAD` — staged + unstaged changes to tracked files, uniformly.
 *  Empty string on a clean tree. Spawn `cwd` is `repoRoot`, not
 *  `worktreePath` — see `listUntrackedFiles`'s doc. */
async function diffHead(repoRoot: string, worktreePath: string): Promise<string> {
  const res = await execArgv("git", ["-C", worktreePath, "diff", "HEAD"], repoRoot)
  if (res.exitCode !== 0) {
    throw new Error(`git diff HEAD failed in ${worktreePath} (exit ${res.exitCode}): ${res.stderr.trim()}`)
  }
  return res.stdout
}

/** Sanitize a path segment for use in the salvage directory name (no slashes, no leading dot-dot). */
function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+/, "") || "worktree"
}

/** fsync one file by path — the durability guarantee: only after this resolves is the byte "saved". */
async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r+")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeFileSynced(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf8")
  await fsyncFile(path)
}

/**
 * Snapshot `worktreePath`'s uncommitted state into a fresh salvage
 * directory. Safe to call on a clean tree (writes an empty patch, no
 * untracked files, still a manifest) — every path this function returns is
 * fsynced before it resolves.
 */
export async function salvageWorktree(input: SalvageWorktreeInput): Promise<SalvageResult> {
  const now = input.now ?? (() => new Date().toISOString())
  const createdAt = now()
  const tipShort = input.tipSha.slice(0, 7)
  const dateStamp = createdAt.slice(0, 10)
  const dirName = `${sanitizeSegment(input.slug)}-${tipShort}-${dateStamp}`
  const dir = resolve(input.salvageRoot ?? SALVAGE_ROOT(), sanitizeSegment(input.repoName), dirName)
  await mkdir(dir, { recursive: true })

  const [patch, untrackedFiles, provenance] = await Promise.all([
    diffHead(input.repoRoot, input.worktreePath),
    listUntrackedFiles(input.repoRoot, input.worktreePath),
    computeProvenance(input.repoRoot, input.worktreePath, { sessionsPath: input.sessionsPath }),
  ])

  await writeFileSynced(join(dir, "changes.patch"), patch)

  for (const relPath of untrackedFiles) {
    const dest = join(dir, "untracked", relPath)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(input.worktreePath, relPath), dest)
    await fsyncFile(dest)
  }

  const manifest: SalvageManifest = {
    repo: input.repoName,
    branch: input.branch,
    tipSha: input.tipSha,
    createdAt,
    untrackedFiles,
    hasPatch: patch.length > 0,
    provenance,
  }
  await writeFileSynced(join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n")

  return { dir, manifest }
}
