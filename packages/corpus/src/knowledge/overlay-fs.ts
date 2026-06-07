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

/**
 * Sibling-path marker that removes (whiteouts) a lower layer's entry. To
 * drop `entries/foo.md`, a higher layer authors `entries/foo.md.whiteout`.
 * A marker file (not a frontmatter flag) keeps overlay resolution a pure
 * path operation — listing a directory never reads entry bodies.
 */
export const WHITEOUT_SUFFIX = ".whiteout"

const isMarker = (p: string): boolean => p.endsWith(WHITEOUT_SUFFIX)
const baseOf = (markerPath: string): string =>
  markerPath.slice(0, -WHITEOUT_SUFFIX.length)

export interface OverlayFsOptions {
  /**
   * Honor `.whiteout` markers so a higher layer can REMOVE (not just
   * shadow) a lower entry. OFF by default: with whiteout disabled the
   * overlay is pure union + shadow, byte-for-byte the original behavior.
   */
  readonly whiteout?: boolean
  /**
   * Index of the writable layer (writes / appends / locks target it).
   * Defaults to 0. Set this when a read-only CONSTRAINT floor is pinned
   * ABOVE the writable layer: read precedence (layer order) and the write
   * target are then independent — the floor wins reads, the guild layer
   * still takes writes.
   */
  readonly writableLayer?: number
}

export class OverlayFs implements FsPort {
  /** Layers ordered highest-precedence first. */
  private readonly layers: readonly FsPort[]
  private readonly whiteout: boolean
  private readonly writableIndex: number

  constructor(layers: readonly FsPort[], options: OverlayFsOptions = {}) {
    if (layers.length === 0) {
      throw new Error("OverlayFs requires at least one layer")
    }
    this.layers = layers
    this.whiteout = options.whiteout ?? false
    const w = options.writableLayer ?? 0
    if (w < 0 || w >= layers.length) {
      throw new Error(
        `OverlayFs: writableLayer ${w} out of range [0, ${layers.length - 1}]`
      )
    }
    this.writableIndex = w
  }

  /**
   * Top-down resolution for a single path: the first layer that declares
   * either the real entry OR its whiteout marker decides. Within one
   * layer a real entry wins over a stale marker. Returns null when no
   * layer declares the path, and `{ removed: true }` when the winning
   * layer tombstones it.
   */
  private async resolvePath(
    path: string
  ): Promise<{ layer: FsPort } | { removed: true } | null> {
    const marker = path + WHITEOUT_SUFFIX
    for (const layer of this.layers) {
      if (await layer.exists(path)) return { layer }
      if (await layer.exists(marker)) return { removed: true }
    }
    return null
  }

  async exists(path: string): Promise<boolean> {
    if (!this.whiteout) {
      for (const layer of this.layers) {
        if (await layer.exists(path)) return true
      }
      return false
    }
    if (isMarker(path)) return false // markers are not visible entries
    const r = await this.resolvePath(path)
    return r !== null && !("removed" in r)
  }

  async readFile(path: string): Promise<string> {
    if (this.whiteout && !isMarker(path)) {
      const r = await this.resolvePath(path)
      if (r && "layer" in r) return await r.layer.readFile(path)
      // Tombstoned or genuinely missing — surface a plain not-found.
      return await this.layers[0]!.readFile(path)
    }
    for (const layer of this.layers) {
      if (await layer.exists(path)) return await layer.readFile(path)
    }
    // Match a plain fs: throw on a genuinely missing path.
    return await this.layers[0]!.readFile(path)
  }

  async stat(path: string): Promise<FsStat | null> {
    if (this.whiteout && !isMarker(path)) {
      const r = await this.resolvePath(path)
      if (r && "layer" in r) return await r.layer.stat(path)
      return null
    }
    if (this.whiteout && isMarker(path)) return null
    for (const layer of this.layers) {
      const s = await layer.stat(path)
      if (s) return s
    }
    return null
  }

  async readdir(path: string): Promise<readonly string[]> {
    if (!this.whiteout) {
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
    return this.unionWhiteoutAware((layer) => layer.readdir(path))
  }

  async walk(path: string): Promise<readonly string[]> {
    if (!this.whiteout) {
      const seen = new Set<string>()
      for (const layer of this.layers) {
        const rels = await layer.walk(path) // NodeFsAdapter returns [] if missing
        for (const rel of rels) seen.add(rel)
      }
      return [...seen]
    }
    return this.unionWhiteoutAware((layer) => layer.walk(path))
  }

  /**
   * Union the entries each layer reports for a path (basenames for
   * readdir, relative paths for walk), resolving whiteouts top-down: the
   * first layer (highest precedence) that declares an entry or its marker
   * wins. Real entries win over markers within the same layer; marker
   * files are stripped from the result.
   */
  private async unionWhiteoutAware(
    list: (layer: FsPort) => Promise<readonly string[]>
  ): Promise<readonly string[]> {
    const decided = new Map<string, "present" | "removed">()
    for (const layer of this.layers) {
      let entries: readonly string[]
      try {
        entries = await list(layer)
      } catch {
        continue // layer lacks this dir — skip
      }
      const reals = entries.filter((e) => !isMarker(e))
      const markerBases = entries.filter(isMarker).map(baseOf)
      // Real entries first so a real entry wins over a same-layer marker.
      for (const r of reals) if (!decided.has(r)) decided.set(r, "present")
      for (const b of markerBases) if (!decided.has(b)) decided.set(b, "removed")
    }
    const out: string[] = []
    for (const [name, state] of decided) {
      if (state === "present") out.push(name)
    }
    return out
  }

  // ── mutations target the writable layer only ────────────────────────

  async writeFile(path: string, content: string): Promise<void> {
    return await this.layers[this.writableIndex]!.writeFile(path, content)
  }

  async appendFile(path: string, content: string): Promise<void> {
    return await this.layers[this.writableIndex]!.appendFile(path, content)
  }

  async lock(path: string): Promise<FsLockHandle> {
    return await this.layers[this.writableIndex]!.lock(path)
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
