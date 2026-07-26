/**
 * "Continue fresh" — spawn a new agent session with the same compatible
 * configuration axes as a session that is nearing its context limit, and
 * inject a structured checkpoint as the new session's initial prompt.
 *
 * This is intentionally NOT an ACP-native resume; it starts a clean adapter
 * process and a new conversation, preserving only the bounded handoff.
 * Provenance is linked in both directions: the new descriptor carries
 * `continuedFrom` + `checkpointId`; the original descriptor carries
 * `continuedTo`.
 */

import { buildContextCheckpoint, persistCheckpoint, renderCheckpointPrompt } from "./context-checkpoint.js"
import type { ContextCheckpoint } from "./context-checkpoint.js"
import { computeContextPct } from "./context-continuity.js"
import {
  spawnAgentSession,
  type SpawnAgentSessionDeps,
  type SpawnAgentSessionInput,
  type SpawnAgentSessionResult,
} from "./session-spawn.js"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"

export interface ContinueAgentSessionFreshResult {
  ok: true
  descriptor: SessionDescriptor
  checkpoint: ContextCheckpoint
  continuedFrom: string
}

export interface ContinueAgentSessionFreshOptions {
  /** Optional policy override for the fresh session. */
  contextContinuity?: import("./context-continuity.js").ContextContinuityPolicy
  /** Optional base directory for checkpoint storage (tests). */
  baseDir?: string
}

function formatAccessForSpawn(desc: SessionDescriptor): { profileRef?: string } | undefined {
  if (!desc.accessProfile?.profileRef) return undefined
  return { profileRef: desc.accessProfile.profileRef }
}

function formatPostureForSpawn(
  desc: SessionDescriptor,
): import("./session-config.js").Posture | undefined {
  return desc.posture
}

/**
 * Build a fresh continuation session for `prev`.
 *
 * The original session descriptor is updated with `continuedTo` and
 * `checkpointId`; the new descriptor gets `continuedFrom` and
 * `checkpointId`.
 */
export async function continueAgentSessionFresh(
  deps: SpawnAgentSessionDeps,
  prev: SessionDescriptor,
  opts: ContinueAgentSessionFreshOptions = {},
): Promise<ContinueAgentSessionFreshResult> {
  const registry = deps.registry
  const resolveAgentAdapter = deps.resolveAgentAdapter
  if (!resolveAgentAdapter) {
    throw new Error(`Cannot continue session ${prev.id} fresh: no adapter resolver configured`)
  }
  const policy = prev.contextContinuity
  if (!policy) {
    throw new Error(`Session ${prev.id} has no resolved context continuity policy`)
  }

  const contextPct = computeContextPct(prev.contextSize, prev.contextUsed) ?? policy.continueFreshAtPct
  const checkpoint = await buildContextCheckpoint(prev, { contextPct, baseDir: opts.baseDir })
  await persistCheckpoint(checkpoint)

  const spawnInput: SpawnAgentSessionInput = {
    adapter: prev.adapterSlug ?? prev.harness ?? "claude-code",
    harness: prev.harness,
    cwd: prev.cwd,
    workspaceSlug: prev.workspaceSlug,
    parentSessionId: prev.parentSessionId,
    origin: prev.origin,
    model: prev.model,
    effort: prev.effort,
    route: prev.route,
    access: formatAccessForSpawn(prev),
    posture: formatPostureForSpawn(prev),
    contextProfile: prev.contextProfile,
    mcpServers: prev.mcpServers,
    label: prev.label ? `${prev.label} (continued)` : undefined,
    title: prev.title ? `${prev.title} (continued)` : undefined,
    contextContinuity: opts.contextContinuity ?? prev.contextContinuity,
    prompt: renderCheckpointPrompt(checkpoint),
    // Preserve lineage so the fresh session nests under the same parent
    // rather than becoming a detached root.
    ...(prev.parentSessionId ? { parentSessionId: prev.parentSessionId } : {}),
    // Carry forward useful lifecycle flags.
    keepAlive: prev.keepAlive,
    notifyParentOnCrash: prev.notifyParentOnCrash,
    permissionHold: prev.permissionHold,
  }

  const result: SpawnAgentSessionResult = await spawnAgentSession(deps, spawnInput)
  if (!result.ok) {
    throw new Error(
      `Failed to continue session ${prev.id} fresh: ${result.code} — ${result.message}`,
    )
  }

  const fresh = result.descriptor
  fresh.continuedFrom = prev.id
  fresh.checkpointId = checkpoint.checkpointId

  // Link provenance on the original descriptor too.
  const prevUpdated = registry.get(prev.id)
  if (prevUpdated) {
    prevUpdated.continuedTo = fresh.id
    prevUpdated.checkpointId = checkpoint.checkpointId
  }

  return {
    ok: true,
    descriptor: fresh,
    checkpoint,
    continuedFrom: prev.id,
  }
}
