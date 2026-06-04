/**
 * MemFs — an in-memory FsPort over a flat `path → content` map.
 *
 * Paths are workspace-relative (no leading slash), exactly like the disk
 * adapters; `walk(dir)` returns paths relative to the walked directory, so it
 * composes with `resolveKnowledge` (which re-prefixes) and with `OverlayFs`
 * unchanged.
 *
 * Primary use: a knowledge PACK whose entries are inlined into the JS bundle
 * at build time (see `@guilde/knowledge-packs`). Reading from an in-memory map
 * means packs ride inside `dist` — no runtime `fs`, no path resolution, no
 * loose data files for the deploy to drop. Wrap in `ReadOnlyFs` for packs.
 */

import type { FsPort, FsStat, FsLockHandle } from "../ports/fs.port.js"

export class MemFs implements FsPort {
  private readonly files: Record<string, string>

  constructor(files: Record<string, string>) {
    // Copy so a caller's shared/frozen map can't be mutated through this fs.
    this.files = { ...files }
  }

  async exists(path: string): Promise<boolean> {
    return path in this.files
  }

  async readFile(path: string): Promise<string> {
    const content = this.files[path]
    if (content === undefined) throw new Error(`MemFs: ENOENT ${path}`)
    return content
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files[path] = content
  }

  async appendFile(path: string, content: string): Promise<void> {
    this.files[path] = (this.files[path] ?? "") + content
  }

  async readdir(path: string): Promise<readonly string[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`
    const names = new Set<string>()
    for (const key of Object.keys(this.files)) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!)
    }
    return [...names]
  }

  async walk(path: string): Promise<readonly string[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`
    return Object.keys(this.files)
      .filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length))
  }

  async stat(path: string): Promise<FsStat | null> {
    const content = this.files[path]
    return content === undefined ? null : { kind: "file", bytes: content.length }
  }

  async lock(): Promise<FsLockHandle> {
    return { release: async () => {} }
  }
}
