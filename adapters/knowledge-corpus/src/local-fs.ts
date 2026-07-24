/**
 * LocalFs — a `FsPort` (from `@agentproto/corpus`) backed by node:fs.
 *
 * The studio corpus provider never shipped its own `FsPort`: the guild host
 * resolved one (`resolveWorkspaceFs`) and injected it. agentproto-side that
 * host is gone (the guild registry stays studio-side per the Ph4 plan), so
 * this package ships the minimal local backing that lets the adapter run
 * standalone — the same role the code-brain adapter's own backend client plays.
 *
 * Lifted from `@agentproto/adapter-knowledge-files`'s `local-fs.ts` (both the
 * files + corpus engines need the identical node:fs `FsPort`, and a library
 * adapter must not take a `-cli` edge to reuse `@agentproto/corpus-cli`'s
 * `NodeFsAdapter`). Paths are workspace-relative and resolved under `root`;
 * `resolve()` refuses to climb out of it. `walk()` returns workspace-relative
 * paths (readable back through `readFile`) and skips hidden segments, exactly
 * as `FsPort` specifies. `lock` is a single-process no-op — this backing is
 * local CLI, which the port contract explicitly permits.
 */

import { randomBytes } from "node:crypto"
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
   * Advisory lock — a single-process no-op. The corpus adapter never calls
   * `lock()` (it only reads whole source/entry files), and this backing is
   * local CLI, for which the `FsPort` contract permits a no-op lock.
   */
  async lock(_p: string): Promise<FsLockHandle> {
    return { release: async () => {} }
  }

  /**
   * Resolve a workspace-relative path to an absolute host path, refusing to
   * climb out of the workspace root (defense against `../../etc/passwd`-style
   * abuse). The corpus adapter's paths must stay inside the workspace.
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
