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

import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { EventRing } from "./event-ring.js"
import type { AgentAdapterResolver } from "./http-server.js"
import { spawnAgentSession, type SpawnAgentSessionDeps, type SpawnAgentSessionInput } from "./session-spawn.js"
import { monitorSessionWait } from "./orchestration-tools.js"
import { getHarnessPreset, type HarnessPreset } from "./harness-preset-store.js"
import { getUserPreset, type UserPreset } from "./user-presets.js"
import type { ReviewerRunResult, ReviewerSessionHost } from "./review-runner.js"
import type { LaneFallback } from "@agentproto/review"
import { getAuthProfile, type AuthProfile } from "@agentproto/auth"

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
const WALLET_EXHAUSTED_RE = /usage limit|quota exceeded|insufficient (credit|balance|funds)|rate limit exceeded/i
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
    const cooldown = blockedCooldown(profileRef, model)
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
        return {
          retryable: isRetryableTurnError(res.error),
          fallbackable: true,
          result: withModel({
            status: "failed",
            sessionId,
            preset: input.preset,
            error: res.error
              ? `reviewer's turn ended with reason 'error': ${clip(res.error)}`
              : "reviewer's turn ended with reason 'error' (the adapter reported no error text)",
          }),
        }
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
      return once(withModel({ status: "ended", sessionId, preset: input.preset }))
    } finally {
      input.signal?.removeEventListener("abort", onAbort)
      // One-shot reviewer: its verdict is on disk (or it failed) — release
      // the adapter process. The session row and transcript stay
      // inspectable.
      kill()
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
        const outcome = await runPreset({ ...input, preset, label }, deadline)
        const { result } = outcome
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
