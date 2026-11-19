/**
 * `session_handoff` core: hand a session's work to a new model and/or harness,
 * optionally ON ITSELF ("I'm a Sonnet session, pass me to Fable").
 *
 * It is NOT a second continuation path. The new-session case delegates to
 * `continueAgentSessionFresh` (the same function `session_continue_fresh` and
 * `POST /sessions/:id/handoff` use: checkpoint, label/parent/pin carry,
 * children handover, `succeeds`). What this adds is only the `context` axis
 * and closing the source once the successor is confirmed running.
 *
 * | context           | what happens                                              |
 * | ----------------- | --------------------------------------------------------- |
 * | `handoff-summary` | (default) checkpoint -> NEW session; the prompt names the |
 * |                   | previous session id and `transcript_read`.                |
 * | `harness-compact` | native `/compact` on the source, then the model switch:   |
 * |                   | in place when the harness stays, else a summary handoff.  |
 * | `none`            | model change in place, no new session. Same harness only. |
 *
 * (A full replay of the transcript is `session_restart`, not offered here: it
 * rebuilds the prompt cache and is the costly mode this tool exists to avoid.)
 */

import { getAuthProfile } from "@agentproto/auth"
import { profileAllowsModelId, profileModelAllowlistMessage } from "./auth-profile-model-allowlist.js"
import { checkModelPolicy } from "./model-policy.js"
import { getModelListSource } from "./model-list-store.js"
import { continueAgentSessionFresh, ContinueFreshSpawnError } from "./session-continue-fresh.js"
import type { ContinueAgentSessionFreshOptions } from "./session-continue-fresh.js"
import { handOverOrchestratorScopes } from "./session-restart-core.js"
import { compactCommandNameFor } from "./session-self-command.js"
import type { SpawnAgentSessionDeps } from "./session-spawn.js"
import type { SessionDescriptor, SetSessionModelResult } from "./sessions.js"

export const HANDOFF_CONTEXT_MODES = ["handoff-summary", "harness-compact", "none"] as const
export type HandoffContextMode = (typeof HANDOFF_CONTEXT_MODES)[number]
export const DEFAULT_HANDOFF_CONTEXT: HandoffContextMode = "handoff-summary"

/** Stable refusal codes — the caller can branch on `HandoffError.code`. */
export type HandoffErrorCode =
  | "nothing_to_change"
  | "harness_change_needs_new_session"
  | "model_refused"
  | "in_place_not_supported"
  | "compact_from_self"
  | "compact_failed"
  | "successor_not_started"
  | "spawn_refused"

export class HandoffError extends Error {
  constructor(
    readonly code: HandoffErrorCode | string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "HandoffError"
  }
}

export interface SessionHandoffInput {
  /** How much of the conversation travels. Default `handoff-summary`. */
  context?: HandoffContextMode
  /** Target harness slug. Omitted -> the source's. */
  harness?: string
  /** Target model. Omitted -> the source's (a pure harness move). */
  model?: string
  /** Named auth profile (billing wallet) for the successor. */
  access?: { profileRef: string }
  /** Status the next agent must know (decisions, constraints, next step).
   *  Carried verbatim into the checkpoint's `notes`. */
  notes?: string
  /** Close the source once the successor is confirmed started. Default true.
   *  Ignored for in-place modes (nothing to close). */
  closeSource?: boolean
  /** Ask the live source to summarise itself (handoff-summary). Default true
   *  — except when the source is the caller, which is mid-turn and cannot
   *  answer: then `notes` is the summary. */
  askSource?: boolean
}

