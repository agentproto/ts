/**
 * "Dirty, but no work": the proof gc needs before it may reclaim a worktree
 * whose tree is not clean. `computeTreeState` (status.ts) only knows paths:
 * any status entry off the `noisePaths` allowlist is dirt, and a dirty tree
 * never reaches `reclaim`. Three shapes of dirt observed in the field carry
 * nothing to save, and this module proves each one from content, never from
 * a path name:
 *
 *   - `emptied-checkout`: every file in HEAD is deleted from the working
 *     tree (a checkout someone `rm -rf`'d or a sync tool emptied). Nothing
 *     exists on disk to salvage.
 *   - `turbo-managed-block`: the only difference from HEAD is the block
 *     `turbo` writes by itself into `AGENTS.md` when it detects an AI agent
 *     (`<!-- BEGIN:turborepo-agent-rules -->` ... `<!-- END:... -->`, opening
 *     with `# This is NOT the Turborepo you know`). Tool output, not work.
 *   - `on-base`: the uncommitted version of a path is byte-identical to the
 *     base ref's blob at that path (or the path is absent on both sides):
 *     the same change already landed through another PR.
 *
 * Fail-closed throughout: an entry that fits none of the three (one
 * untracked file not on base, one edited line, a conflict, a rename, a
 * submodule, a symlink, a read error) makes the whole proof `null`, and the
 * caller keeps whatever class it had before.
 */

