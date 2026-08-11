/**
 * `createBrainManager` — the per-workspace orchestrator.
 *
 * Wires the persistence (`brain-state.json`), the ingest pipeline, and the
 * queryable `FilesKnowledgeAdapter` (rooted at `<brain>/knowledge/`, BM25,
 * zero deps) into a single object the host hands to its subscriber + MCP
 * tools. The adapter is created LAZILY on first `getProvider()` so a workspace
 * that never queries a brain pays nothing until it does.
 *
 * Singletons per workspace are the HOST's job (the daemon keys a `Map` by
 * bucket slug); this factory just builds one well-formed brain.
 */

import { FilesKnowledgeAdapter, LocalFs } from "@agentproto/adapter-knowledge-files"
import type { IKnowledgeProvider } from "@agentproto/knowledge-engine"
import { createBrainState } from "./brain-state.js"
import { IngestPipeline } from "./ingest-pipeline.js"
import type {
  BrainConfig,
  BrainStats,
  IngestReport,
  IngestResult,
} from "./types.js"

export interface BrainManager {
  /** Ingest one session. `force` re-ingests even if already recorded. */
  ingestSession(sessionId: string, force?: boolean): Promise<IngestResult>
  /** Ingest every known-but-unrecorded session for this workspace. */
  ingestPending(): Promise<IngestReport>
  /** Snapshot of what the brain holds + how current it is. */
  status(): Promise<BrainStats>
  /** The queryable provider (lazily created). */
  getProvider(): IKnowledgeProvider
  /** Drop cached state (idempotent). */
  dispose(): Promise<void>
}

export function createBrainManager(config: BrainConfig): BrainManager {
  const state = createBrainState(config.brainDir)

  let provider: FilesKnowledgeAdapter | null = null
  const getProvider = (): FilesKnowledgeAdapter => {
    if (!provider) {
      // Root the FsPort at the brain dir; the engine's `workspacePath` is the
      // `knowledge/` subtree, so `ingest()` writes `knowledge/sources/<id>.md`
      // and `query()` walks the same tree.
      provider = new FilesKnowledgeAdapter({
        fs: new LocalFs({ root: config.brainDir }),
        workspacePath: "knowledge",
      })
    }
    return provider
  }

  const pipeline = new IngestPipeline({
    workspace: config.workspace,
    readSession: config.readSession,
    state,
    getProvider: () => getProvider(),
    ...(config.listSessionRefs
      ? { listSessionRefs: config.listSessionRefs }
      : {}),
  })

  return {
    async ingestSession(sessionId, force = false) {
      return pipeline.ingest(sessionId, force)
    },
    async ingestPending() {
      return pipeline.ingestPending()
    },
    async status() {
      const records = await state.read()
      const entries = Object.values(records)
      const totalBytes = entries.reduce((sum, r) => sum + (r.bytes || 0), 0)
      const lastIngestedAt = entries
        .map(r => r.ingestedAt)
        .sort()
        .pop()

      let pendingSessions = 0
      if (config.listSessionRefs) {
        try {
          const refs = await config.listSessionRefs()
          const recordedIds = new Set(entries.map(r => r.sessionId))
          pendingSessions = refs.filter(id => !recordedIds.has(id)).length
        } catch {
          pendingSessions = 0
        }
      }

      let ready = false
      try {
        ready = await getProvider().healthCheck()
      } catch {
        ready = false
      }

      return {
        workspace: config.workspace,
        brainDir: config.brainDir,
        sourceCount: entries.length,
        totalBytes,
        pendingSessions,
        ...(lastIngestedAt ? { lastIngestedAt } : {}),
        ready,
      }
    },
    getProvider,
    async dispose() {
      await provider?.dispose()
      provider = null
    },
  }
}
