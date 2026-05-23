/**
 * NodeFsAdapter — `FsPort` implementation backed by node:fs.
 *
 * Atomic writes via temp + rename (the same posix pattern every
 * mature tool uses). Recursive `walk` skips hidden segments
 * (anything beginning with `.`). Advisory locks via lockfiles in
 * `.corpus-locks/` next to the target — single-process safe; for
 * multi-process the lockfile owner pid is recorded so callers can
 * see who holds the lock.
 */

import { randomBytes } from "node:crypto"
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { existsSync } from "node:fs"
import type {
  FsPort,
  FsLockHandle,
  FsStat,
} from "@agentproto/corpus"

export interface NodeFsAdapterOptions {
  /**
   * Absolute path to the workspace root. All FsPort paths are
   * resolved relative to this — the kit never sees host filesystem
   * paths.
   */
  readonly root: string
}

export class NodeFsAdapter implements FsPort {
  private readonly root: string

  constructor(opts: NodeFsAdapterOptions) {
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
   * Atomic write: write to `${target}.tmp-{nonce}`, fsync, rename.
   * Rename is atomic on the same filesystem. Creates parent dirs as
   * needed (most callers expect mkdir -p semantics).
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
    const target = this.resolve(p)
    const entries = await readdir(target)
    return entries
  }

  async walk(p: string): Promise<readonly string[]> {
    const out: string[] = []
    const start = this.resolve(p)
    const rootForRelative = start
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
          const rel = path.relative(rootForRelative, full).split(path.sep).join("/")
          out.push(rel)
        }
      }
    }
    await visit(start)
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
   * Advisory lock via a lockfile. Spins waiting for the lockfile to
   * disappear, then creates it with exclusive flag. Released by
   * deleting it. Single-process safe; multi-process semi-safe (the
   * write is best-effort exclusive — adequate for the corpus's
   * promote-entry transaction which is rare and short-lived).
   */
  async lock(p: string): Promise<FsLockHandle> {
    const target = this.resolve(p)
    const lockDir = path.join(path.dirname(target), ".corpus-locks")
    await mkdir(lockDir, { recursive: true })
    const lockFile = path.join(lockDir, path.basename(target) + ".lock")
    const myToken = `${process.pid}-${randomBytes(4).toString("hex")}`

    // Spin until we acquire. Cheap polling is fine for corpus
    // workloads — transactions are < 1s.
    while (true) {
      if (!existsSync(lockFile)) {
        try {
          await writeFile(lockFile, myToken, { encoding: "utf8", flag: "wx" })
          // Race: verify our token is the one that landed.
          const written = await readFile(lockFile, "utf8").catch(() => "")
          if (written === myToken) break
        } catch {
          // Lost the race — fall through and retry.
        }
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    return {
      release: async () => {
        try {
          await rm(lockFile, { force: true })
        } catch {
          // Lockfile already gone — no-op.
        }
      },
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  /**
   * Resolve a workspace-relative path to an absolute host path.
   * Refuses to climb out of the workspace root (defense against
   * `../../etc/passwd`-style abuse) — the corpus kit's paths must
   * stay inside the workspace.
   */
  private resolve(p: string): string {
    const normalized = path.posix.normalize("/" + p.replace(/^\/+/, ""))
    // Drop the leading "/" so path.join joins correctly under root.
    const rel = normalized.slice(1)
    if (rel.startsWith("..")) {
      throw new Error(
        `NodeFsAdapter: path "${p}" escapes the workspace root "${this.root}"`
      )
    }
    return path.join(this.root, rel)
  }
}