import { lstat, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { execArgv } from "./exec.js"

export type DirtyNoWorkCase = "emptied-checkout" | "turbo-managed-block" | "on-base"

/** One dirty path a removal must put back to HEAD before git's non-force `worktree remove` accepts the tree. */
export interface DirtyNoWorkPath {
  path: string
  /** HEAD has the path: restore it from HEAD. Otherwise delete it (and drop it from the index if staged). */
  inHead: boolean
  /** The index differs from HEAD at this path. */
  staged: boolean
}

export interface DirtyNoWorkProof {
  /** Which sub-cases explained the dirt, sorted, each listed once. */
  cases: DirtyNoWorkCase[]
  paths: DirtyNoWorkPath[]
}

export const TURBO_BLOCK_BEGIN = "<!-- BEGIN:turborepo-agent-rules -->"
export const TURBO_BLOCK_END = "<!-- END:turborepo-agent-rules -->"
export const TURBO_BLOCK_HEADING = "# This is NOT the Turborepo you know"

const ABSENT_MODE = "000000"
const TURBO_BLOCK_RE = /\n*<!-- BEGIN:turborepo-agent-rules -->\n([\s\S]*?)<!-- END:turborepo-agent-rules -->\n*/g

/** A blob version of one path: `null` when the path does not exist there. */
type Version = { mode: string; sha: string } | null

interface Entry {
  path: string
  head: Version
  index: Version
  /** `undefined` until hashed; `null` when the file is gone from the working tree. */
  work: Version | undefined
  /** git's recorded working-tree mode (porcelain `mW`); unset for an untracked path. */
  workMode?: string
  untracked: boolean
}

function sameVersion(a: Version, b: Version): boolean {
  if (a === null || b === null) return a === b
  return a.mode === b.mode && a.sha === b.sha
}

function version(mode: string, sha: string): Version {
  return mode === ABSENT_MODE || /^0+$/.test(sha) ? null : { mode, sha }
}

async function git(repoRoot: string, args: readonly string[]): Promise<string> {
  const res = await execArgv("git", ["--no-optional-locks", ...args], repoRoot)
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr.trim()}`)
  return res.stdout
}

/** Parse `status --porcelain=v2 -z`; `null` on any record shape this proof refuses to reason about. */
function parseStatus(stdout: string): Entry[] | null {
  const records = stdout.split("\0").filter((r) => r.length > 0)
  const entries: Entry[] = []
  for (const record of records) {
    if (record.startsWith("? ")) {
      const path = record.slice(2)
      // A nested repo shows as `? dir/` even with `--untracked-files=all`.
      if (path.endsWith("/")) return null
      entries.push({ path, head: null, index: null, work: undefined, untracked: true })
      continue
    }
    if (record.startsWith("# ")) continue
    // `2` (rename/copy) is ruled out by `--no-renames`; `u` is a conflict.
    if (!record.startsWith("1 ")) return null
    const parts = record.split(" ")
    const [, xy = "", sub = "", mH = "", mI = "", mW = "", hH = "", hI = ""] = parts
    if (sub !== "N...") return null
    if ([mH, mI, mW].some((m) => m === "160000" || m === "120000")) return null
    const path = parts.slice(8).join(" ")
    const index = version(mI, hI)
    const y = xy[1] ?? "."
    entries.push({
      path,
      head: version(mH, hH),
      index,
      // Unchanged against the index: the working tree holds exactly the index version.
      work: y === "." ? index : y === "D" ? null : undefined,
      workMode: mW,
      untracked: false,
    })
  }
  return entries
}

/** Fill in the working-tree version of every entry that still needs hashing (same clean filters as `git add`). */
async function hashWorkingTree(repoRoot: string, worktreePath: string, entries: Entry[]): Promise<void> {
  const pending = entries.filter((e) => e.work === undefined)
  const modes = new Map<Entry, string>()
  for (const e of pending) {
    const st = await lstat(join(worktreePath, e.path))
    if (!st.isFile()) throw new Error(`not a regular file: ${e.path}`)
    // A tracked path keeps git's recorded worktree mode; an untracked one takes it from disk.
    modes.set(e, e.workMode ?? (st.mode & 0o111 ? "100755" : "100644"))
  }
  for (let i = 0; i < pending.length; i += 500) {
    const chunk = pending.slice(i, i + 500)
    const shas = (await git(repoRoot, ["-C", worktreePath, "hash-object", "--", ...chunk.map((e) => e.path)]))
      .split("\n")
      .filter((l) => l.length > 0)
    if (shas.length !== chunk.length) throw new Error("hash-object returned the wrong number of hashes")
    chunk.forEach((e, j) => {
      e.work = { mode: modes.get(e)!, sha: shas[j]! }
    })
  }
}

async function readTree(repoRoot: string, ref: string): Promise<Map<string, Version>> {
  const out = await git(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", ref])
  const tree = new Map<string, Version>()
  for (const line of out.split("\0")) {
    if (!line) continue
    const tab = line.indexOf("\t")
    const [mode = "", , sha = ""] = line.slice(0, tab).split(" ")
    tree.set(line.slice(tab + 1), { mode, sha })
  }
  return tree
}

/**
 * Strip turbo's managed block (and the blank lines around it) and trailing
 * whitespace, so "HEAD" and "HEAD plus the block" compare equal. `null` when
 * the text has a BEGIN marker without a matching END: a half-written block
 * proves nothing.
 */
function withoutTurboBlock(text: string): string | null {
  const stripped = text.replace(TURBO_BLOCK_RE, "\n")
  if (stripped.includes(TURBO_BLOCK_BEGIN) || stripped.includes(TURBO_BLOCK_END)) return null
  return stripped.trimEnd()
}

/** The working-tree file is HEAD's content plus turbo's managed block, nothing else. */
async function isTurboBlockOnly(repoRoot: string, worktreePath: string, entry: Entry): Promise<boolean> {
  const work = entry.work
  if (!work) return false
  if (entry.head ? work.mode !== entry.head.mode : work.mode !== "100644") return false
  const current = await readFile(join(worktreePath, entry.path), "utf8")
  const blocks = [...current.matchAll(TURBO_BLOCK_RE)]
  if (blocks.length !== 1 || !(blocks[0]![1] ?? "").trimStart().startsWith(TURBO_BLOCK_HEADING)) return false
  const original = entry.head ? await git(repoRoot, ["-C", worktreePath, "cat-file", "blob", entry.head.sha]) : ""
  const a = withoutTurboBlock(current)
  const b = withoutTurboBlock(original)
  return a !== null && a === b
}

/**
 * Prove that every dirty entry of `worktreePath` falls into one of the three
 * no-work cases (module doc). Returns the proof, or `null` when anything is
 * unexplained or any read fails. A clean tree returns `null` too: there is
 * nothing to prove.
 */
export async function proveDirtCarriesNoWork(
  repoRoot: string,
  worktreePath: string,
  baseRef: string,
): Promise<DirtyNoWorkProof | null> {
  try {
    const status = await git(repoRoot, [
      "-C",
      worktreePath,
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--ignore-submodules=none",
    ])
    const entries = parseStatus(status)
    if (!entries || entries.length === 0) return null

    await hashWorkingTree(repoRoot, worktreePath, entries)

    const cases = new Set<DirtyNoWorkCase>()
    const unexplained: Entry[] = []

    // Case 1: every file HEAD has is gone from disk. Those deletions are
    // explained; anything else still needs case 2 or 3 below.
    const deletions = entries.filter((e) => e.head !== null && e.work === null && (e.index === null || sameVersion(e.index, e.head)))
    let emptied = false
    if (deletions.length > 0) {
      const headFiles = (await git(repoRoot, ["-C", worktreePath, "ls-tree", "-r", "-z", "--name-only", "HEAD"]))
        .split("\0")
        .filter((p) => p.length > 0).length
      emptied = deletions.length === headFiles
    }
    for (const e of entries) {
      if (emptied && deletions.includes(e)) {
        cases.add("emptied-checkout")
        continue
      }
      unexplained.push(e)
    }

    let base: Map<string, Version> | null = null
    for (const e of unexplained) {
      // What removal would lose: the index and working-tree versions that differ from HEAD.
      const lost: Version[] = []
      if (!sameVersion(e.index, e.head)) lost.push(e.index)
      if (!sameVersion(e.work ?? null, e.head) && !sameVersion(e.work ?? null, e.index)) lost.push(e.work ?? null)
      if (lost.length === 0) continue
      base ??= await readTree(repoRoot, baseRef)
      const onBase = base.get(e.path) ?? null
      if (lost.every((v) => sameVersion(v, onBase))) {
        cases.add("on-base")
        continue
      }
      // Case 2 explains only the working-tree version, with an index that is HEAD's or the same file.
      const indexOk = sameVersion(e.index, e.head) || sameVersion(e.index, e.work ?? null)
      if (indexOk && (await isTurboBlockOnly(repoRoot, worktreePath, e))) {
        cases.add("turbo-managed-block")
        continue
      }
      return null
    }
    if (cases.size === 0) return null
    return {
      cases: [...cases].sort(),
      paths: entries.map((e) => ({ path: e.path, inHead: e.head !== null, staged: !sameVersion(e.index, e.head) })),
    }
  } catch {
    // A read error proves nothing.
    return null
  }
}

/**
 * Put every proven path back to HEAD so git's own non-force `worktree remove`
 * accepts the tree: restore a HEAD path (index and file), drop a non-HEAD one
 * from the index and from disk. Only ever the exact paths the fresh proof
 * listed; anything else that turned dirty since still makes git refuse.
 *
 * The proof was read moments earlier (apply re-proves from scratch), but a
 * working-tree-only edit landing between that read and this discard does not
 * move the git index mtime, so the apply-time stale check cannot see it. This
 * matches `discardNoise`'s window and posture; closing it fully would mean a
 * content re-verify per path here, which the non-force removal does not need
 * (anything dirty outside these paths still makes git refuse).
 */
export async function discardProvenDirt(repoRoot: string, worktreePath: string, paths: readonly DirtyNoWorkPath[]): Promise<void> {
  const inHead = paths.filter((p) => p.inHead).map((p) => p.path)
  const stagedNew = paths.filter((p) => !p.inHead && p.staged).map((p) => p.path)
  for (let i = 0; i < inHead.length; i += 500) {
    await git(repoRoot, ["--literal-pathspecs", "-C", worktreePath, "checkout", "HEAD", "--", ...inHead.slice(i, i + 500)])
  }
  for (let i = 0; i < stagedNew.length; i += 500) {
    await git(repoRoot, ["--literal-pathspecs", "-C", worktreePath, "rm", "--cached", "-q", "--ignore-unmatch", "--", ...stagedNew.slice(i, i + 500)])
  }
  for (const p of paths) if (!p.inHead) await rm(join(worktreePath, p.path), { force: true })
}
