/**
 * The daemon's {@link ReviewerSessionHost}: agent review lanes as CHILD
 * SESSIONS, spawned through the same `spawnAgentSession` core `agent_start`
 * uses, waited on with the same `monitorSessionWait` core `session_monitor` /
 * `sessions wait` use, and stopped through `registry.kill` — the normal
 * session lifecycle, so a timed-out or cancelled reviewer is a killed session
 * in `session_list`, never an orphan pid.
 *
 * A lane's `preset` names the daemon's existing preset surface — no parallel
 * model/auth config: first a harness preset (`harness-presets.json`: adapter
 * harness + auth profile + default model), then a user preset
 * (`presets.json`, handed to `spawnAgentSession` as-is so it expands the
 * preset exactly like `agent_start.presetId` does).
 *
 * Reviewers spawn with role `executor` (no re-delegation), `worktree: false`
 * (they read the reviewed checkout's history; they never edit), and
 * `dedupe: false` (two lanes/runs with the same label are distinct
 * reviewers, never merged).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { EventRing } from "./event-ring.js"
import type { AgentAdapterResolver } from "./http-server.js"
import { spawnAgentSession, cleanAgentLines, type SpawnAgentSessionDeps, type SpawnAgentSessionInput } from "./session-spawn.js"
import { monitorSessionWait } from "./orchestration-tools.js"
import { getHarnessPreset, type HarnessPreset } from "./harness-preset-store.js"
import { getUserPreset, type UserPreset } from "./user-presets.js"
import type { ReviewerRunResult, ReviewerSessionHost } from "./review-runner.js"
import { parseAgentLaneReport, type LaneFallback, type LaneRecovery, type LaneSharedExecution } from "@agentproto/review"
import {
  RECOVERY_FOLLOWUP_MIN_MS,
  RECOVERY_MAX_CANDIDATES,
  RECOVERY_MIN_EVIDENCE_CHARS,
  RECOVERY_STEP_MAX_MS,
  RECOVERY_STEP_MIN_MS,
  analyzeReviewerTranscript,
  boundEvidence,
  boundText,
  buildFollowUpPrompt,
  buildRecoveryPrompt,
  evaluateRecoveryReply,
  extractExplicitReport,
  substantiveChars,
  type RecoveryDecision,
  type ReviewerLifecycle,
  type ReviewerTranscript,
} from "./review-verdict-recovery.js"
import { getAuthProfile, type AuthProfile } from "@agentproto/auth"
import { shareKeyOf } from "./review-execution-share.js"
import { openEventRecords } from "./events-jsonl-reader.js"

export interface DaemonReviewerHostDeps {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  eventRing: EventRing
  resolveAgentAdapter: AgentAdapterResolver
  /** Extra spawn deps forwarded to `spawnAgentSession` (sandbox resolver,
   *  catalog models, …). `registry`/`resolveAgentAdapter` always win. */
  spawnDeps?: Partial<SpawnAgentSessionDeps>
  /** Preset lookups — injectable for tests; default to the real stores. */
  getHarnessPreset?: (id: string) => Promise<HarnessPreset | undefined>
  getUserPreset?: (id: string) => Promise<UserPreset | undefined>
  /** Extra attempts for a lane whose turn ends in a transient error (socket
   *  closed, 5xx, overloaded). Default {@link DEFAULT_LANE_RETRIES}; `0`
   *  disables. Mirrors `config.review.laneRetries`. */
  laneRetries?: number
  /** Auth-profile lookup for the OpenRouter guard — injectable for tests. */
  getAuthProfile?: (id: string) => Promise<AuthProfile | undefined>
  /** Clock for the exhausted-wallet cooldowns — injectable for tests;
   *  default {@link Date.now}. */
  now?: () => number
  /** Where the bounded verdict-recovery step runs (read per recovery, so a
   *  config change applies without a restart). Unset / no presets ⇒ a lane
   *  that ends without a valid verdict file is classified `unavailable` and
   *  left incomplete — recovery never silently picks a model. */
  getRecovery?: () => ReviewRecoveryConfig | undefined
}

/** The recovery step's model selection. `presets` are reviewer presets (the
 *  same harness/user presets lanes use, so the same OpenRouter guard and
 *  wallet cooldowns apply); `model`, when set (the `review.recovery` model
 *  role), overrides the model/profile each of them would run. */
export interface ReviewRecoveryConfig {
  presets: string[]
  model?: { model: string; profile?: string }
}

/** Retries (after the first attempt) for a lane whose reviewer turn ends in a
 *  transient transport error. */
export const DEFAULT_LANE_RETRIES = 1
const MAX_LANE_RETRIES = 5

/** An errored turn whose text says the retry cannot help: bad credentials, an
 *  exhausted quota, an unknown model. Everything else that ends a turn in
 *  `error` — a dropped socket, a 5xx, an overloaded provider, or an error with
 *  no text at all — is worth one more attempt. */
const PERMANENT_ERROR_RE =
  /\b(401|403|404)\b|unauthori[sz]ed|forbidden|authentication|invalid[^.]{0,20}(api[ -]?key|credential|token|model)|usage limit|quota|insufficient|billing|model[^.]{0,30}not (found|supported)/i

export function isRetryableTurnError(message: string | undefined): boolean {
  return !message || !PERMANENT_ERROR_RE.test(message)
}

