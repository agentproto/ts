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

import { boundaryFromMeta } from "./app-boundary.js"
import { buildContextCheckpoint, persistCheckpoint, renderCheckpointPrompt } from "./context-checkpoint.js"
import type { ContextCheckpoint } from "./context-checkpoint.js"
import type { CheckpointSources, HandoffAsker } from "./checkpoint-extract.js"
import { computeContextPct } from "./context-continuity.js"
import {
  spawnAgentSession,
  type SpawnAgentSessionDeps,
  type SpawnAgentSessionInput,
  type SpawnAgentSessionResult,
} from "./session-spawn.js"
import { CALLER_SESSION_ID_HEADER, type SessionDescriptor, type SessionsRegistry } from "./sessions.js"
import { handoverLineage } from "./lineage-handover.js"
import { SESSION_TOKEN_HEADER } from "./session-credentials.js"

export interface ContinueAgentSessionFreshResult {
  ok: true
  descriptor: SessionDescriptor
  checkpoint: ContextCheckpoint
  continuedFrom: string
}

/** Thrown when the fresh session's spawn is refused; `code` is the
 *  `spawnAgentSession` failure code so HTTP callers can map it to a status. */
export class ContinueFreshSpawnError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "ContinueFreshSpawnError"
  }
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
  /** Operator notes carried into the checkpoint's `notes` section, verbatim. */
  notes?: string
  /** Ask the live source session to summarise itself before the checkpoint is
   *  built (see `BuildContextCheckpointOptions.askSource`). Default `true`;
   *  falls back to extraction when the session is dead, busy, slow or
   *  answers badly. Pass `false` when the session is at its context limit. */
  askSource?: boolean
  /** Time the source session gets to answer the handoff turn (default 60s). */
  askTimeoutMs?: number
  /** Custom handoff asker, overriding the registry-backed one. */
  handoffAsker?: HandoffAsker
  /** Last policy gate / open tasks lookups — `createCheckpointSources(...)`. */
  sources?: CheckpointSources
  /** Fields laid over the carried-forward `spawnAgentSession` input, last —
   *  how `session_migrate` moves the continuation onto a new sandbox box
   *  (`sandbox`, `workspaceSlug`, `worktree`, …) without a second copy of this
   *  carry-forward logic. */
  spawn?: Partial<SpawnAgentSessionInput>
  /** Record a `handoff` {from,to harness} pair on the fresh descriptor.
   *  Default true; a same-harness migration passes false. */
  stampHandoff?: boolean
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
    // The identity header travels with the query (see
    // `CALLER_SESSION_ID_HEADER`): strip OURS too, or the fresh session
    // would keep speaking to the daemon under the dead session's id. A
    // session token (`SESSION_TOKEN_HEADER`) is never carried forward
    // either: it names exactly one session, and the fresh session gets its
    // own at spawn. (Descriptors carry none; this guards a legacy or
    // hand-built list.)
    const original = entry.headers
    const kept = original
      ? Object.entries(original).filter(
          ([k, v]) =>
            !(k.toLowerCase() === CALLER_SESSION_ID_HEADER && v === prevId) &&
            k.toLowerCase() !== SESSION_TOKEN_HEADER,
        )
      : []
    const strippedHeader = original !== undefined && kept.length !== Object.keys(original).length
    // Apply the header strip independently of URL parseability. When our
    // header was the only one, drop the `headers` key entirely so the spawn
    // path sees no identity header and re-stamps with the fresh id.
    let next: typeof entry = entry
    if (strippedHeader) {
      const { headers: _drop, ...rest } = entry
      next = kept.length > 0 ? { ...rest, headers: Object.fromEntries(kept) } : rest
    }
    let url: URL
    try {
      url = new URL(entry.ref)
    } catch {
      return next
    }
    if (url.searchParams.get("callerSessionId") !== prevId) return next
    url.searchParams.delete("callerSessionId")
    return { ...next, ref: url.toString() }
  })
}

/**
 * Pick the source session's recorded agent binding so a fresh continuation
 * can hand it to its successor unchanged.
 *
 * The binding is frozen at the source's spawn: its role, the manifest agent
 * it bound, the delegation list that spawn resolved from the manifest, and a
 * memory opt-out. Carrying it is what stops a continuation from widening its
 * own grant (AIP-46 "No self-widening"): the successor must not come back on
 * a wider default agent, nor re-read a manifest its predecessor already had
 * frozen. The memory PROJECTION keys (`memoryInject`, `memoryAnchors`,
 * `memoryCapture`, `memoryStoreRoot`) are deliberately not picked: they
 * describe the projection the source's spawn built, and the successor's own
 * spawn recomputes its own, so carrying them would claim a projection this
 * session never had.
 */
