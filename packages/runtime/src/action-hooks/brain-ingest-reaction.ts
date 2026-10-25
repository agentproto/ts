/**
 * The brain-ingest pilot reaction (AIP-71).
 *
 * A durable reaction bound to `agentproto:session-completed`. It ingests a
 * completed session into its workspace brain, but only for the workspace
 * slugs listed in `defaults.reactions.brainIngest.workspaces`. Every other
 * workspace stays owned by the legacy `workspace-brain-subscriber.ts`, so a
 * slug is never ingested by both paths.
 *
 * The target is idempotent: `IngestPipeline.ingest` reads its durable ledger
 * first, so a re-drive after a crash returns `already-ingested` instead of
 * writing a second copy of the committed output.
 */

import type { SessionCompletedEvent, SessionEvent } from "../session-event-bus.js"
import { loadConfig } from "../config.js"
import type { WorkspaceBrains } from "../workspace-brains.js"
import type { ReactionBinding, ReactionTargetOutcome } from "./reaction-runner.js"

export const BRAIN_INGEST_BINDING_ID = "builtin:brain-ingest"

export const BRAIN_INGEST_ACTION_ID = "session:brain-ingest"

const BRAIN_INGEST_CONFIG_REVISION = "brain-ingest-v1"

const DEFAULT_MAX_ATTEMPTS = 3

export interface BrainIngestReactionOptions {
  brains: Pick<WorkspaceBrains, "getBrain" | "resolveWorkspace">
  ownedWorkspaces: () => Promise<readonly string[]> | readonly string[]
  maxAttempts?: number
  log?: (line: string) => void
}

export interface BrainIngestReaction {
  binding: ReactionBinding
  /** true when the reaction owns this workspace slug right now. */
  owns(workspace: string): Promise<boolean>
}

/** Read the opt-in list from `config.json`, per call like the other defaults resolvers. */
export async function readBrainIngestOwnedWorkspaces(): Promise<readonly string[]> {
  try {
    const config = await loadConfig()
    return config.defaults?.reactions?.brainIngest?.workspaces ?? []
  } catch {
    return []
  }
}

export function createBrainIngestReaction(opts: BrainIngestReactionOptions): BrainIngestReaction {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const ownedWorkspaces = opts.ownedWorkspaces
  const log = opts.log ?? ((line: string): void => console.warn(line))

  const owns = async (workspace: string): Promise<boolean> => {
    const owned = await ownedWorkspaces()
    return owned.includes(workspace)
  }

  const binding: ReactionBinding = {
    bindingId: BRAIN_INGEST_BINDING_ID,
    event: "agentproto:session-completed",
    actionId: BRAIN_INGEST_ACTION_ID,
    configRevision: BRAIN_INGEST_CONFIG_REVISION,
    reactionDepth: 0,
    maxAttempts,

    occurrenceIdOf(event: SessionEvent): string | undefined {
      if (event.type !== "agentproto:session-completed") return undefined
      return (event as SessionCompletedEvent).occurrenceId
    },

    async shouldHandle(event: SessionEvent): Promise<boolean> {
      const owned = await ownedWorkspaces()
      if (owned.length === 0) return false
      const workspace = await opts.brains.resolveWorkspace((event as SessionCompletedEvent).sessionId)
      // The legacy subscriber skips an unresolvable session too, so claiming it
      // here would only produce a receipt that retries into `dead`.
      if (workspace === undefined) return false
      return owned.includes(workspace)
    },

    target: {
      actionId: BRAIN_INGEST_ACTION_ID,
      idempotent: true,
      async run(input): Promise<ReactionTargetOutcome> {
        const workspace = await opts.brains.resolveWorkspace(input.sessionId)
        if (workspace === undefined) {
          return { ok: false, retryable: false, error: "workspace_unresolved" }
        }
        if (!(await owns(workspace))) {
          return { ok: true, outcomeRef: "skipped:not-owner" }
        }
        const result = await opts.brains.getBrain(workspace).ingestSession(input.sessionId)
        if (result.ok) {
          return { ok: true, outcomeRef: `brain:${workspace}:${input.sessionId}` }
        }
        if (result.skippedReason !== undefined) {
          return { ok: true, outcomeRef: `skipped:${result.skippedReason}` }
        }
        if (result.error !== undefined) {
          return { ok: false, retryable: true, error: result.error }
        }
        log(`[brain-ingest] ${input.sessionId}: ingest returned no outcome`)
        return { ok: false, retryable: true, error: "ingest_failed" }
      },
    },
  }

  return { binding, owns }
}
