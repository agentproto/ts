/**
 * Test helpers — minimal in-memory FsPort + stub IKnowledgeProvider.
 * Mirror the shape used by the @agentproto/corpus tests but kept local
 * here so this package doesn't reach into @agentproto/corpus internals.
 *
 * Lifted from the studio corpus provider's `__tests__/_helpers.ts` — the
 * `IKnowledgeProvider` + data-type imports are repointed to
 * `@agentproto/knowledge-engine`, and `loadM0FixtureFs` reads the corpus
 * fixtures from THIS repo (`packages/corpus/test/fixtures/marketing`) rather
 * than climbing out of a studio subtree.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { FsPort, FsLockHandle, FsStat } from "@agentproto/corpus"
import type {
  IKnowledgeProvider,
  KnowledgeCapabilities,
  KnowledgeHit,
  KnowledgeIngestInput,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeSource,
  ListSourcesFilter,
} from "@agentproto/knowledge-engine"

// ── In-memory FsPort ─────────────────────────────────────────────────

export class MemoryFs implements FsPort {
  private readonly files = new Map<string, string>()
  private readonly locks = new Set<string>()

  constructor(initial?: Readonly<Record<string, string>>) {
    if (initial) {
      for (const [p, c] of Object.entries(initial)) this.files.set(p, c)
    }
  }

  async exists(p: string): Promise<boolean> {
    if (this.files.has(p)) return true
    const prefix = p.endsWith("/") ? p : p + "/"
    for (const k of this.files.keys()) {
      if (k === p || k.startsWith(prefix)) return true
    }
    return false
  }
  async readFile(p: string): Promise<string> {
    const c = this.files.get(p)
    if (c === undefined) throw new Error(`MemoryFs: ENOENT ${p}`)
    return c
  }
  async writeFile(p: string, c: string): Promise<void> {
    this.files.set(p, c)
  }
  async appendFile(p: string, c: string): Promise<void> {
    this.files.set(p, (this.files.get(p) ?? "") + c)
  }
  async readdir(p: string): Promise<readonly string[]> {
    const prefix = p === "" ? "" : p.endsWith("/") ? p : p + "/"
    const direct = new Set<string>()
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue
      const rest = k.slice(prefix.length)
      const i = rest.indexOf("/")
      direct.add(i === -1 ? rest : rest.slice(0, i))
    }
    return [...direct]
  }
  async walk(p: string): Promise<readonly string[]> {
    const prefix = p === "" ? "" : p.endsWith("/") ? p : p + "/"
    const out: string[] = []
    for (const k of this.files.keys()) {
      if (p === "" || k.startsWith(prefix)) {
        if (k.split("/").some(s => s.startsWith("."))) continue
        out.push(k)
      }
    }
    return out
  }
  async stat(p: string): Promise<FsStat | null> {
    const f = this.files.get(p)
    if (f !== undefined) return { kind: "file", bytes: f.length }
    if (await this.exists(p)) return { kind: "directory" }
    return null
  }
  async lock(p: string): Promise<FsLockHandle> {
    while (this.locks.has(p)) await new Promise(r => setTimeout(r, 1))
    this.locks.add(p)
    return { release: async () => void this.locks.delete(p) }
  }
}

// ── Load the marketing fixture from @agentproto/corpus into MemoryFs ──

export function loadM0FixtureFs(): MemoryFs {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const fixturesRoot = path.resolve(
    __dirname,
    // adapters/knowledge-corpus/src/__tests__/  (4×"../" climbs to repo root),
    // then descend to the corpus package's marketing fixtures.
    "../../../../packages/corpus/test/fixtures/marketing"
  )
  const fs = new MemoryFs()
  function walk(dir: string) {
    for (const ent of readdirSync(dir)) {
      const full = path.join(dir, ent)
      const s = statSync(full)
      if (s.isDirectory()) walk(full)
      else if (ent.endsWith(".md")) {
        const rel = path.relative(fixturesRoot, full).split(path.sep).join("/")
        fs.writeFile(rel, readFileSync(full, "utf8"))
      }
    }
  }
  walk(fixturesRoot)
  return fs
}

// ── Stub IKnowledgeProvider ──────────────────────────────────────────

export interface StubProviderState {
  readonly ingestedInputs: KnowledgeIngestInput[]
  readonly deletedIds: string[]
  /** Inject hits for the next `query()` call. */
  nextHits: KnowledgeHit[]
}

export interface StubProviderOptions {
  readonly id?: string
  readonly capabilities?: Partial<KnowledgeCapabilities>
  readonly hitsForQuery?: (q: KnowledgeQuery) => readonly KnowledgeHit[]
}

export function makeStubProvider(opts: StubProviderOptions = {}): {
  provider: IKnowledgeProvider
  state: StubProviderState
} {
  const state: StubProviderState = {
    ingestedInputs: [],
    deletedIds: [],
    nextHits: [],
  }

  const provider: IKnowledgeProvider = {
    id: opts.id ?? "stub",
    capabilities: {
      vectorSearch: true,
      graphTraversal: false,
      hybridSearch: false,
      multiModal: false,
      streaming: false,
      citations: true,
      maxChunkBytes: 2048,
      ...(opts.capabilities ?? {}),
    },
    async ingest(input): Promise<KnowledgeSource> {
      state.ingestedInputs.push(input)
      return {
        id: `stub-${state.ingestedInputs.length}`,
        kind: input.kind,
        uri: input.uri,
        title: input.title,
        bytes:
          typeof input.content === "string"
            ? input.content.length
            : (input.content?.byteLength ?? 0),
        status: "ready",
        indexedAt: new Date(0),
        metadata: (input.metadata as Record<string, unknown>) ?? {},
      }
    },
    async query(q): Promise<KnowledgeQueryResult> {
      const hits = opts.hitsForQuery ? opts.hitsForQuery(q) : state.nextHits
      return {
        engine: opts.id ?? "stub",
        modeUsed: "vector",
        hits,
        tookMs: 1,
      }
    },
    async listSources(_filter?: ListSourcesFilter) {
      return state.ingestedInputs.map((input, i) => ({
        id: `stub-${i + 1}`,
        kind: input.kind,
        uri: input.uri,
        title: input.title,
        bytes:
          typeof input.content === "string"
            ? input.content.length
            : (input.content?.byteLength ?? 0),
        status: "ready" as const,
        indexedAt: new Date(0),
        metadata: (input.metadata as Record<string, unknown>) ?? {},
      }))
    },
    async getSource(id) {
      const i = Number(id.replace(/^stub-/, "")) - 1
      const input = state.ingestedInputs[i]
      if (!input) return null
      return {
        id,
        kind: input.kind,
        uri: input.uri,
        title: input.title,
        bytes:
          typeof input.content === "string"
            ? input.content.length
            : (input.content?.byteLength ?? 0),
        status: "ready",
        indexedAt: new Date(0),
        metadata: (input.metadata as Record<string, unknown>) ?? {},
      }
    },
    async deleteSource(id) {
      state.deletedIds.push(id)
    },
    async healthCheck() {
      return true
    },
    async dispose() {
      // noop
    },
  }
  return { provider, state }
}
