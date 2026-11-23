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

import { constants } from "node:fs"
import { copyFile, lstat, mkdir, open, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { execArgv } from "./exec.js"
import type { BranchDeletionDecision } from "./branch-deletion.js"
import { computeProvenance, type ProvenanceInfo } from "./provenance.js"

export const SALVAGE_ROOT = (): string => resolve(homedir(), ".agentproto", "worktree-salvage")

export interface SalvageManifest {
  repo: string
  /** `null` for a detached HEAD. */
  branch: string | null
  tipSha: string
  createdAt: string
  /** Relative paths of every unignored untracked regular file that was copied in. */
  untrackedFiles: string[]
  /** Untracked symbolic links, recreated in the archive with their target kept verbatim (never followed, never copied). Absent in older manifests. */
  symlinks?: Array<{ path: string; target: string }>
  /** Untracked entries that cannot be byte-copied (socket, fifo, device): listed, not archived, so one of them cannot block the whole salvage. */
  skippedEntries?: Array<{ path: string; kind: string }>
  /** Whether `changes.patch` has any content (tracked-file changes existed). */
  hasPatch: boolean
  provenance: ProvenanceInfo
  /** What `archive` decided to do with the branch (kept or deleted) and why; written before the removal runs, so it is the intent. Absent for a detached HEAD or a gc salvage. */
  branchDecision?: BranchDeletionDecision
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
  /** Recorded verbatim in MANIFEST.json. */
  branchDecision?: BranchDeletionDecision
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
  const res = await execArgv("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard", "-z"], repoRoot)
  if (res.exitCode !== 0) {
    throw new Error(`git ls-files --others failed in ${worktreePath} (exit ${res.exitCode}): ${res.stderr.trim()}`)
  }
  // -z: NUL-separated, never C-quoted (core.quotePath) and safe for newlines in names.
  return res.stdout.split("\0").filter(Boolean)
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
  const handle = await open(path, "r")
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
  const parent = resolve(input.salvageRoot ?? SALVAGE_ROOT(), sanitizeSegment(input.repoName))
  // Always a fresh directory for THIS call: a same-day replay of the same tip
  // gets `-2`, `-3`, ... instead of mixing into (or cleaning up) an earlier archive.
  const createdParent = await mkdir(parent, { recursive: true })
  let dir = resolve(parent, dirName)
  for (let n = 2; ; n++) {
    try {
      await mkdir(dir)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      dir = resolve(parent, `${dirName}-${n}`)
    }
  }
  const createdRoot = createdParent ?? dir

  try {
    const [patch, untrackedEntries, provenance] = await Promise.all([
      diffHead(input.repoRoot, input.worktreePath),
      listUntrackedFiles(input.repoRoot, input.worktreePath),
      computeProvenance(input.repoRoot, input.worktreePath, { sessionsPath: input.sessionsPath }),
    ])

    await writeFileSynced(join(dir, "changes.patch"), patch)

    const untrackedFiles: string[] = []
    const symlinks: Array<{ path: string; target: string }> = []
    const skippedEntries: Array<{ path: string; kind: string }> = []
    const archiveEntry = async (relPath: string, top: boolean): Promise<void> => {
      const src = join(input.worktreePath, relPath)
      const dest = join(dir, "untracked", relPath)
      let st
      try {
        st = await lstat(src)
      } catch (err) {
        // A top-level entry git just listed must exist: failing here keeps the worktree.
        // Below a directory, an entry that vanished mid-walk is simply gone.
        if (!top && (err as NodeJS.ErrnoException).code === "ENOENT") return
        throw err
      }
      if (st.isSymbolicLink()) {
        // Keep the link itself; `copyFile`/`open` would follow it (ENOTSUP onto a directory).
        const target = await readlink(src)
        await mkdir(dirname(dest), { recursive: true })
        await symlink(target, dest)
        symlinks.push({ path: relPath, target })
      } else if (st.isFile()) {
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(src, dest)
        await fsyncFile(dest)
        untrackedFiles.push(relPath)
      } else if (st.isDirectory()) {
        // e.g. an untracked nested git repo, which git lists as a single `dir/` entry.
        await mkdir(dest, { recursive: true })
        for (const name of (await readdir(src)).sort()) await archiveEntry(`${relPath}/${name}`, false)
      } else {
        skippedEntries.push({ path: relPath, kind: entryKind(st) })
      }
    }
    for (const entry of untrackedEntries) await archiveEntry(entry.replace(/\/+$/, ""), true)

    const manifest: SalvageManifest = {
      repo: input.repoName,
      branch: input.branch,
      tipSha: input.tipSha,
      createdAt,
      untrackedFiles,
      ...(symlinks.length ? { symlinks } : {}),
      ...(skippedEntries.length ? { skippedEntries } : {}),
      hasPatch: patch.length > 0,
      provenance,
      ...(input.branchDecision ? { branchDecision: input.branchDecision } : {}),
    }
    await writeFileSynced(join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n")

    return { dir, manifest }
  } catch (err) {
    // Never leave a half-written archive behind; only what THIS call created, never the worktree.
    await rm(createdRoot, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

function entryKind(st: import("node:fs").Stats): string {
  if (st.isDirectory()) return "directory"
  if (st.isSocket()) return "socket"
  if (st.isFIFO()) return "fifo"
  if (st.isBlockDevice() || st.isCharacterDevice()) return "device"
  return "other"
}

/**
 * Restore a salvage archive into `targetPath`: copies the untracked files,
 * recreates the symlinks (target verbatim) and
 * applies `changes.patch` when it has content. Never overwrites: a path that
 * already exists (a dangling link counts) is skipped and returned in `skipped`.
 */
export async function restoreSalvage(
  salvageDir: string,
  targetPath: string,
): Promise<{ files: number; symlinks: number; patchApplied: boolean; skipped: string[] }> {
  const manifest = JSON.parse(await readFile(join(salvageDir, "MANIFEST.json"), "utf8")) as SalvageManifest
  const skipped: string[] = []
  const exists = (p: string) => lstat(p).then(() => true, () => false)
  let files = 0
  let links = 0
  for (const relPath of manifest.untrackedFiles) {
    const dest = join(targetPath, relPath)
    if (await exists(dest)) {
      skipped.push(relPath)
      continue
    }
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(salvageDir, "untracked", relPath), dest, constants.COPYFILE_EXCL)
    files++
  }
  for (const link of manifest.symlinks ?? []) {
    const dest = join(targetPath, link.path)
    if (await exists(dest)) {
      skipped.push(link.path)
      continue
    }
    await mkdir(dirname(dest), { recursive: true })
    await symlink(link.target, dest)
    links++
  }
  let patchApplied = false
  if (manifest.hasPatch) {
    const res = await execArgv("git", ["-C", targetPath, "apply", join(salvageDir, "changes.patch")], targetPath)
    if (res.exitCode !== 0) throw new Error(`git apply failed in ${targetPath} (exit ${res.exitCode}): ${res.stderr.trim()}`)
    patchApplied = true
  }
  return { files, symlinks: links, patchApplied, skipped }
}
