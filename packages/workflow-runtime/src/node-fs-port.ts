/**
 * NodeFsPort — a read-mostly `FsPort` over the host filesystem, rooted at an
 * AIP-10 corpus workspace. The local-FS twin of the adapter `corpus-cli`'s
 * knowledge preview uses, so `harness.knowledge` materialization resolves a
 * workspace with exactly the same port (and therefore the same hidden-segment
 * skipping and path confinement) the CLI does.
 */

import { mkdir, readFile, readdir, stat, writeFile, appendFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { dirname, join } from "node:path"
import type { FsPort, FsLockHandle, FsStat } from "@agentproto/corpus"

export class NodeFsPort implements FsPort {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  private resolve(p: string): string {
    const normalized = p.replace(/^\/+/, "")
    if (normalized.startsWith("..")) {
      throw new Error(`NodeFsPort: path "${p}" escapes the workspace root "${this.root}"`)
    }
    return join(this.root, normalized)
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
    return readFile(this.resolve(p), "utf8")
  }

  async writeFile(p: string, content: string): Promise<void> {
    const target = this.resolve(p)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, "utf8")
  }

  async appendFile(p: string, content: string): Promise<void> {
    const target = this.resolve(p)
    await mkdir(dirname(target), { recursive: true })
    await appendFile(target, content, "utf8")
  }

  async readdir(p: string): Promise<readonly string[]> {
    return readdir(this.resolve(p))
  }

  async walk(p: string): Promise<readonly string[]> {
    const out: string[] = []
    const visit = async (dir: string): Promise<void> => {
      let entries: Dirent[] = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        if (ent.name.startsWith(".")) continue
        const full = join(dir, ent.name)
        if (ent.isDirectory()) {
          await visit(full)
        } else if (ent.isFile()) {
          out.push(full)
        }
      }
    }
    await visit(this.resolve(p))
    const prefix = this.resolve(p)
    return out.map((f) => f.slice(prefix.length).replace(/^\//, ""))
  }

  async stat(p: string): Promise<FsStat | null> {
    try {
      const s = await stat(this.resolve(p))
      return {
        kind: s.isDirectory() ? "directory" : "file",
        ...(s.isFile() ? { bytes: s.size } : {}),
        modifiedAt: s.mtime,
      }
    } catch {
      return null
    }
  }

  async lock(): Promise<FsLockHandle> {
    // Read-mostly port: knowledge materialization holds no cross-process
    // transactions, so the advisory lock is a no-op (the FsPort contract
    // explicitly allows a no-op for single-process topologies).
    return { release: async () => {} }
  }
}
