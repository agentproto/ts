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
 */

import { join } from "node:path"
import { createBrainManager, type BrainManager } from "@agentproto/workspace-brain"
import type { ExportedSessionLike } from "@agentproto/workspace-brain"
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
        brain = createBrainManager({
          workspace: slug,
          brainDir,
          readSession: readSessionForBrain,
          listSessionRefs: async () =>
            (await readConversationIndex(BUCKETS_ROOT(), slug)).map(r => r.sessionId),
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
