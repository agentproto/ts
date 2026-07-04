/**
 * CorpusHost — the missing wiring between the corpus engine and a runtime agent.
 *
 * The corpus package has all the primitives (StackResolver, PlaybookRegistry,
 * OperatorOverlayResolver, resolveKnowledge). What it lacked was a host object
 * that owns a per-scope FsPort and exposes `getPlaybookRegistry` /
 * `resolveKnowledgeEntries` so a Mastra processor or tool can call them without
 * knowing about Guilde or any app-specific storage.
 *
 * `MemFsCorpusHost` — reference implementation backed by in-memory FsPorts:
 *   - `mountPack(scopeId, files)` installs a flat file map as the scope's corpus.
 *   - `registerLayerProvider(provider)` wires additional layer providers into
 *     the shared StackResolver (e.g. role-based or compliance packs).
 *   - `registerPackFs(packId, fs)` registers a named FsPort so layer providers
 *     that emit pack refs can have those refs mounted.
 *
 * Standalone: no Guilde, no database, no HTTP. The test proof uses this directly.
 */

import matter from "gray-matter"
import { createRegistry } from "@agentproto/registry"
import { MemFs } from "../knowledge/mem-fs.js"
import { ReadOnlyFs } from "../knowledge/overlay-fs.js"
import { buildOverlayFromStack } from "../stack/mount.js"
import { StackResolver } from "../stack/resolver.js"
import { PlaybookRegistry } from "../playbooks/registry.js"
import { resolveKnowledge } from "../knowledge/resolve.js"
import type { Dimensions } from "../binding/selector.js"
import type { FsPort } from "../ports/fs.port.js"
import type { CorpusEntryQuery, ResolvedEntry } from "../knowledge/resolve.js"
import type { LayerProvider } from "../stack/types.js"
import type { ParsedFile } from "../types.js"

/** Public interface every CorpusHost implementation must satisfy. */
export interface CorpusHost {
  /**
   * Return the PlaybookRegistry for a scope (resolved against any
   * registered layer providers).
   */
  getPlaybookRegistry(scopeId: string): Promise<PlaybookRegistry>

  /**
   * Resolve knowledge entries matching `query` for a scope.
   * Pass `dimensions` to drive any registered StackResolver providers
   * (e.g. select role-specific packs before querying).
   */
  resolveKnowledgeEntries(
    scopeId: string,
    query: CorpusEntryQuery,
    dimensions?: Dimensions
  ): Promise<readonly ResolvedEntry[]>
}

/**
 * MemFs-backed reference implementation.
 *
 * Suitable for standalone tests, REPL prototyping, and as the inner
 * store for a production host that prefills scopes from a database.
 */
export class MemFsCorpusHost implements CorpusHost {
  /** Per-scope flat file map (path → content, workspace-relative). */
  private readonly scopeFiles = new Map<string, Record<string, string>>()

  /** Shared layer-provider registry — same providers fire for every scope. */
  private readonly providerRegistry = createRegistry<LayerProvider>({
    family: "corpus-layer-providers",
    keyBy: (p: LayerProvider) => p.id,
  })

  /** Resolver that consults the provider registry to build a band-ordered stack. */
  private readonly stackResolver = new StackResolver(this.providerRegistry)

  /** Named pack FsPorts for refs emitted by layer providers. */
  private readonly packFs = new Map<string, FsPort>()

  /**
   * Mount a flat `{ path: content }` map as (or into) a scope's corpus.
   * Later calls MERGE — subsequent keys overwrite earlier ones, so you
   * can call `mountPack` multiple times to build up a scope.
   */
  mountPack(scopeId: string, files: Record<string, string>): void {
    const existing = this.scopeFiles.get(scopeId) ?? {}
    this.scopeFiles.set(scopeId, { ...existing, ...files })
  }

  /**
   * Register a `LayerProvider` into the shared StackResolver.
   * Providers run for every scope during `resolveFs`; guard with
   * `ctx.subject` or `ctx.dimensions` if you need scope-specific logic.
   */
  registerLayerProvider(provider: LayerProvider): void {
    this.providerRegistry.register(provider)
  }

  /**
   * Register a named `FsPort` so layer providers that emit `{ ref: packId }`
   * can have those refs mounted by `buildOverlayFromStack`.
   */
  registerPackFs(packId: string, fs: FsPort): void {
    this.packFs.set(packId, fs)
  }

  private getScopeBaseFs(scopeId: string): FsPort {
    return new MemFs(this.scopeFiles.get(scopeId) ?? {})
  }

  /**
   * Resolve the effective FsPort for a scope:
   *   - Run the StackResolver to compute additional layers.
   *   - If none contribute, return the base MemFs directly.
   *   - Otherwise, build an OverlayFs (constraints above, lenses below).
   */
  private async resolveFs(scopeId: string, dimensions?: Dimensions): Promise<FsPort> {
    const baseFs = this.getScopeBaseFs(scopeId)
    const stack = await this.stackResolver.resolve({ dimensions })
    if (stack.entries.length === 0) return baseFs
    return buildOverlayFromStack({
      guildFs: baseFs,
      stack,
      loadFs: (ref) => {
        const fs = this.packFs.get(ref.ref)
        return fs ? new ReadOnlyFs(fs) : null
      },
    })
  }

  async getPlaybookRegistry(scopeId: string): Promise<PlaybookRegistry> {
    const fs = await this.resolveFs(scopeId)

    // Walk the playbooks/ directory using MemFs's relative-walk convention
    // (walk("playbooks") returns paths relative to "playbooks/").
    let rels: readonly string[]
    try {
      rels = await fs.walk("playbooks")
    } catch {
      rels = []
    }

    const playbooks: ParsedFile[] = []
    for (const rel of rels) {
      if (!rel.endsWith("PLAYBOOK.md")) continue
      const path = `playbooks/${rel}`
      let content: string
      try {
        content = await fs.readFile(path)
      } catch {
        continue
      }
      const parsed = matter(content)
      playbooks.push({
        path,
        kind: "playbook",
        frontmatter: parsed.data as Readonly<Record<string, unknown>>,
        body: parsed.content,
        versionToken: "",
      })
    }

    return new PlaybookRegistry({
      snapshot: {
        root: "",
        workspace: null,
        sources: [],
        entries: [],
        collections: [],
        collectionItems: [],
        playbooks: Object.freeze(playbooks),
        operators: [],
        workflows: [],
        routines: [],
        unknown: [],
      },
    })
  }

  async resolveKnowledgeEntries(
    scopeId: string,
    query: CorpusEntryQuery,
    dimensions?: Dimensions
  ): Promise<readonly ResolvedEntry[]> {
    const fs = await this.resolveFs(scopeId, dimensions)
    return resolveKnowledge({ fs, query })
  }
}