export function pickAgentBindingMeta(
  meta: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of ["role", "agentSlug", "agentDelegatesTo"] as const) {
    const value = meta?.[key]
    if (typeof value === "string" && value !== "") picked[key] = value
  }
  // Only an opt-out is meaningful to carry: `memory.enabled: true` is the
  // default and its absence already says nothing.
  if (meta?.memory === "disabled") picked.memory = "disabled"
  return picked
}

function formatPostureForSpawn(
  desc: SessionDescriptor,
): import("./session-config.js").Posture | undefined {
  return desc.posture
}

/**
 * Remove the RETIRED " (continued)" / " (continued N)" tail a fresh
 * continuation may have stamped on a session's label or title under the old
 * numbering scheme — including the legacy repeated `(continued) (continued)`
 * form and a mixed `(continued 2) (continued)` tail. A continue-fresh no
 * longer renames the session at all: it keeps EXACTLY the previous label and
 * title (like a session that compacts in place); the continuation lineage is
 * shown separately (`continuedFrom` / `continuationGeneration`). This helper
 * only exists so existing sessions that already carry a suffix from the old
 * scheme get their clean name back on their next continuation.
 */
export function stripContinuedSuffix(label: string): string {
  const tail = label.match(/(?:\s+\(continued(?:\s\d+)?\))+$/)
  if (!tail) return label
  return label.slice(0, label.length - tail[0].length)
}

/**
 * Build a fresh continuation session for `prev`.
 *
 * The original session descriptor is updated with `continuedTo` and
 * `checkpointId`; the new descriptor gets `continuedFrom` and
 * `checkpointId` plus `continuationGeneration` (prev's own generation
 * + 1, starting at 1) — the lineage depth shown separately instead of
 * being encoded in the label. The label and title are NOT renamed: they
 * pass through unchanged (minus a legacy " (continued)" tail, see
 * {@link stripContinuedSuffix}), to match a session that compacts in place.
 *
 * A source session continues at most once. On 2026-10-26 an auto-compact turn
 * at 172k tokens re-entered this path and the daemon created two successors of
 * the same source 4.8 s apart (two checkpoints, two handoff prompts). Calls
 * are therefore memoised per `prev.id`: a duplicate or concurrent call with
 * the SAME options gets the first call's result (same checkpoint, same
 * successor) instead of a second spawn. A later call with DIFFERENT options
 * is refused with `ContinueFreshSpawnError` (`already_continued`) rather than
 * silently returning a successor that does not match the request.
 *
 * The entry is kept after success, because the source is retired and a later
 * call would still fork the lineage — including an explicit handoff that
 * leaves the source running (`performContextHandoff`): its source is linked
 * via `continuedTo`, so it too gets no second continuation. It is dropped on
 * rejection so a failed attempt can be retried. The map is bounded; only
 * SETTLED entries are evicted (oldest first), never an in-flight attempt.
 * This memo is process-local and does not survive a daemon restart; the
 * registry's `continuedTo` link remains the durable record of the lineage.
 */
export function continueAgentSessionFresh(
  deps: SpawnAgentSessionDeps,
  prev: SessionDescriptor,
  opts: ContinueAgentSessionFreshOptions = {},
): Promise<ContinueAgentSessionFreshResult> {
  const requestKey = continuationRequestKey(opts)
  const existing = continuedSources.get(prev.id)
  if (existing) {
    if (existing.requestKey === requestKey) return existing.promise
    const target = existing.result ? ` as "${existing.result.descriptor.id}"` : " (still in progress)"
    return Promise.reject(
      new ContinueFreshSpawnError(
        "already_continued",
        `Session ${prev.id} was already continued fresh${target}; refusing a second continuation with different options.`,
        {
          continuedFrom: prev.id,
          ...(existing.result
            ? {
                continuedTo: existing.result.descriptor.id,
                checkpointId: existing.result.checkpoint.checkpointId,
              }
            : {}),
        },
      ),
    )
  }
  const promise = continueAgentSessionFreshOnce(deps, prev, opts)
  const entry: ContinuedSourceEntry = { promise, requestKey, settled: false }
  continuedSources.set(prev.id, entry)
  pruneSettledContinuedSources()
  promise.then(
    result => {
      entry.settled = true
      entry.result = result
      pruneSettledContinuedSources()
    },
    () => {
      if (continuedSources.get(prev.id) === entry) continuedSources.delete(prev.id)
    },
  )
  return promise
}