/** How long to wait for the transcript writer's async flush to land a `turn-end` record. */
const TRANSCRIPT_FLUSH_WAIT_MS = 3_000
const TRANSCRIPT_POLL_MS = 50

const clip = (text: string, max = 300): string => {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** Cooldown before a profile whose wallet a provider declared EMPTY is worth
 *  spawning against again. A spent usage limit / quota / balance does not
 *  refill mid-run; a rate limit does, quickly. */
export const WALLET_EXHAUSTED_COOLDOWN_MS = 15 * 60_000
export const WALLET_RATE_LIMIT_COOLDOWN_MS = 60_000

/** An error saying the AUTH PROFILE's wallet is empty — the next spawn
 *  against the same profile fails the same way, so skip it (let the lane's
 *  `fallbackPresets` chain advance) instead of burning a process + a
 *  transcript dir on a reviewer that cannot run. Narrower than
 *  {@link PERMANENT_ERROR_RE}: this is not "don't retry the turn", it is
 *  "don't touch this wallet again for a while". */
const WALLET_EXHAUSTED_RE =
  /usage limit (reached|exceeded)|quota exceeded|insufficient (credit|balance|funds)|rate limit exceeded/i
const RATE_LIMIT_RE = /rate limit exceeded/i

/** The auth profile a resolved preset would spawn under — harness presets
 *  put it in `access.profileRef` directly; user presets nest it in their own
 *  `access.profileRef`. */
export function reviewerProfileRef(fields: Pick<SpawnAgentSessionInput, "access" | "preset">): string | undefined {
  const userPreset = fields.preset as UserPreset | undefined
  return fields.access?.profileRef ?? userPreset?.access?.profileRef
}

/** The model a resolved preset would run — the spawn `model` when the preset
 *  carried one (harness presets project `defaultModel` into it), else the
 *  user preset's own. */
export function reviewerModel(fields: Pick<SpawnAgentSessionInput, "model" | "preset">): string | undefined {
  const userPreset = fields.preset as UserPreset | undefined
  return fields.model ?? userPreset?.model
}

interface AttemptOutcome {
  result: ReviewerRunResult
  /** The reviewer's turn ended in a transient error — another attempt may succeed. */
  retryable: boolean
  /** The reviewer was UNAVAILABLE (spawn failure, errored or empty turn,
   *  session exited before finishing its turn) — the next `fallbackPresets`
   *  entry may be tried. False for a verdict, a timeout, a cancel, a preset
   *  that does not resolve, and the OpenRouter refusal: none of those is a
   *  transport problem a different reviewer should paper over. */
  fallbackable: boolean
}

const OPENROUTER_RE = /openrouter/i

/** Fail closed: a review lane must never bill OpenRouter (pay-per-token
 *  credit). Returns a human-readable refusal when the resolved lane would
 *  route there — via the model id, the preset, or the auth profile's billing
 *  endpoint — else `undefined`. */
export async function reviewerOpenRouterViolation(
  presetId: string,
  spawnFields: Pick<SpawnAgentSessionInput, "adapter" | "model" | "access" | "preset">,
  lookup: (id: string) => Promise<AuthProfile | undefined> = getAuthProfile,
): Promise<string | undefined> {
  const model = reviewerModel(spawnFields)
  const profileRef = reviewerProfileRef(spawnFields)
  let profile: AuthProfile | undefined
  if (profileRef) {
    try {
      profile = await lookup(profileRef)
    } catch (err) {
      // Can't prove the billing endpoint: refuse rather than guess.
      return `review lane refused: could not read auth profile '${profileRef}' to verify it does not bill OpenRouter (${err instanceof Error ? err.message : String(err)}).`
    }
  }
  const hits: string[] = []
  if (OPENROUTER_RE.test(presetId)) hits.push(`preset '${presetId}'`)
  if (model && OPENROUTER_RE.test(model)) hits.push(`model '${model}'`)
  if (profileRef && OPENROUTER_RE.test(profileRef)) hits.push(`auth profile '${profileRef}'`)
  if (profile && OPENROUTER_RE.test(profile.endpoint)) hits.push(`auth profile '${profile.id}' (billing endpoint '${profile.endpoint}')`)
  if (hits.length === 0) return undefined
  return `review lane refused: ${hits.join(", ")} would bill OpenRouter, which is disabled for code reviews. Use a different preset (e.g. opencode-default-go, or a Claude-subscription preset such as claude-subs-agentik).`
}

/** Resolve a lane's `preset` to spawn fields — harness preset first, then a
 *  user preset. `undefined` when neither store knows the id. */
export async function resolveReviewerPreset(
  preset: string,
  lookups: Pick<DaemonReviewerHostDeps, "getHarnessPreset" | "getUserPreset"> = {},
): Promise<Pick<SpawnAgentSessionInput, "adapter" | "model" | "access" | "preset"> | undefined> {
  const harness = await (lookups.getHarnessPreset ?? getHarnessPreset)(preset)
  if (harness) {
    return { adapter: harness.harnessSlug, model: harness.defaultModel, access: { profileRef: harness.profileRef } }
  }
  const user = await (lookups.getUserPreset ?? getUserPreset)(preset)
  const adapter = user?.adapter ?? user?.harness
  if (user && adapter) return { adapter, preset: user }
  return undefined
}

const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  )

