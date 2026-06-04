/**
 * OverlayFs — stacks FsPorts so a writable layer shadows read-only ones.
 *
 * This is the customization engine for the SKILL→KNOWLEDGE→SOURCES spine:
 * a guild's editable corpus (its system workspace) sits ON TOP of one or
 * more read-only knowledge packs (shared, shipped). Layers are ordered
 * highest-precedence first.
 *
 *   overlay = new OverlayFs([guildFs, packFs])   // guild wins
 *
 * Resolution is by RELATIVE PATH:
 *   - reads (readFile/stat/exists) return the first layer that has the path
 *   - walk/readdir UNION across layers, deduped — so an entry the guild
 *     re-authors at the same path appears ONCE, with the guild's content
 *   - a path only in the pack passes through unchanged (the floor)
 *   - a path only in the guild is additive (extend)
 *   - writes/appends/locks always target the top (writable) layer; the
 *     packs stay pristine for every other guild
 *
 * This keeps `resolveKnowledge` untouched: it walks `entries/**` over the
 * overlay and never sees a pack entry that the guild has shadowed.
 */

import type { FsPort, FsLockHandle, FsStat } from "../ports/fs.port.js"

export class OverlayFs implements FsPort {
  /** Layers ordered highest-precedence first. layers[0] is writable. */
  private readonly layers: readonly FsPort[]

  constructor(layers: readonly FsPort[]) {
    if (layers.length === 0) {
      throw new Error("OverlayFs requires at least one layer")
    }
    this.layers = layers
  }

  async exists(path: string): Promise<boolean> {
    for (const layer of this.layers) {
      if (await layer.exists(path)) return true
    }
    return false
  }

  async readFile(path: string): Promise<string> {
    for (const layer of this.layers) {
      if (await layer.exists(path)) return await layer.readFile(path)
    }
    // Match a plain fs: throw on a genuinely missing path.
    return await this.layers[0]!.readFile(path)
  }

  async stat(path: string): Promise<FsStat | null> {
    for (const layer of this.layers) {
      const s = await layer.stat(path)
      if (s) return s
    }
    return null
  }

  async readdir(path: string): Promise<readonly string[]> {
    const seen = new Set<string>()
    for (const layer of this.layers) {
      let names: readonly string[]
      try {
        names = await layer.readdir(path)
      } catch {
        continue // layer lacks this dir — skip
      }
      for (const n of names) seen.add(n)
    }
    return [...seen]
  }

  async walk(path: string): Promise<readonly string[]> {
    const seen = new Set<string>()
    for (const layer of this.layers) {
      const rels = await layer.walk(path) // NodeFsAdapter returns [] if missing
      for (const rel of rels) seen.add(rel)
    }
    return [...seen]
  }

  // ── mutations target the top (writable) layer only ──────────────────

  async writeFile(path: string, content: string): Promise<void> {
    return await this.layers[0]!.writeFile(path, content)
  }

  async appendFile(path: string, content: string): Promise<void> {
    return await this.layers[0]!.appendFile(path, content)
  }

  async lock(path: string): Promise<FsLockHandle> {
    return await this.layers[0]!.lock(path)
  }
}

/**
 * ReadOnlyFs — wraps an FsPort and rejects every mutation. Use to seal a
 * knowledge pack so a misconfigured host can never write into the shared,
 * shipped corpus (the guild's edits belong in its own overlay layer).
 */
export class ReadOnlyFs implements FsPort {
  constructor(private readonly inner: FsPort) {}

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path)
  }
  readFile(path: string): Promise<string> {
    return this.inner.readFile(path)
  }
  stat(path: string): Promise<FsStat | null> {
    return this.inner.stat(path)
  }
  readdir(path: string): Promise<readonly string[]> {
    return this.inner.readdir(path)
  }
  walk(path: string): Promise<readonly string[]> {
    return this.inner.walk(path)
  }

  async writeFile(path: string, _content: string): Promise<void> {
    throw new Error(`ReadOnlyFs: refusing to write "${path}" — packs are immutable`)
  }
  async appendFile(path: string, _content: string): Promise<void> {
    throw new Error(`ReadOnlyFs: refusing to append "${path}" — packs are immutable`)
  }
  async lock(path: string): Promise<FsLockHandle> {
    throw new Error(`ReadOnlyFs: refusing to lock "${path}" — packs are immutable`)
  }
}