export const CONTINUED_SOURCES_MAX = 128
const continuedSources = new Map<string, ContinuedSourceEntry>()

interface ContinuedSourceEntry {
  promise: Promise<ContinueAgentSessionFreshResult>
  /** Canonical signature of the options that decide what the continuation
   *  does; a cache hit with a different signature is a conflict, not a
   *  duplicate. */
  requestKey: string
  settled: boolean
  result?: ContinueAgentSessionFreshResult
}

/** Clear the per-source continuation memo. Test-only isolation hook. */
export function resetContinueFreshMemoForTests(): void {
  continuedSources.clear()
}

function pruneSettledContinuedSources(): void {
  if (continuedSources.size <= CONTINUED_SOURCES_MAX) return
  for (const [id, entry] of continuedSources) {
    if (continuedSources.size <= CONTINUED_SOURCES_MAX) return
    if (entry.settled) continuedSources.delete(id)
  }
}

function continuationRequestKey(opts: ContinueAgentSessionFreshOptions): string {
  return canonicalize({
    adapter: opts.adapter ?? opts.harness,
    harness: opts.harness ?? opts.adapter,
    model: opts.model,
    access: opts.access,
    notes: opts.notes,
    askSource: opts.askSource,
    askTimeoutMs: opts.askTimeoutMs,
    stampHandoff: opts.stampHandoff,
    contextContinuity: opts.contextContinuity,
    spawn: opts.spawn,
  })
}

