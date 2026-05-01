/**
 * IGovernanceFilesystem — vendor-neutral filesystem interface used by the
 * governance runtime. Lets a consumer plug a non-Node backend (Supabase
 * Storage, S3, in-memory) without forking the runtime.
 *
 * All paths are absolute (the runtime resolves root-relative paths via
 * `resolveFromRoot` before calling FS methods).
 *
 * Default implementation: `NodeGovernanceFilesystem`, backed by `node:fs`.
 * Backends MUST guarantee:
 *   - `writeFileAtomic` is atomic on same-volume rename (or equivalent).
 *   - `appendLine` is durable across process crashes (line either fully
 *     present or absent in the resulting file — no torn writes).
 *   - `readFile` returns `null` (not throws) when the file does not exist.
 */

import { promises as fs } from "node:fs"
import * as path from "node:path"

/** A single child entry returned by `listDirectory`. */
export interface DirectoryEntry {
  /** File or subdirectory name (relative to the parent). No leading slash. */
  name: string
  /** True for subdirectories, false for files. */
  isDirectory: boolean
}

export interface IGovernanceFilesystem {
  /** Recursively create a directory if it does not exist. */
  ensureDir(absDir: string): Promise<void>

  /** Read a UTF-8 file. Returns `null` when the file does not exist. */
  readFile(absPath: string): Promise<string | null>

  /**
   * Atomically write the full contents of a file. Implementations should
   * write to a temp file in the same dir, then rename — or use whatever
   * atomic-replace primitive the backend provides.
   */
  writeFileAtomic(absPath: string, content: string): Promise<void>

  /**
   * Append a single line + newline. Creates the file if absent. Must be
   * crash-safe: a partially-written line MUST NOT be visible to a
   * concurrent reader.
   */
  appendLine(absPath: string, line: string): Promise<void>

  /**
   * List the immediate children of a directory. Returns `[]` when the
   * directory does not exist (NOT throw). Order is implementation-defined;
   * callers MUST sort if they need stable order.
   */
  listDirectory(absDir: string): Promise<DirectoryEntry[]>
}

// ─── Default Node-fs implementation ────────────────────────────────────

export class NodeGovernanceFilesystem implements IGovernanceFilesystem {
  async ensureDir(absDir: string): Promise<void> {
    await fs.mkdir(absDir, { recursive: true })
  }

  async readFile(absPath: string): Promise<string | null> {
    try {
      return await fs.readFile(absPath, "utf8")
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
      throw e
    }
  }

  async writeFileAtomic(absPath: string, content: string): Promise<void> {
    await this.ensureDir(path.dirname(absPath))
    const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, content, "utf8")
    await fs.rename(tmp, absPath)
  }

  async appendLine(absPath: string, line: string): Promise<void> {
    await this.ensureDir(path.dirname(absPath))
    await fs.appendFile(absPath, line + "\n", "utf8")
  }

  async listDirectory(absDir: string): Promise<DirectoryEntry[]> {
    try {
      const entries = await fs.readdir(absDir, { withFileTypes: true })
      return entries.map(e => ({
        name: e.name,
        isDirectory: e.isDirectory(),
      }))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
      throw e
    }
  }
}

const sharedNodeFs = new NodeGovernanceFilesystem()

/** Default singleton — Node fs. */
export function defaultGovernanceFilesystem(): IGovernanceFilesystem {
  return sharedNodeFs
}