export interface SessionHandoffDeps {
  spawn: SpawnAgentSessionDeps
  /** Session making the call (daemon-attested). Equal to the source = self-call. */
  callerSessionId?: string
  /** Last policy gate / open tasks lookups for the checkpoint. */
  sources?: ContinueAgentSessionFreshOptions["sources"]
  /** Re-point cron jobs that named the retired session. */
  rearmCrons?: (from: string, to: string) => string[]
  /** How long to wait for the successor to be live / the source to compact. */
  startConfirmTimeoutMs?: number
  compactTimeoutMs?: number
  /** Delay before closing a source that is the caller, so its own tool result
   *  gets back first. */
  selfCloseDelayMs?: number
  pollMs?: number
  // Test seams — default to the real primitives.
  continueFresh?: typeof continueAgentSessionFresh
  sleep?: (ms: number) => Promise<void>
  precheckModel?: (desc: SessionDescriptor, model: string) => Promise<string | undefined>
}

export interface SessionHandoffResult {
  context: HandoffContextMode
  /** `new-session` | `in-place`. */
  mode: "new-session" | "in-place"
  from: string
  /** Successor id (new-session) or the same id (in-place). */
  to: string
  model: string | undefined
  harness: string | undefined
  /** Source closed (new-session only). */
  sourceClosed: boolean
  /** Self-handoff: the source is the caller and is closed shortly AFTER this
   *  result returns (`sourceClosed` stays false until it really is). */
  sourceClosePending?: boolean
  /** The source is the caller: it is closed right after this result returns. */
  selfHandoff: boolean
  checkpointId?: string
  /** Compaction requested before the switch (harness-compact). */
  compacted?: boolean
  /** The mode that actually ran when it differs from the one asked. */
  fellBackTo?: HandoffContextMode
  rearmedCrons?: string[]
  warnings: string[]
}

const isLive = (d: SessionDescriptor | undefined): boolean =>
  !!d && (d.status === "running" || d.status === "starting")

const realSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function defaultPrecheckModel(desc: SessionDescriptor, model: string): Promise<string | undefined> {
  const verdict = checkModelPolicy(model, desc.modelPolicy, getModelListSource())
  if (!verdict.ok) return `policy:${verdict.code}: ${verdict.reason}`
  const ref = desc.accessProfile?.profileRef
  if (ref) {
    const profile = await getAuthProfile(ref)
    if (profile && !profileAllowsModelId(profile, model, {})) {
      return profileModelAllowlistMessage(profile.id, model, profile.models?.ids ?? [])
    }
  }
  return undefined
}

