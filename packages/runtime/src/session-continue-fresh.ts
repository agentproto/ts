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
 *
 * Every axis is independently overridable (`opts.adapter`/`harness`,
 * `opts.model`, `opts.access`) — an omitted axis is carried forward from
 * `prev` unchanged, an axis set here wins, same convention as
 * `session_restart`'s override axes. This is what makes a CROSS-harness
 * handoff (claude-code -> opencode, etc) possible: model x profile
 * eligibility for the resolved (adapter, route) is validated by
 * `spawnAgentSession` itself — the same function `agent_start` calls, so the
 * same guard applies. The new descriptor also carries `handoff` (see
 * {@link import("./sessions.js").SessionHandoff}) recording which harness the
 * checkpoint moved from/to.
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
  /** Override the adapter (driver slug) for the fresh session — the
   *  cross-harness handoff axis. Alias of `harness`; when both are set,
   *  `harness` wins for the descriptor's `harness` label but this still
   *  picks the driver. Omitted -> carried forward from `prev`, unchanged. */
  adapter?: string
  /** Override the canonical harness slug for the fresh session. Alias of
   *  `adapter` — set either or both. Omitted -> carried forward from `prev`. */
  harness?: string
  /** Override the model for the fresh session. Omitted -> carried forward
   *  from `prev`, unchanged. */
  model?: string
  /** Switch the fresh session's billing wallet to a named auth profile.
   *  Omitted -> carried forward from `prev`'s own `accessProfile`, unchanged.
   *  Eligibility against the resolved (adapter x route) is validated by
   *  `spawnAgentSession` exactly as it is for `agent_start` — an ineligible
   *  profile fails the spawn with `access_profile_ineligible` rather than
   *  silently landing on a wrong wallet. */
  access?: { profileRef: string }
}

function formatAccessForSpawn(desc: SessionDescriptor): { profileRef?: string } | undefined {
  if (!desc.accessProfile?.profileRef) return undefined
  return { profileRef: desc.accessProfile.profileRef }
}

/**
 * Drop the RETIRED session's own identity stamp from carried-over MCP
 * mounts so the spawn path re-stamps them with the fresh session's id.
 *
 * The spawn path bakes `callerSessionId=<own id>` into daemon-targeting
 * `mcpServers` refs (identity, not capability — see session-spawn.ts) and
 * deliberately respects an entry that already carries one. Copying `prev`'s
 * mounts verbatim would therefore pin the NEW session's outbound identity —
 * and every descendant's auto-attach lineage — to the dead id. Strip
 * exactly our own stale stamp (value === `prev.id`); an explicit foreign
 * pin someone set on purpose is preserved, matching the spawn path's
 * "caller who set callerSessionId themselves is respected" contract.
 */
export function stripOwnCallerStamp(
  servers: SessionDescriptor["mcpServers"],
  prevId: string,
): SessionDescriptor["mcpServers"] {
  if (!servers) return servers
  return servers.map(entry => {
    if (entry.transport !== "http" || typeof entry.ref !== "string") return entry
    let url: URL
    try {
      url = new URL(entry.ref)
    } catch {
      return entry
    }
    if (url.searchParams.get("callerSessionId") !== prevId) return entry
    url.searchParams.delete("callerSessionId")
    return { ...entry, ref: url.toString() }
  })
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

  // Cross-harness handoff (SPEC gap #5): each axis below is independently
  // overridable — omitted falls back to `prev`'s own value, exactly like
  // `session_restart`'s override axes. `adapter` picks the driver; `harness`
  // is the descriptor label (defaults to `adapter` inside `spawnAgentSession`
  // when unset) — set either or both.
  const adapter = opts.adapter ?? opts.harness ?? prev.adapterSlug ?? prev.harness ?? "claude-code"
  const harness = opts.harness ?? opts.adapter ?? prev.harness
  const model = opts.model ?? prev.model
  const access = opts.access ?? formatAccessForSpawn(prev)
  // `prev.route` was resolved for the OLD adapter's gateway. Carrying it
  // forward unconditionally into a DIFFERENT adapter is doubly wrong: it may
  // not even be reachable from there, and an explicit `route.gateway` also
  // SKIPS `spawnAgentSession`'s adapter-capability eligibility guard (it only
  // runs when `route.gateway` is undefined — see its own comment) — exactly
  // the guard a cross-harness handoff needs. Drop it whenever the adapter is
  // actually changing so the router re-derives (and re-validates) the route
  // for the NEW adapter from scratch, same as a fresh `agent_start` would.
  const adapterChanged = opts.adapter !== undefined || opts.harness !== undefined
  const route = adapterChanged ? undefined : prev.route

  const spawnInput: SpawnAgentSessionInput = {
    adapter,
    harness,
    cwd: prev.cwd,
    workspaceSlug: prev.workspaceSlug,
    parentSessionId: prev.parentSessionId,
    origin: prev.origin,
    model,
    effort: prev.effort,
    route,
    access,
    posture: formatPostureForSpawn(prev),
    contextProfile: prev.contextProfile,
    mcpServers: stripOwnCallerStamp(prev.mcpServers, prev.id),
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
  fresh.handoff = {
    fromHarness: prev.harness ?? prev.adapterSlug ?? "claude-code",
    toHarness: fresh.harness ?? fresh.adapterSlug ?? adapter,
    at: new Date().toISOString(),
  }

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
