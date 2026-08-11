/**
 * Runtime-side glue for the per-workspace brain: a shared registry of
 * {@link BrainManager}s (one per workspace bucket) plus the two bridges that
 * connect the pure `@agentproto/workspace-brain` engine to this daemon's real
 * conversation stores:
 *
 *   - `readSessionForBrain` — a session id → exported transcript, via the same
 *     ladder as `conversation-read.ts`: the provider-native store first
 *     (`CONVERSATION_STORES`), then the universal `events.jsonl` capture
 *     (`exportDaemonEventsSession`). `null` when neither has anything.
 *   - `resolveWorkspace` — a session id → the workspace bucket it was recorded
 *     under (via the persisted `conversations.jsonl` index).
 *
 * The registry itself is keyed by bucket slug and creates each `BrainManager`
 * lazily, so a workspace that never produces a session pays nothing until its
 * first exit does.
 *
 * A workspace's knowledge backends are configured per-workspace by a
 * `knowledge.json` file at `<bucket>/knowledge.json` (see
 * {@link loadKnowledgeConfigForWorkspace}). No file → the brain's default
 * single `files` provider (identical to pre-config behavior); an invalid
 * file → warn + fall back to that default; never throws either way.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  createBrainManager,
  parseKnowledgeConfig,
  type BrainManager,
  type ExportedSessionLike,
  type KnowledgeConfig,
} from "@agentproto/workspace-brain"
import {
  findConversationRecord,
  locateConversationBySessionId,
  readConversationIndex,
} from "./conversation-index.js"
import { CONVERSATION_STORES } from "./conversation-store.js"
import { exportDaemonEventsSession } from "./transcript-export.js"
import {
  BUCKETS_ROOT,
  listBuckets,
  DEFAULT_BUCKET,
  readRegisteredSlugs,
} from "./workspace-buckets.js"

/** The shared registry handed to both the subscriber and the MCP tools. */
export interface WorkspaceBrains {
  /** Get (creating lazily) the brain manager for a workspace bucket slug. */
  getBrain(workspace: string): BrainManager
  /** Map a session id to the workspace bucket it was recorded under. */
  resolveWorkspace(sessionId: string): Promise<string | undefined>
  /** Resolve an explicit workspace slug (or caller slug) to a safe bucket
   *  slug — "default" when unregistered/absent (membership rule). */
  resolveWorkspaceSlug(workspace?: string, callerSlug?: string): string
}

/** Resolve a session id to its exported transcript, native first then daemon
 *  events — `null` (never throws) when neither store has anything readable. */
export async function readSessionForBrain(
  sessionId: string,
): Promise<ExportedSessionLike | null> {
  const located = await locateConversationBySessionId(
    BUCKETS_ROOT(),
    () => listBuckets(BUCKETS_ROOT()),
    sessionId,
  )
  if (!located) return null
  const { record } = located

  if (record.adapterSlug && record.adapterSessionId) {
    const store = CONVERSATION_STORES[record.adapterSlug]
    if (store) {
      try {
        const exported = await store.read(record.adapterSessionId, record.cwd)
        if (exported?.messages?.length) return exported
      } catch {
        // native store unreadable — fall through to daemon events
      }
    }
  }

  try {
    return await exportDaemonEventsSession(record.sessionId)
  } catch {
    return null
  }
}

export function createWorkspaceBrains(): WorkspaceBrains {
  const brains = new Map<string, BrainManager>()

  return {
    getBrain(workspace) {
      let brain = brains.get(workspace)
      if (!brain) {
        const slug = readRegisteredSlugOr(workspace)
        // getBrain is keyed by bucket slug; the slug must be safe. Fall back
        // to "default" for anything unregistered — same membership rule as
        // the bucket resolver.
        const brainDir = join(BUCKETS_ROOT(), slug, "brain")
        const knowledge = loadKnowledgeConfigForWorkspace(slug)
        brain = createBrainManager({
          workspace: slug,
          brainDir,
          readSession: readSessionForBrain,
          listSessionRefs: async () =>
            (await readConversationIndex(BUCKETS_ROOT(), slug)).map(r => r.sessionId),
          // Optional per-workspace knowledge.json — the brain defaults to a
          // single `files` provider when unset (identical to today). Invalid
          // file → warn + fall back, never throw (brain creation stays
          // resilient, so the subscriber + tools never degrade).
          ...(knowledge ? { knowledge } : {}),
        })
        brains.set(slug, brain)
      }
      return brain
    },
    async resolveWorkspace(sessionId) {
      const located = await locateConversationBySessionId(
        BUCKETS_ROOT(),
        () => listBuckets(BUCKETS_ROOT()),
        sessionId,
      )
      return located?.workspace
    },
    resolveWorkspaceSlug(workspace, callerSlug) {
      const slug = workspace ?? callerSlug ?? DEFAULT_BUCKET
      return readRegisteredSlugOr(slug)
    },
  }
}

/** Membership check: only return the slug if it's actually registered,
 *  otherwise `default` — mirrors `resolveBucketSlug`'s rule so a caller-supplied
 *  string can never aim a brain at a path it doesn't own. */
function readRegisteredSlugOr(slug: string): string {
  return readRegisteredSlugs().has(slug) ? slug : DEFAULT_BUCKET
}

/**
 * Load a workspace's `knowledge.json` (`<bucket>/knowledge.json`) as a
 * {@link KnowledgeConfig}. Never throws: a missing file → `undefined` (the
 * brain's default single `files` provider); an unreadable/invalid/schema-
 * failing file → warn (with the slug + reason) and fall back to `undefined`.
 *
 * Read synchronously on purpose: `getBrain` constructs the brain lazily in a
 * synchronous registry lookup (mirroring `readRegisteredSlugs`), and the file
 * is tiny — the resilient fallback matters more than async here.
 */
function loadKnowledgeConfigForWorkspace(slug: string): KnowledgeConfig | undefined {
  const file = join(BUCKETS_ROOT(), slug, "knowledge.json")
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    console.warn(
      `[workspace-brains] ${slug}: failed to read knowledge.json — falling back to the default files provider: ${(err as Error).message}`,
    )
    return undefined
  }
  try {
    return parseKnowledgeConfig(JSON.parse(raw))
  } catch (err) {
    console.warn(
      `[workspace-brains] ${slug}: invalid knowledge.json — falling back to the default files provider: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return undefined
  }
}