export async function performSessionHandoff(
  deps: SessionHandoffDeps,
  prev: SessionDescriptor,
  input: SessionHandoffInput,
): Promise<SessionHandoffResult> {
  const context = input.context ?? DEFAULT_HANDOFF_CONTEXT
  const registry = deps.spawn.registry
  const sleep = deps.sleep ?? realSleep
  const pollMs = deps.pollMs ?? 250
  const warnings: string[] = []
  const selfHandoff = deps.callerSessionId !== undefined && deps.callerSessionId === prev.id
  const currentHarness = prev.harness ?? prev.adapterSlug
  const harnessChanges = input.harness !== undefined && input.harness !== currentHarness
  const modelChanges = input.model !== undefined && input.model !== prev.model
  const profileChanges =
    input.access !== undefined && input.access.profileRef !== prev.accessProfile?.profileRef
  if (!harnessChanges && !modelChanges && !profileChanges) {
    throw new HandoffError(
      "nothing_to_change",
      `session_handoff: ${prev.id} already runs ${prev.model ?? "its model"} on ${currentHarness ?? "its harness"}` +
        ` with this profile — pass a different \`model\`, \`harness\` or \`access\`.`,
    )
  }

  const precheck = deps.precheckModel ?? defaultPrecheckModel
  const refuseIfModelRefused = async (): Promise<void> => {
    if (!input.model) return
    const refusal = await precheck(prev, input.model)
    if (refusal) {
      throw new HandoffError(
        "model_refused",
        `session_handoff: model "${input.model}" refused for ${prev.id}: ${refusal}`,
        { model: input.model, reason: refusal },
      )
    }
  }

  const result: SessionHandoffResult = {
    context,
    mode: "new-session",
    from: prev.id,
    to: prev.id,
    model: input.model ?? prev.model,
    harness: input.harness ?? currentHarness,
    sourceClosed: false,
    selfHandoff,
    warnings,
  }

  // ── none: in-place model change ────────────────────────────────────
  if (context === "none") {
    if (harnessChanges || profileChanges) {
      throw new HandoffError(
        "harness_change_needs_new_session",
        `session_handoff context "none" only changes the model of the running session: a different ` +
          `harness or access profile needs a new session — use context "handoff-summary".`,
      )
    }
    await refuseIfModelRefused()
    await switchModelInPlace(registry, prev, input.model as string)
    result.mode = "in-place"
    return result
  }

  // ── harness-compact: compact natively, then switch ─────────────────
  let askSourceDefault = input.askSource
  if (context === "harness-compact") {
    if (selfHandoff) {
      throw new HandoffError(
        "compact_from_self",
        `session_handoff context "harness-compact" can't compact the caller from inside its own turn ` +
          `(the /compact would only run after it ends). Use "handoff-summary", or have the parent call it.`,
      )
    }
    await refuseIfModelRefused()
    await compactAndWait(deps, prev)
    result.compacted = true
    if (!harnessChanges && !profileChanges && input.model !== undefined) {
      await switchModelInPlace(registry, prev, input.model)
      result.mode = "in-place"
      return result
    }
    // Harness (or wallet) changes: the compact source is now cheap to
    // summarise, so fall through to a summary handoff taken from it.
    result.fellBackTo = "handoff-summary"
    askSourceDefault = input.askSource ?? true
  }

  // ── handoff-summary (also the tail of harness-compact) ─────────────
  const continueFresh = deps.continueFresh ?? continueAgentSessionFresh
  let fresh: Awaited<ReturnType<typeof continueAgentSessionFresh>>
  try {
    fresh = await continueFresh(deps.spawn, prev, {
      ...(input.harness !== undefined ? { harness: input.harness } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.access !== undefined ? { access: input.access } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      // A self-caller is mid-turn: asking it for a summary would only time out.
      askSource: selfHandoff ? false : (askSourceDefault ?? true),
      ...(deps.sources ? { sources: deps.sources } : {}),
    })
  } catch (err) {
    throw asHandoffError(err)
  }
  const to = fresh.descriptor.id
  result.to = to
  result.checkpointId = fresh.checkpoint.checkpointId

  // Confirm the successor started BEFORE the source goes away.
  const confirmed = await waitUntil(
    () => {
      const d = registry.get(to)
      return d !== undefined && isLive(d)
    },
    deps.startConfirmTimeoutMs ?? 15_000,
    pollMs,
    sleep,
  )
  if (!confirmed) {
    warnings.push(
      `successor ${to} did not reach running within ${deps.startConfirmTimeoutMs ?? 15_000}ms: ` +
        `the source ${prev.id} was NOT closed. Check the successor, then close the source yourself.`,
    )
    return result
  }

  // The successor also takes the orchestrator scope, like a restart does.
  handOverOrchestratorScopes(registry, prev.id, to)
  if (deps.rearmCrons) result.rearmedCrons = deps.rearmCrons(prev.id, to)

  if (input.closeSource !== false) {
    if (selfHandoff) {
      // The caller IS the source: closing it now would kill the very call
      // that is returning this result. Close right after.
      const t = setTimeout(() => {
        try {
          registry.kill(prev.id, "SIGTERM", "restarted")
        } catch {
          // best effort — the row is already retired (continuedTo)
        }
      }, deps.selfCloseDelayMs ?? 2_000)
      if (typeof t === "object" && "unref" in t) t.unref()
      result.sourceClosePending = true
      warnings.push(`source ${prev.id} (this session) closes in ~${(deps.selfCloseDelayMs ?? 2_000) / 1000}s.`)
    } else {
      try {
        result.sourceClosed = registry.kill(prev.id, "SIGTERM", "restarted")
      } catch (err) {
        warnings.push(`closing source ${prev.id} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return result
}

async function waitUntil(
  cond: () => boolean,
  timeoutMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (cond()) return true
    if (Date.now() >= deadline) return false
    await sleep(pollMs)
  }
}

async function compactAndWait(deps: SessionHandoffDeps, prev: SessionDescriptor): Promise<void> {
  const registry = deps.spawn.registry
  const sleep = deps.sleep ?? realSleep
  if (!isLive(prev)) {
    throw new HandoffError("compact_failed", `session_handoff: ${prev.id} is not live, cannot compact it.`)
  }
  const name = compactCommandNameFor(prev.harness ?? prev.adapterSlug)
  const cmd = `/${name}`
  // Without this, a harness that doesn't know the command would end its turn
  // normally and the handoff would look compacted when it was not.
  const advertised = registry.get(prev.id)?.availableCommands ?? prev.availableCommands
  if (advertised && advertised.length > 0 && !advertised.some(c => c.name.toLowerCase() === name)) {
    throw new HandoffError(
      "compact_failed",
      `session_handoff: ${prev.harness ?? prev.adapterSlug ?? "this harness"} does not advertise ${cmd}; nothing was switched.`,
    )
  }
  try {
    // No calling session = the operator called the tool: send it source-less so
    // `compactRequiresOperator` sees the operator's agreement; a calling
    // session keeps its `agent:` provenance and stays subject to that policy.
    await registry.sendPrompt(
      prev.id,
      cmd,
      deps.callerSessionId ? { source: `agent:${deps.callerSessionId}` } : undefined,
    )
  } catch (err) {
    throw new HandoffError(
      "compact_failed",
      `session_handoff: /compact refused: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const idle = await waitUntil(
    () => registry.get(prev.id)?.busy !== true,
    deps.compactTimeoutMs ?? 120_000,
    deps.pollMs ?? 250,
    sleep,
  )
  if (!idle) {
    throw new HandoffError(
      "compact_failed",
      `session_handoff: ${prev.id} still busy ${(deps.compactTimeoutMs ?? 120_000) / 1000}s after /compact; nothing was switched.`,
    )
  }
}

async function switchModelInPlace(
  registry: SpawnAgentSessionDeps["registry"],
  prev: SessionDescriptor,
  model: string,
): Promise<void> {
  const r: SetSessionModelResult = await registry.setModel(prev.id, model)
  if (r.applied) return
  const reason = r.reason ?? "unknown"
  if (reason === "requires-restart" || reason === "not-supported") {
    throw new HandoffError(
      "in_place_not_supported",
      `session_handoff: ${prev.harness ?? prev.adapterSlug ?? "this harness"} can't switch to "${model}" live ` +
        `(${reason}). Retry with context "handoff-summary" (new session).`,
      { reason, ...(r.suggestedOverride ? { suggestedOverride: r.suggestedOverride } : {}) },
    )
  }
  throw new HandoffError("model_refused", `session_handoff: model "${model}" refused: ${reason}`, { model, reason })
}

/** Spawn refusals that mean "this model/profile pair is not allowed" — surfaced
 *  as the explicit `model_refused`, never retried on another wallet. */
const MODEL_REFUSAL_SPAWN_CODES: ReadonlySet<string> = new Set([
  "access_profile_ineligible",
  "access_profile_not_found",
  "auth_profile_denied",
  "model_wallet_ineligible",
  "model_adapter_incompatible",
  "model_policy_refused",
])

function asHandoffError(err: unknown): HandoffError {
  if (err instanceof HandoffError) return err
  if (err instanceof ContinueFreshSpawnError) {
    return new HandoffError(
      MODEL_REFUSAL_SPAWN_CODES.has(err.code) ? "model_refused" : "spawn_refused",
      `session_handoff: ${err.message}`,
      { spawnCode: err.code, ...err.details },
    )
  }
  return new HandoffError("spawn_refused", `session_handoff: ${err instanceof Error ? err.message : String(err)}`)
}