/** What a resolved preset would actually run — adapter, model, auth profile and
 *  (for a user preset) its remaining spawn config — independent of the preset's
 *  id/label/bookkeeping, so two differently named presets that resolve to the
 *  same reviewer are the same reviewer. */
export function reviewerFingerprint(fields: Pick<SpawnAgentSessionInput, "adapter" | "model" | "access" | "preset">): string {
  const user = fields.preset as (UserPreset & Record<string, unknown>) | undefined
  const config = user
    ? Object.fromEntries(
        Object.entries(user).filter(([k]) => !["id", "label", "lastUsedAt", "createdAt", "updatedAt", "cwd"].includes(k)),
      )
    : undefined
  return stableStringify({
    adapter: fields.adapter ?? user?.adapter ?? user?.harness,
    model: reviewerModel(fields),
    profile: reviewerProfileRef(fields),
    config,
  })
}

export function createDaemonReviewerHost(deps: DaemonReviewerHostDeps): ReviewerSessionHost {
  const { registry, sessionEvents, eventRing } = deps
  const maxRetries = Math.min(MAX_LANE_RETRIES, Math.max(0, Math.floor(deps.laneRetries ?? DEFAULT_LANE_RETRIES)))
  const now = deps.now ?? Date.now

  /** Cooldown key → `{ until, error }`: a wallet a provider has already
   *  declared empty (or a model it is currently rate-limiting). Two key
   *  shapes, deliberately: `${profileRef}` for wallet exhaustion — a spent
   *  usage limit / quota / insufficient balance drains the WHOLE profile —
   *  and `${profileRef}::${model}` for a rate limit, which is per MODEL:
   *  several free models share one profile on purpose (opencode-zen-free's
   *  mimo/step5/nemotron), and a lane chain falls back ACROSS them, so a
   *  rate limit on one must not skip its siblings. Per HOST instance — the
   *  daemon builds one host for its singleton review runner (`index.ts`), so
   *  this map is shared across every review lane and every review run in the
   *  process. Entries expire by `until`; keys are bounded by the auth store
   *  × the models lanes actually run, so the map cannot grow without limit. */
  const exhaustedProfiles = new Map<string, { until: number; error: string }>()

  /** A failed attempt whose error says the wallet is empty (or the model is
   *  rate-limited) → cool the right key down so later lanes skip it. No-op
   *  for a failure with no profile behind it, or one whose text isn't
   *  wallet-shaped. */
  const noteWalletExhausted = (profileRef: string | undefined, model: string | undefined, error: string | undefined) => {
    if (!profileRef || !error || !WALLET_EXHAUSTED_RE.test(error)) return
    const rateLimited = RATE_LIMIT_RE.test(error)
    const key = rateLimited ? `${profileRef}::${model ?? ""}` : profileRef
    const cooldownMs = rateLimited ? WALLET_RATE_LIMIT_COOLDOWN_MS : WALLET_EXHAUSTED_COOLDOWN_MS
    exhaustedProfiles.set(key, { until: now() + cooldownMs, error: clip(error) })
  }

  /** The live cooldown on `key`, if any — expired entries are dropped here,
   *  so a profile/model is tried again the moment its cooldown ends. */
  const cooldownFor = (key: string | undefined): { until: number; error: string } | undefined => {
    if (!key) return undefined
    const hit = exhaustedProfiles.get(key)
    if (!hit) return undefined
    if (hit.until <= now()) {
      exhaustedProfiles.delete(key)
      return undefined
    }
    return hit
  }

  /** The cooldown blocking THIS attempt, if any: the whole profile first
   *  (wallet drained), then this profile's MODEL bucket (rate limit). */
  const blockedCooldown = (
    profileRef: string | undefined,
    model: string | undefined,
  ): { until: number; error: string; perModel: boolean } | undefined => {
    const whole = cooldownFor(profileRef)
    if (whole) return { ...whole, perModel: false }
    const perModel = cooldownFor(profileRef === undefined ? undefined : `${profileRef}::${model ?? ""}`)
    return perModel ? { ...perModel, perModel: true } : undefined
  }

  const readLines = (sessionId: string): string[] => {
    const lines: string[] = []
    const unsub = registry.attach(sessionId, (line) => {
      lines.push(line)
    })
    unsub?.()
    return lines
  }

  /** Why `path` is not an acceptable verdict file, or `undefined` when it is
   *  one — the canonical lane parser, the same one the runner re-applies. */
  const artifactProblem = async (path: string): Promise<string | undefined> => {
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch {
      return "verdict file was not written"
    }
    try {
      parseAgentLaneReport(raw)
      return undefined
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  type RecoveryModelReply =
    | { kind: "reply"; text: string; sessionId: string; preset: string; model?: string }
    | { kind: "unavailable"; reason: string }
    | { kind: "timeout" }
    | { kind: "cancelled" }

  /** One bounded small-model call: read-only, empty scratch cwd, killed and
   *  archived before returning. Candidates are tried only while they fail to
   *  START or END a turn (never after a reply), at most
   *  {@link RECOVERY_MAX_CANDIDATES} spawns. */
  async function runRecoveryModel(args: {
    config: ReviewRecoveryConfig
    prompt: string
    label: string
    parentSessionId?: string
    signal?: AbortSignal
    deadline: number
  }): Promise<RecoveryModelReply> {
    const notes: string[] = []
    let spawns = 0
    let scratch: string | undefined
    try {
      for (const presetId of args.config.presets) {
        if (spawns >= RECOVERY_MAX_CANDIDATES) break
        if (args.signal?.aborted) return { kind: "cancelled" }
        const stepMs = Math.min(RECOVERY_STEP_MAX_MS, args.deadline - Date.now() - 500)
        if (stepMs < RECOVERY_STEP_MIN_MS) return { kind: "timeout" }
        const base = await resolveReviewerPreset(presetId, deps)
        if (!base) {
          notes.push(`recovery preset '${presetId}' not found`)
          continue
        }
        const fields: typeof base = args.config.model
          ? {
              ...base,
              model: args.config.model.model,
              ...(args.config.model.profile ? { access: { profileRef: args.config.model.profile } } : {}),
            }
          : base
        const profileRef = reviewerProfileRef(fields)
        const model = reviewerModel(fields)
        const cooling = blockedCooldown(profileRef, model)
        if (cooling) {
          notes.push(`recovery preset '${presetId}' skipped: exhausted until ${new Date(cooling.until).toISOString()}`)
          continue
        }
        const violation = await reviewerOpenRouterViolation(presetId, fields, deps.getAuthProfile)
        if (violation) {
          notes.push(violation)
          continue
        }
        spawns++
        scratch ??= await mkdtemp(join(tmpdir(), "agp-review-recover-"))
        const since = eventRing.since(Number.MAX_SAFE_INTEGER, { limit: 0 }).nextCursor
        const spawned = await spawnAgentSession(
          { ...deps.spawnDeps, registry, resolveAgentAdapter: deps.resolveAgentAdapter },
          {
            ...fields,
            cwd: scratch,
            prompt: args.prompt,
            label: args.label,
            role: "executor",
            origin: "review",
            posture: "read-only",
            worktree: false,
            dedupe: false,
            ...(args.parentSessionId ? { parentSessionId: args.parentSessionId } : {}),
          },
        )
        if (!spawned.ok) {
          noteWalletExhausted(profileRef, model, spawned.message)
          notes.push(`recovery preset '${presetId}' failed to start: ${clip(spawned.message)}`)
          continue
        }
        const id = spawned.descriptor.id
        const stop = () => {
          try {
            registry.kill(id)
          } catch {
            // already gone
          }
        }
        args.signal?.addEventListener("abort", stop, { once: true })
        if (args.signal?.aborted) stop()
        try {
          const res = await monitorSessionWait({
            registry,
            sessionEvents,
            eventRing,
            sessionIds: [id],
            event: "any",
            timeoutMs: Math.max(1, Math.min(stepMs, args.deadline - Date.now())),
            since,
          })
          if (res.timedOut) return { kind: "timeout" }
          if (args.signal?.aborted) return { kind: "cancelled" }
          if (res.event === "turn-end" && res.reason === "error") {
            noteWalletExhausted(profileRef, model, res.error)
            notes.push(`recovery preset '${presetId}' errored: ${clip(res.error ?? "no error text")}`)
            continue
          }
          if (res.event !== "turn-end" || res.empty) {
            notes.push(`recovery preset '${presetId}' produced no reply`)
            continue
          }
          const desc = registry.get(id)
          const text = cleanAgentLines(readLines(id)).join("\n").trim()
          const usedModel = desc?.activeModel ?? desc?.model ?? model
          return { kind: "reply", text, sessionId: id, preset: presetId, ...(usedModel ? { model: usedModel } : {}) }
        } finally {
          args.signal?.removeEventListener("abort", stop)
          stop()
          try {
            if (!registry.get(id)?.archived) registry.archiveSession(id)
          } catch {
            // best-effort
          }
        }
      }
      return { kind: "unavailable", reason: notes.length ? notes.join("; ") : "no recovery model could be started" }
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  type ArtifactState =
    | { state: "valid" }
    | { state: "recovered"; recovery: LaneRecovery }
    | { state: "unrecovered"; recovery: LaneRecovery }

  /** The reviewer's typed transcript (`events.jsonl`) for its latest turn,
   *  or `undefined` when provenance cannot be established — no transcript
   *  file, or no `turn-end` record yet (the writer flushes asynchronously, so
   *  it is polled briefly, never past the deadline or a cancel). */
  const readTranscript = async (
    sessionId: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<ReviewerTranscript | undefined> => {
    const path = registry.get(sessionId)?.eventsPath
    if (!path) return undefined
    const until = Math.min(deadline, Date.now() + TRANSCRIPT_FLUSH_WAIT_MS)
    for (;;) {
      try {
        const records: Record<string, unknown>[] = []
        for await (const rec of await openEventRecords(path, 0)) records.push(rec)
        const transcript = analyzeReviewerTranscript(records)
        if (transcript.turnEnded) return transcript
      } catch {
        // not on disk yet
      }
      if (signal?.aborted || Date.now() >= until) return undefined
      await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_POLL_MS))
    }
  }

  /** The verdict file is checked here — at turn end, while the reviewer
   *  session is still alive. Valid ⇒ nothing to do. Otherwise, all inside the
   *  original deadline and cancellation:
   *   1. a complete verdict the reviewer itself stated in chat is extracted
   *      deterministically from its typed transcript (no model call);
   *   2. else ONE recovery-model step that may only lift grounded BLOCKING
   *      findings, or ask for a follow-up (never an approval);
   *   3. a follow-up goes to the ORIGINAL reviewer, at most once.
   *  Only the daemon ever writes a recovered file. */
  async function ensureArtifact(args: {
    input: Parameters<ReviewerSessionHost["run"]>[0]
    artifact: NonNullable<Parameters<ReviewerSessionHost["run"]>[0]["artifact"]>
    sessionId: string
    deadline: number
    lifecycle: ReviewerLifecycle
    lifecycleDetail?: string
  }): Promise<ArtifactState> {
    const { input, artifact, sessionId, deadline, lifecycle } = args
    const problem = await artifactProblem(artifact.path)
    if (!problem) return { state: "valid" }
    const fail = (outcome: LaneRecovery["outcome"], reason: string, extra: Partial<LaneRecovery> = {}): ArtifactState => ({
      state: "unrecovered",
      recovery: { outcome, reason: clip(reason), ...extra },
    })
    if (input.signal?.aborted) return fail("cancelled", "review cancelled before recovery")

    // A recovered report on a failed turn keeps the provider's own error
    // text in its reason — the lane result would otherwise read as ended.
    const lifecyclePrefix = lifecycle === "errored" ? `reviewer turn failed (${args.lifecycleDetail ?? "error"}); ` : ""
    const recoveredOk = (reason: string, extra: Partial<LaneRecovery> = {}): ArtifactState => ({
      state: "recovered",
      recovery: { outcome: "recovered", reason: clip(`${lifecyclePrefix}${reason}`, 600), ...extra },
    })
    const writeReport = async (report: unknown): Promise<string | undefined> => {
      await writeFile(artifact.path, JSON.stringify(report), "utf8")
      return artifactProblem(artifact.path)
    }

    const config = deps.getRecovery?.()
    const configured = !!config && config.presets.length > 0

    // 1. Deterministic extraction from the reviewer's own assistant messages.
    let transcript: ReviewerTranscript | undefined
    let conflict: string | undefined
    if (configured) {
      transcript = await readTranscript(sessionId, deadline, input.signal)
      if (input.signal?.aborted) return fail("cancelled", "review cancelled before recovery")
      if (transcript) {
        const extracted = extractExplicitReport(transcript.assistantText, { blockOn: artifact.blockOn, lifecycle })
        if (extracted.kind === "report") {
          const after = await writeReport(extracted.report)
          if (after) return fail("invalid_output", `reviewer's stated verdict did not validate once written — ${after}`)
          return recoveredOk("verdict extracted verbatim from the reviewer's own final message; no recovery model used")
        }
        if (extracted.kind === "conflict") conflict = extracted.reason
      }
    }

    const evidence = transcript ? boundText(transcript.assistantText) : boundEvidence(readLines(sessionId))
    if (substantiveChars(evidence) < RECOVERY_MIN_EVIDENCE_CHARS) {
      return fail("reviewer_failed", `no analysis to recover from (${problem})`)
    }
    if (deadline - Date.now() < RECOVERY_STEP_MIN_MS) return fail("timeout", "no deadline left for recovery")
    if (!configured) {
      return fail("unavailable", `${problem}; no recovery model configured (config.review.recoveryPresets)`)
    }

    const canFollowUp = () =>
      lifecycle === "clean" &&
      !input.signal?.aborted &&
      deadline - Date.now() >= RECOVERY_FOLLOWUP_MIN_MS &&
      registry.get(sessionId)?.status === "running"

    // 2. One recovery-model step — skipped when the reviewer's own messages
    //    held conflicting verdicts (only the reviewer can settle those).
    let decision: RecoveryDecision
    let provenance: Partial<LaneRecovery> = {}
    if (conflict) {
      decision = canFollowUp()
        ? { kind: "followup", reason: conflict }
        : { kind: "classified", outcome: "insufficient_evidence", reason: `${conflict}; no follow-up possible` }
    } else {
      const reply = await runRecoveryModel({
        config: config!,
        prompt: buildRecoveryPrompt({
          laneId: artifact.laneId,
          blockOn: artifact.blockOn,
          evidence,
          lifecycle,
          ...(args.lifecycleDetail ? { lifecycleDetail: args.lifecycleDetail } : {}),
          followUpPossible: canFollowUp() && deadline - Date.now() >= RECOVERY_STEP_MIN_MS + RECOVERY_FOLLOWUP_MIN_MS,
        }),
        label: `${input.label}:recover`,
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        deadline,
      })
      if (reply.kind === "cancelled") return fail("cancelled", "review cancelled during recovery")
      if (reply.kind === "timeout") return fail("timeout", "recovery ran out of deadline")
      if (reply.kind === "unavailable") return fail("unavailable", reply.reason)
      provenance = { sessionId: reply.sessionId, preset: reply.preset, ...(reply.model ? { model: reply.model } : {}) }
      decision = evaluateRecoveryReply(reply.text, {
        evidence,
        lifecycle,
        blockOn: artifact.blockOn,
        followUpPossible: canFollowUp(),
      })
    }
    if (decision.kind === "classified") return fail(decision.outcome, `${lifecyclePrefix}${decision.reason}`, provenance)
    if (decision.kind === "invalid") return fail("invalid_output", `${lifecyclePrefix}${decision.reason}`, provenance)
    if (decision.kind === "recovered") {
      const after = await writeReport(decision.report)
      if (after) return fail("invalid_output", `recovered report did not validate once written — ${after}`, provenance)
      return recoveredOk(decision.reason ?? "blocking findings lifted from the reviewer's chat", provenance)
    }

    // 3. The ORIGINAL reviewer gets one normal prompt to state its verdict —
    //    only with the lifecycle intact and time left, and never a second one.
    if (!canFollowUp()) return fail("insufficient_evidence", `${decision.reason}; no follow-up possible`, provenance)
    const since = eventRing.since(Number.MAX_SAFE_INTEGER, { limit: 0 }).nextCursor
    try {
      await registry.enqueuePrompt(sessionId, buildFollowUpPrompt(artifact.path, conflict ? "conflict" : "no-conclusion"))
    } catch (err) {
      return fail("insufficient_evidence", `follow-up could not be delivered: ${err instanceof Error ? err.message : String(err)}`, provenance)
    }
    const res = await monitorSessionWait({
      registry,
      sessionEvents,
      eventRing,
      sessionIds: [sessionId],
      event: "any",
      timeoutMs: Math.max(1, deadline - Date.now()),
      since,
    })
    if (res.timedOut) return fail("timeout", "follow-up ran out of deadline", provenance)
    if (input.signal?.aborted) return fail("cancelled", "review cancelled during follow-up", provenance)
    if (res.event === "exited") {
      return fail("reviewer_failed", `reviewer session exited during the follow-up (${decision.reason})`, provenance)
    }
    const followErrored = res.event === "turn-end" && res.reason === "error"
    const followError = followErrored ? ` — follow-up turn failed: ${clip(res.error ?? "no error text", 160)}` : ""
    let finalProblem = await artifactProblem(artifact.path)
    if (finalProblem) {
      // The follow-up may state its verdict in chat instead of writing it.
      const followTranscript = await readTranscript(sessionId, deadline, input.signal)
      if (followTranscript) {
        const extracted = extractExplicitReport(followTranscript.assistantText, {
          blockOn: artifact.blockOn,
          lifecycle: followErrored ? "errored" : "clean",
        })
        if (extracted.kind === "report") finalProblem = await writeReport(extracted.report)
      }
    }
    if (finalProblem) {
      return fail("insufficient_evidence", `${decision.reason}; follow-up wrote no valid verdict (${finalProblem})${followError}`, provenance)
    }
    if (followErrored) {
      // An errored turn never earns an approval, even one it managed to write.
      let approved = false
      try {
        approved = parseAgentLaneReport(await readFile(artifact.path, "utf8")).decision === "approve"
      } catch {
        approved = true
      }
      if (approved) {
        await rm(artifact.path, { force: true }).catch(() => undefined)
        return fail("reviewer_failed", `an approval is not accepted from a failed turn${followError}`, provenance)
      }
    }
    return {
      state: "recovered",
      recovery: { outcome: "followup", reason: clip(`${decision.reason}${followError}`), ...provenance },
    }
  }

  async function runAttempt(
    input: Parameters<ReviewerSessionHost["run"]>[0],
    attempt: number,
  ): Promise<AttemptOutcome> {
    const once = (result: ReviewerRunResult): AttemptOutcome => ({ result, retryable: false, fallbackable: false })
    const unavailable = (result: ReviewerRunResult): AttemptOutcome => ({ result, retryable: false, fallbackable: true })
    const spawnFields = await resolveReviewerPreset(input.preset, deps)
    if (!spawnFields) {
      return once({
        status: "failed",
        preset: input.preset,
        error: `preset '${input.preset}' not found — neither a harness preset (harness_preset_list) nor a user preset`,
      })
    }
    const profileRef = reviewerProfileRef(spawnFields)
    const model = reviewerModel(spawnFields)
    // An exhausted wallet (or a rate-limited MODEL on it) is skipped BEFORE
    // anything is spawned: the chain falls through to the next fallback
    // instantly instead of paying for a session that is doomed to the same
    // error. Wallet cooldowns are checked first — a drained profile blocks
    // every model on it.
    // NOT on a retry: `attempt > 0` means the same preset's own previous
    // attempt just recorded that cooldown (a rate limit is retryable), so
    // consulting it here would turn every lane retry into a `skipped` and
    // neutralise `laneRetries` for rate limits. The retry is the one caller
    // that must be allowed through — every other lane/preset still sees the
    // cooldown and is skipped.
    const cooldown = attempt > 0 ? undefined : blockedCooldown(profileRef, model)
    if (cooldown && profileRef) {
      const where = cooldown.perModel ? `auth profile '${profileRef}' (model '${model ?? "unknown"}')` : `auth profile '${profileRef}'`
      return unavailable({
        status: "failed",
        preset: input.preset,
        error: `skipped: ${where} is exhausted until ${new Date(cooldown.until).toISOString()} (${cooldown.error})`,
      })
    }
    const blocked = await reviewerOpenRouterViolation(input.preset, spawnFields, deps.getAuthProfile)
    if (blocked) return once({ status: "failed", preset: input.preset, error: blocked })
    if (input.signal?.aborted) {
      return once({ status: "failed", preset: input.preset, error: "review cancelled before the reviewer spawned" })
    }
    // Cursor BEFORE the spawn: the wait below replays from here, so a
    // reviewer whose turn ends before we subscribe is still seen.
    const since = eventRing.since(Number.MAX_SAFE_INTEGER, { limit: 0 }).nextCursor
    const spawned = await spawnAgentSession(
      { ...deps.spawnDeps, registry, resolveAgentAdapter: deps.resolveAgentAdapter },
      {
        ...spawnFields,
        cwd: input.cwd,
        prompt: input.prompt,
        label: attempt === 0 ? input.label : `${input.label}:retry${attempt}`,
        role: "executor",
        origin: "review",
        worktree: false,
        dedupe: false,
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      },
    )
    if (!spawned.ok) {
      noteWalletExhausted(profileRef, model, spawned.message)
      return unavailable({
        status: "failed",
        preset: input.preset,
        error: `reviewer spawn failed (${spawned.code}): ${spawned.message}`,
      })
    }
    const sessionId = spawned.descriptor.id
    const attemptDeadline = Date.now() + input.timeoutMs
    /** The reviewer's model, read off the session record (the live active
     *  model when the adapter reported one, else the spawn model). */
    const withModel = <T extends ReviewerRunResult>(r: T): T => {
      const desc = registry.get(sessionId)
      const model = desc?.activeModel ?? desc?.model ?? spawnFields.model
      return model ? { ...r, model } : r
    }
    const kill = () => {
      try {
        registry.kill(sessionId)
      } catch {
        // already gone
      }
    }
    const archive = () => {
      try {
        if (!registry.get(sessionId)?.archived) registry.archiveSession(sessionId)
      } catch {
        // Best-effort: a refused archive just leaves the row visible.
      }
    }
    // Cancel = kill through the lifecycle; the kill's `session:exited`
    // settles the wait below.
    const onAbort = () => kill()
    input.signal?.addEventListener("abort", onAbort, { once: true })
    // An abort that landed WHILE the spawn was in flight fired before the
    // listener existed — honour it now.
    if (input.signal?.aborted) kill()
    try {
      const res = await monitorSessionWait({
        registry,
        sessionEvents,
        eventRing,
        sessionIds: [sessionId],
        event: "any",
        timeoutMs: input.timeoutMs,
        since,
      })
      if (res.timedOut) return once(withModel({ status: "timeout", sessionId, preset: input.preset }))
      if (input.signal?.aborted) {
        return once(
          withModel({
            status: "failed",
            sessionId,
            preset: input.preset,
            error: "review cancelled while the reviewer was running",
          }),
        )
      }
      if (res.event === "exited") {
        const status = registry.get(sessionId)?.status ?? res.status
        return unavailable(
          withModel({
            status: "failed",
            sessionId,
            preset: input.preset,
            error: `reviewer session exited before finishing its turn (status '${status ?? "unknown"}')`,
          }),
        )
      }
      if (res.event === "turn-end" && res.reason === "error") {
        noteWalletExhausted(profileRef, model, res.error)
        const retryable = isRetryableTurnError(res.error)
        const failed = withModel({
          status: "failed" as const,
          sessionId,
          preset: input.preset,
          error: res.error
            ? `reviewer's turn ended with reason 'error': ${clip(res.error)}`
            : "reviewer's turn ended with reason 'error' (the adapter reported no error text)",
        })
        // A transient error with an attempt left is retried in a fresh
        // session first. Otherwise the partial analysis may still hold a
        // faithfully recoverable BLOCKING conclusion (never an approval).
        if (input.artifact && !(retryable && attempt < maxRetries)) {
          const art = await ensureArtifact({
            input,
            artifact: input.artifact,
            sessionId,
            deadline: attemptDeadline,
            lifecycle: "errored",
            lifecycleDetail: res.error ? clip(res.error, 160) : "turn ended with reason 'error'",
          })
          if (art.state === "recovered") {
            return once(withModel({ status: "ended" as const, sessionId, preset: input.preset, recovery: art.recovery }))
          }
          if (art.state === "unrecovered") {
            return { retryable, fallbackable: true, result: { ...failed, recovery: art.recovery } }
          }
        }
        return { retryable, fallbackable: true, result: failed }
      }
      // An errored turn that produced nothing is also `empty` — check `error`
      // first so a connection dropped at turn start is still retried and
      // reported with its own text.
      if (res.event === "turn-end" && res.empty) {
        return unavailable(
          withModel({
            status: "failed",
            sessionId,
            preset: input.preset,
            error: "reviewer produced an empty turn (commonly an auth failure or an invalid model id)",
          }),
        )
      }
      const ended = withModel({ status: "ended" as const, sessionId, preset: input.preset })
      if (!input.artifact) return once(ended)
      const art = await ensureArtifact({
        input,
        artifact: input.artifact,
        sessionId,
        deadline: attemptDeadline,
        lifecycle: "clean",
      })
      return once(art.state === "valid" ? ended : { ...ended, recovery: art.recovery })
    } finally {
      input.signal?.removeEventListener("abort", onAbort)
      // One-shot reviewer: its verdict is on disk (or it failed) — release
      // the adapter process, then archive the row so finished lanes don't
      // pile up in the session list. `kill()` flips the status to a terminal
      // one synchronously (what `archiveSession` requires); the transcript
      // stays readable. By now the result (incl. `withModel`) is built.
      kill()
      archive()
    }
  }

  /** One preset's turn, with the per-attempt transient-error retries. */
  async function runPreset(
    input: Parameters<ReviewerSessionHost["run"]>[0],
    deadline: number,
  ): Promise<AttemptOutcome> {
    let last: AttemptOutcome | undefined
    let attempts = 0
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const remainingMs = deadline - Date.now()
      if (attempt > 0 && remainingMs <= 0) break
      last = await runAttempt({ ...input, timeoutMs: Math.max(1, remainingMs) }, attempt)
      attempts++
      if (!last.retryable || input.signal?.aborted) break
    }
    const final = last!
    if (final.result.status === "failed" && final.retryable && attempts > 1) {
      return { ...final, result: { ...final.result, error: `${final.result.error} (after ${attempts} attempts)` } }
    }
    return final
  }

  /** The captured verdict file of a shared execution, so a joiner can be
   *  handed an identical copy at its own verdict path. */
  interface SharedStepValue {
    outcome: AttemptOutcome
    raw?: string
  }

  /** One chain step. With `input.share`, a step whose resolved reviewer is
   *  equivalent to another lane's runs ONCE (owner) and the others wait for it
   *  (joiners) — see `review-execution-share.ts`. The OpenRouter guard runs for
   *  every participant, joiners included, because a preset NAME can trip it
   *  even when the resolved reviewer is identical. */
  async function runStep(
    input: Parameters<ReviewerSessionHost["run"]>[0],
    deadline: number,
  ): Promise<{ outcome: AttemptOutcome; shared?: LaneSharedExecution }> {
    const share = input.share
    const fields = share ? await resolveReviewerPreset(input.preset, deps) : undefined
    if (!share || !fields) return { outcome: await runPreset(input, deadline) }
    const blocked = await reviewerOpenRouterViolation(input.preset, fields, deps.getAuthProfile)
    if (blocked) return { outcome: { result: { status: "failed", preset: input.preset, error: blocked }, retryable: false, fallbackable: false } }

    const artifact = input.artifact
    const res = await share.coordinator.run<SharedStepValue>({
      key: shareKeyOf([share.key, reviewerFingerprint(fields)]),
      laneId: share.laneId,
      ...(input.signal ? { signal: input.signal } : {}),
      deadline,
      execute: async (signal) => {
        const outcome = await runPreset({ ...input, signal }, deadline)
        const raw =
          outcome.result.status === "ended" && artifact && !(await artifactProblem(artifact.path))
            ? await readFile(artifact.path, "utf8")
            : undefined
        return { outcome, ...(raw !== undefined ? { raw } : {}) }
      },
      retain: (v) => v.outcome.result.status === "ended" && (!artifact || v.raw !== undefined),
    })
    const shared: LaneSharedExecution | undefined = res.mark
    if (res.kind === "left") {
      const waiting = shared?.role === "joiner" ? ` while waiting for the shared reviewer execution of lane '${shared.ownerLane}'` : ""
      return {
        outcome: {
          retryable: false,
          fallbackable: false,
          result: {
            status: "failed",
            preset: input.preset,
            error:
              res.why === "cancelled"
                ? `review cancelled${waiting || " while the reviewer was running"}`
                : `no time left${waiting}`,
          },
        },
        ...(shared ? { shared } : {}),
      }
    }
    if (shared?.role === "joiner" && artifact && res.value.raw !== undefined) {
      await writeFile(artifact.path, res.value.raw, "utf8")
    }
    return { outcome: res.value.outcome, ...(shared ? { shared } : {}) }
  }

  return {
    async run(input): Promise<ReviewerRunResult> {
      // ONE deadline for the whole chain: a fallback gets whatever time the
      // unavailable reviewers left, never a fresh `timeoutMs`.
      const deadline = Date.now() + input.timeoutMs
      const chain = [input.preset, ...(input.fallbackPresets ?? [])]
      const earlier: LaneFallback[] = []
      const describe = (items: readonly LaneFallback[]) => items.map((t) => `'${t.preset}': ${t.error}`).join("; ")
      for (let i = 0; i < chain.length; i++) {
        const preset = chain[i]!
        const label = i === 0 ? input.label : `${input.label}:fallback${i}`
        const { outcome, shared } = await runStep({ ...input, preset, label }, deadline)
        const { result: stepResult } = outcome
        const result = shared ? { ...stepResult, sharedExecution: shared } : stepResult
        const withEarlier = <T extends ReviewerRunResult>(r: T): T => (earlier.length > 0 ? { ...r, fallbacks: [...earlier] } : r)
        if (result.status !== "failed" || !outcome.fallbackable || chain.length === 1) return withEarlier(result)
        const tried = [...earlier, { preset, error: result.error }]
        const next = chain[i + 1]
        if (next === undefined) {
          return withEarlier({ ...result, error: `every reviewer in the chain was unavailable — ${describe(tried)}` })
        }
        if (input.signal?.aborted || deadline - Date.now() <= 0) {
          return withEarlier({
            ...result,
            error: `${input.signal?.aborted ? "review cancelled" : "no time left"} before trying '${next}' — ${describe(tried)}`,
          })
        }
        earlier.push({ preset, error: result.error })
      }
      throw new Error("unreachable: reviewer chain is never empty")
    },
  }
}