/** Stable JSON for option comparison — key order must not turn a duplicate
 *  into a false conflict. `baseDir`, `sources` and `handoffAsker` are
 *  deliberately not part of the signature: they are a storage location and
 *  per-call dependency hooks, not a different target. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined"
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`
}

async function continueAgentSessionFreshOnce(
  deps: SpawnAgentSessionDeps,
  prev: SessionDescriptor,
  opts: ContinueAgentSessionFreshOptions,
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
  const checkpoint = await buildContextCheckpoint(prev, {
    contextPct,
    baseDir: opts.baseDir,
    registry,
    ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
    ...(opts.askSource !== undefined ? { askSource: opts.askSource } : {}),
    ...(opts.askTimeoutMs !== undefined ? { askTimeoutMs: opts.askTimeoutMs } : {}),
    ...(opts.handoffAsker ? { handoffAsker: opts.handoffAsker } : {}),
    ...(opts.sources ? { sources: opts.sources } : {}),
  })
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

  // An explicit agent/role in the continuation request wins outright, and
  // then nothing from the source's binding is carried (see
  // {@link pickAgentBindingMeta} for why the rest is carried as frozen).
  const bindingOverridden =
    opts.spawn?.role !== undefined ||
    opts.spawn?.agent !== undefined ||
    opts.spawn?.agentId !== undefined ||
    opts.spawn?.agentPath !== undefined
  const carriedBinding = bindingOverridden ? undefined : pickAgentBindingMeta(prev.meta)

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
    label: prev.label ? stripContinuedSuffix(prev.label) : undefined,
    title: prev.title ? stripContinuedSuffix(prev.title) : undefined,
    contextContinuity: opts.contextContinuity ?? prev.contextContinuity,
    // The clerk hook's AGENT level lives on the descriptor; `spawnAgentSession`
    // re-reads it from `hooks.clerk`.
    ...(prev.clerkHook ? { hooks: { clerk: prev.clerkHook } } : {}),
    prompt: renderCheckpointPrompt(checkpoint),
    // Preserve lineage so the fresh session nests under the same parent
    // rather than becoming a detached root.
    ...(prev.parentSessionId ? { parentSessionId: prev.parentSessionId } : {}),
    // Carry forward useful lifecycle flags.
    keepAlive: prev.keepAlive,
    notifyParentOnCrash: prev.notifyParentOnCrash,
    permissionHold: prev.permissionHold,
    // The lineage's AGENT.md system-prompt text — `spawnAgentSession`
    // re-decides the delivery path for whatever adapter this fresh session
    // lands on (channel vs prefix+warning), including after a harness switch.
    ...(prev.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: prev.appendSystemPrompt }
      : {}),
    // Carry forward turn-retry policy (including fallback chain) across handoffs.
    ...(prev.turnRetry ? { turnRetry: prev.turnRetry } : {}),
    // The fresh session stays inside the same app boundary as `prev`.
    ...(boundaryFromMeta(prev.meta) ? { appBoundary: boundaryFromMeta(prev.meta)! } : {}),
    // The internal role spelling `spawnAgentSession` takes; the `role` alias
    // warning is emitted only by the MCP/HTTP handlers, so none is produced
    // here. Placed before `opts.spawn` so an explicit request still wins.
    ...(carriedBinding?.role !== undefined ? { role: carriedBinding.role } : {}),
    ...opts.spawn,
  }

  const result: SpawnAgentSessionResult = await spawnAgentSession(deps, spawnInput)
  if (!result.ok) {
    throw new ContinueFreshSpawnError(
      result.code,
      `Failed to continue session ${prev.id} fresh: ${result.code} — ${result.message}`,
      result.details,
    )
  }

  const fresh = result.descriptor
  if (prev.operatorLabel) registry.setOperatorLabel(fresh.id, prev.operatorLabel)
  if (prev.operator) registry.setOperator(fresh.id, prev.operator, prev.operatorDigest)
  if (prev.toolDenyGrants) registry.setToolDenyGrants(fresh.id, prev.toolDenyGrants)
  // The spawn just wrote ITS OWN binding (the default agent for its depth, or
  // whatever the request named). Put the source's frozen binding back on top
  // so a continuation cannot widen its grant by re-spawning itself (AIP-46
  // "No self-widening"): the manifest identity, its delegation list and a
  // memory opt-out are exactly what the source's spawn recorded, never what
  // AGENT.md says now. `role` is already in the spawn input above; the merge
  // is gated by the same "request named none" condition.
  if (carriedBinding && Object.keys(carriedBinding).length > 0 && registry.get(fresh.id)) {
    registry.mergeMeta(fresh.id, carriedBinding)
  }
  // Same reasoning as `operatorLabel` above: `allowPromptFrom` is applied
  // post-spawn by the `agent_start` MCP handler, never re-derived by
  // `spawnAgentSession` — a continue-fresh landing on a NEW session id
  // must carry it forward explicitly or a permanent agent's drive grants
  // silently vanish at the next continuation.
  if (prev.allowPromptFrom?.length) registry.setPromptPolicy(fresh.id, [...prev.allowPromptFrom])
  fresh.continuedFrom = prev.id
  fresh.checkpointId = checkpoint.checkpointId
  // Lineage generation: `prev` (gen 0, absent) → 1, then +1 per hop. Persisted
  // on the descriptor like `continuedFrom`, exposed wherever that is.
  fresh.continuationGeneration = (prev.continuationGeneration ?? 0) + 1
  if (opts.stampHandoff !== false) {
    fresh.handoff = {
      fromHarness: prev.harness ?? prev.adapterSlug ?? "claude-code",
      toHarness: fresh.harness ?? fresh.adapterSlug ?? adapter,
      at: new Date().toISOString(),
    }
  }

  // Link provenance on the original descriptor too.
  const prevUpdated = registry.markRetired(prev.id, { continuedTo: fresh.id, cause: "continued" })
  if (prevUpdated) prevUpdated.checkpointId = checkpoint.checkpointId

  // Lineage handover: the fresh session TAKES OVER the retired row's
  // position. Its live children are re-parented onto it - so the new brain
  // can drive them (the drive-tool gate keys on `parentSessionId`) and they
  // report to it (`message_parent` routes to the recorded parent). Without
  // this, a continued "brain" leaves its supervisors attached to a dead
  // row: the new one cannot drive them and they cannot report up.
  // Best-effort: a failed handover never fails the continuation.
  try {
    handoverLineage({
      registry,
      from: prev.id,
      to: fresh.id,
      reason: "continue-fresh",
      actor: "daemon",
    })
  } catch (err) {
    console.warn(
      `[continue-fresh] lineage handover failed for ${prev.id} -> ${fresh.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  return {
    ok: true,
    descriptor: fresh,
    checkpoint,
    continuedFrom: prev.id,
  }
}
