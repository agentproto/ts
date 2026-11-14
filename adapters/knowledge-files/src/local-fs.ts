/**
 * LocalFs — a `FsPort` (from `@agentproto/corpus`) backed by node:fs.
 *
 * The studio files provider never shipped its own `FsPort`: the guild host
 * resolved one (`resolveWorkspaceFs`) and injected it. agentproto-side that
 * host is gone (the guild registry stays studio-side per the Ph4 plan), so
 * this package ships the minimal local backing that lets the adapter run
 * standalone — the same role the code-brain adapter's own gbrain client plays.
 *
 * Mirrors `@agentproto/corpus-cli`'s `NodeFsAdapter` (that class lives in a
 * `-cli` package; a library adapter must not take a `-cli` edge, so the small
 * node:fs surface the files engine needs is re-implemented here). Paths are
 * workspace-relative and resolved under `root`; `resolve()` refuses to climb
 * out of it. `walk()` returns workspace-relative paths (readable back through
 * `readFile`) and skips hidden segments, exactly as `FsPort` specifies. `lock`
 * is a single-process no-op — this backing is local CLI, which the port
 * contract explicitly permits.
 */

import { randomBytes } from "node:crypto"
import type { Dirent, Stats } from "node:fs"
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import type { FsLockHandle, FsPort, FsStat } from "@agentproto/corpus"

export interface LocalFsOptions {
  /**
   * Absolute path to the workspace root. Every `FsPort` path is resolved
   * relative to this — the adapter never sees a host filesystem path.
   */
  readonly root: string
}

/** A file found by {@link LocalFs.walkStat}: workspace-relative path, size in
 *  bytes, and mtime in whole milliseconds (as `stat().modifiedAt`). */
export interface WalkStatEntry {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

/** Max `stat` calls in flight per directory during {@link LocalFs.walkStat}. */
const WALK_STAT_CONCURRENCY = 32
/** {@link LocalFs.walkStat} yields to the event loop every this many entries. */
const WALK_STAT_YIELD_EVERY = 2_000

export class LocalFs implements FsPort {
  private readonly root: string

  constructor(opts: LocalFsOptions) {
    this.root = opts.root
  }

  async exists(p: string): Promise<boolean> {
    try {
      await stat(this.resolve(p))
      return true
    } catch {
      return false
    }
  }

  async readFile(p: string): Promise<string> {
    return await readFile(this.resolve(p), "utf8")
  }

  /**
   * Atomic write: write to `${target}.tmp-{nonce}`, then rename. Rename is
   * atomic on the same filesystem. Creates parent dirs as needed.
   */
  async writeFile(p: string, content: string): Promise<void> {
    const target = this.resolve(p)
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${randomBytes(8).toString("hex")}`
    await writeFile(tmp, content, "utf8")
    await rename(tmp, target)
  }

  async appendFile(p: string, content: string): Promise<void> {
    const target = this.resolve(p)
    await mkdir(path.dirname(target), { recursive: true })
    await appendFile(target, content, "utf8")
  }

  async readdir(p: string): Promise<readonly string[]> {
    return await readdir(this.resolve(p))
  }

  async walk(p: string): Promise<readonly string[]> {
    const out: string[] = []
    const start = this.resolve(p)
    const visit = async (dir: string): Promise<void> => {
      let entries: string[] = []
      try {
        entries = await readdir(dir)
      } catch {
        return
      }
      for (const ent of entries) {
        // Skip hidden segments — matches the FsPort contract.
        if (ent.startsWith(".")) continue
        const full = path.join(dir, ent)
        const s = await stat(full)
        if (s.isDirectory()) {
          await visit(full)
        } else if (s.isFile()) {
          out.push(path.relative(this.root, full).split(path.sep).join("/"))
        }
      }
    }
    await visit(start)
    return out
  }

  /**
   * {@link walk} plus each file's size and mtime, in one pass: the stat-only
   * scan the files engine reconciles its on-disk index with. Same paths and
   * hidden-segment rule as `walk`, but directory entries are typed by
   * `readdir`, so only files (and symlinks) cost a `stat`, and the stats of a
   * directory run concurrently. Not part of `FsPort`: the adapter uses it when
   * the backing has it and falls back to `walk` + `stat` otherwise.
   */
  async walkStat(p: string): Promise<WalkStatEntry[]> {
    const out: WalkStatEntry[] = []
    const visit = async (dir: string): Promise<void> => {
      let entries: Dirent[] = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      // Stat the non-directories of this level concurrently, then emit in
      // readdir order, recursing in place, so paths come out in `walk` order.
      const visible = entries.filter(ent => !ent.name.startsWith("."))
      const toStat = visible.filter(ent => !ent.isDirectory())
      const stats = new Map<string, Stats | null>()
      for (let i = 0; i < toStat.length; i += WALK_STAT_CONCURRENCY) {
        const step = toStat.slice(i, i + WALK_STAT_CONCURRENCY)
        // A file whose stat fails (vanished mid-scan, or a transient error)
        // is left out; for the reconcile that reads as gone, so its row is
        // dropped and the next scan that sees it re-indexes it.
        const got = await Promise.all(
          step.map(ent => stat(path.join(dir, ent.name)).catch(() => null))
        )
        step.forEach((ent, j) => stats.set(ent.name, got[j]!))
      }
      // One relative prefix per directory: `path.relative` per entry costs
      // seconds of main-thread time on a 200k-file directory.
      const relDir = path.relative(this.root, dir).split(path.sep).join("/")
      const prefix = relDir === "" ? "" : `${relDir}/`
      let emitted = 0
      for (const ent of visible) {
        if (++emitted % WALK_STAT_YIELD_EVERY === 0) {
          await new Promise<void>(resolve => setImmediate(resolve))
        }
        if (ent.isDirectory()) {
          await visit(path.join(dir, ent.name))
          continue
        }
        const s = stats.get(ent.name)
        if (s?.isDirectory()) await visit(path.join(dir, ent.name))
        else if (s?.isFile()) {
          out.push({
            path: prefix + ent.name,
            size: s.size,
            // `Stats.mtime` (Node rounds `mtimeMs` to whole ms), exactly what
            // `stat()` reports: the reconcile compares rows written from one
            // against scans from the other, and truncating `mtimeMs` would
            // differ by 1 ms on sub-ms filesystems and re-index every time.
            mtimeMs: s.mtime.getTime(),
          })
        }
      }
    }
    await visit(this.resolve(p))
    return out
  }

  async stat(p: string): Promise<FsStat | null> {
    try {
      const s = await stat(this.resolve(p))
      return {
        kind: s.isDirectory() ? "directory" : "file",
        bytes: s.isFile() ? s.size : undefined,
        modifiedAt: s.mtime,
      }
    } catch {
      return null
    }
  }

  /**
   * Advisory lock — a single-process no-op. The files engine never calls
   * `lock()` (it only reads/writes whole source files), and this backing is
   * local CLI, for which the `FsPort` contract permits a no-op lock.
   */
  async lock(_p: string): Promise<FsLockHandle> {
    return { release: async () => {} }
  }

  /**
   * Resolve a workspace-relative path to an absolute host path, refusing to
   * climb out of the workspace root (defense against `../../etc/passwd`-style
   * abuse). The files engine's paths must stay inside the workspace.
   */
  private resolve(p: string): string {
    const normalized = path.posix.normalize("/" + p.replace(/^\/+/, ""))
    const rel = normalized.slice(1)
    if (rel.startsWith("..")) {
      throw new Error(
        `LocalFs: path "${p}" escapes the workspace root "${this.root}"`,
      )
    }
    return path.join(this.root, rel)
  }
}
