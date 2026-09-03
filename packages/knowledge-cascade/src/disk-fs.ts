/**
 * DiskFs — a `FsPort` (from `@agentproto/corpus`) backed by `node:fs`.
 *
 * `@agentproto/corpus` itself is pure (no filesystem — see its
 * description); a disk-backed `FsPort` lives in `@agentproto/corpus-cli`
 * (`NodeFsAdapter`) and in per-adapter copies (e.g.
 * `adapters/knowledge-corpus/src/local-fs.ts`), each deliberately NOT
 * shared — a library package must not take a `-cli` edge just to reuse a
 * CLI package's adapter. This is that same minimal disk backing, scoped to
 * this kit: it mounts a global pack directory read-only (via `packFs`) or a
 * writable local-override directory as the cascade's base layer.
 *
 * Paths are workspace-relative and resolved under `root`; `resolve()`
 * refuses to climb out of it. `walk()` returns workspace-relative paths
 * (readable back through `readFile`) and skips hidden segments, exactly as
 * `FsPort` specifies. `lock` is a single-process no-op, which the `FsPort`
 * contract explicitly permits for local topologies.
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

export interface DiskFsOptions {
  /**
   * Absolute path to the layer root. Every `FsPort` path is resolved
   * relative to this — the cascade never sees a host filesystem path.
   */
  readonly root: string
}

export class DiskFs implements FsPort {
  private readonly root: string

  constructor(opts: DiskFsOptions) {
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

  /**
   * Returns paths relative to the QUERIED directory `p`, not the layer
   * root — matching `MemFs.walk` and the convention `resolveKnowledge`
   * depends on (`fs.walk("entries")` then re-prefixes each hit with
   * `entries/`). This mirrors `@agentproto/corpus-cli`'s `NodeFsAdapter`,
   * not `adapters/knowledge-corpus`'s `LocalFs` (which walks relative to
   * its own root) — layers composed by `OverlayFs`/`mountCascade` must
   * agree on this convention so the same logical entry produces the same
   * string across layers.
   */
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
          out.push(path.relative(start, full).split(path.sep).join("/"))
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
   * Advisory lock — a single-process no-op. Cascade layers are read
   * (packs) or written wholesale through `writeFile`/`appendFile`
   * (overrides); this backing is local, for which the `FsPort` contract
   * permits a no-op lock.
   */
  async lock(_p: string): Promise<FsLockHandle> {
    return { release: async () => {} }
  }

  /**
   * Resolve a workspace-relative path to an absolute host path, refusing to
   * climb out of the layer root (defense against `../../etc/passwd`-style
   * abuse).
   */
  private resolve(p: string): string {
    const normalized = path.posix.normalize("/" + p.replace(/^\/+/, ""))
    const rel = normalized.slice(1)
    if (rel.startsWith("..")) {
      throw new Error(`DiskFs: path "${p}" escapes the layer root "${this.root}"`)
    }
    return path.join(this.root, rel)
  }
}
