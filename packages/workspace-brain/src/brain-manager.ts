/**
 * `createBrainManager` — the per-workspace orchestrator.
 *
 * Wires the persistence (`brain-state.json`), the ingest pipeline, and the
 * queryable knowledge provider into a single object the host hands to its
 * subscriber + MCP tools. The provider is a {@link FederatedKnowledgeProvider}
 * over whatever backends the workspace configures (`knowledge.json`, threaded
 * through {@link BrainConfig.knowledge}) — from the default single `files`
 * (BM25, rooted at `<brain>/knowledge/`, zero deps) up to several adapters
 * queried in parallel and merged. It is created LAZILY on first
 * `getProvider()` so a workspace that never queries a brain pays nothing
 * until it does.
 *
 * Singletons per workspace are the HOST's job (the daemon keys a `Map` by
 * bucket slug); this factory just builds one well-formed brain.
 */

import type { IKnowledgeProvider } from "@agentproto/knowledge-engine"
import { createBrainState } from "./brain-state.js"
import { FederatedKnowledgeProvider } from "./federated-provider.js"
import { IngestPipeline } from "./ingest-pipeline.js"
import { resolveKnowledgeProviders } from "./provider-resolver.js"
import type {
  BrainConfig,
  BrainStats,
  IngestReport,
  IngestResult,
  KnowledgeConfig,
} from "./types.js"

/**
 * The config every brain falls back to when the host passes no
 * `knowledge` — one `files` provider, exactly what this package did before
 * multi-provider support existed.
 */
export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = Object.freeze({
  providers: Object.freeze([Object.freeze({ id: "local", adapter: "files", auto: true })]),
})

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

  let provider: IKnowledgeProvider | null = null
  const getProvider = (): IKnowledgeProvider => {
    if (!provider) {
      const knowledge = config.knowledge ?? DEFAULT_KNOWLEDGE_CONFIG
      const resolved = resolveKnowledgeProviders(knowledge, {
        brainDir: config.brainDir,
      })
      provider = new FederatedKnowledgeProvider({
        providers: resolved,
        ...(knowledge.defaultQueryProviders
          ? { defaultQueryProviders: knowledge.defaultQueryProviders }
          : {}),
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
