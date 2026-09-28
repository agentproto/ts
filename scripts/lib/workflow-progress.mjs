/**
 * Pure formatter for a WorkflowRun's poll heartbeat.
 *
 * Split out of `.github/actions/agentproto-run/driver.mjs` so it is unit
 * testable (the driver is a top-level script that boots a daemon on import).
 *
 * Why this exists at all: the driver's `workflow_status` poll loop used to log
 * NOTHING between "started workflow run" and the timeout. PR #1297's reviewer
 * lane produced 15 minutes of dead air followed by a bare "did not reach a
 * terminal status", leaving no way to tell whether the e2b sandbox never
 * booted, the adapter never got a first token, or the model just sat there.
 */

/**
 * Extra observability detail `describeRunProgress` cannot derive from a
 * `WorkflowRun` alone — `workflow_status`'s step rows carry only
 * index/label/status/sessionId/phase/timestamps (see `RoutineStepState` in
 * `packages/runtime/src/step-run-types.ts`), never the adapter, model,
 * sandbox placement, or turn count a session is actually running under. A
 * caller that wants those (e.g. the driver, which already knows its own
 * ADAPTER/CLI_SOURCE env and the workflow's `reviewConfig`, and can look up a
 * session's live descriptor via `session_list`) assembles this object and
 * passes it as the second argument. Entirely optional and purely additive —
 * omitting it (or passing `{}`) reproduces the exact pre-existing output.
 *
 * @typedef {object} RunProgressContext
 * @property {string} [adapter] Reviewer adapter slug for the whole run (e.g.
 *   "claude-code", "opencode") — known to the driver without any lookup.
 * @property {string} [model] Reviewer model id override, when configured.
 * @property {string} [cliSource] Where the agentproto CLI came from ("npm" | "workspace").
 * @property {number} [maxReviewTurns] `reviewConfig.maxReviewTurns`, for the turn=n/max detail.
 * @property {string} [reviewerSessionId] The reviewer step's sessionId, called out explicitly.
 * @property {Record<string, {sandboxProvider?: string, sandboxId?: string, adapterSlug?: string, model?: string, turnsCompleted?: number, toolCallsThisTurn?: number, tokensIn?: number, tokensOut?: number}>} [sessions]
 *   Per-session live detail, keyed by sessionId (from a `session_list` lookup) —
 *   only sessions the caller actually resolved need an entry. `toolCallsThisTurn`/
 *   `tokensIn`/`tokensOut` are the same fields `session_list`'s own summary
 *   already carries — no separate `session_usage` lookup needed for these.
 */

/** `1234` -> `"1.2k"`, `1_500_000` -> `"1.5M"` — keeps the heartbeat line
 *  short even once real conversations rack up six-figure token counts. */
function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** `1234` (ms) -> `"1s"`, `125_000` -> `"2m5s"`, `7_265_000` -> `"2h1m"`. */
function formatElapsedMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${minutes}m`
  if (minutes > 0) return `${minutes}m${seconds}s`
  return `${seconds}s`
}

/** Enriches one RUNNING step's `label@sessionId` with whatever live session
 *  detail `context.sessions` has for it, plus elapsed time computed from the
 *  step's own `startedAt` (no lookup needed — already on the run object). No
 *  entry and no `startedAt` ⇒ output identical to before. */
function describeRunningStep(step, context, now = Date.now()) {
  const sessionId = step?.sessionId
  const base = `${step?.label ?? '?'}${sessionId ? `@${sessionId}` : ''}`
  const info = sessionId ? context?.sessions?.[sessionId] : undefined
  const bits = []
  if (info?.sandboxProvider) {
    bits.push(`sandbox=${info.sandboxProvider}${info.sandboxId ? `:${info.sandboxId}` : ''}`)
  }
  if (info?.adapterSlug) bits.push(`adapter=${info.adapterSlug}`)
  if (info?.model) bits.push(`model=${info.model}`)
  if (info?.turnsCompleted !== undefined) {
    bits.push(`turn=${info.turnsCompleted}${context?.maxReviewTurns ? `/${context.maxReviewTurns}` : ''}`)
  }
  if (info?.toolCallsThisTurn !== undefined) bits.push(`tools=${info.toolCallsThisTurn}`)
  if (info?.tokensIn !== undefined || info?.tokensOut !== undefined) {
    bits.push(`tokens=${formatCount(info.tokensIn ?? 0)}in/${formatCount(info.tokensOut ?? 0)}out`)
  }
  if (typeof step?.startedAt === 'string') {
    const startedMs = Date.parse(step.startedAt)
    if (Number.isFinite(startedMs)) bits.push(`elapsed=${formatElapsedMs(now - startedMs)}`)
  }
  return bits.length ? `${base}(${bits.join(',')})` : base
}

/**
 * Compact one-line progress fingerprint: run status, per-stage status,
 * done/total step counts, and the label (+sessionId) of whatever is RUNNING.
 *
 * Designed to be compared against the previous call's output so the driver can
 * log on CHANGE rather than on every 3-second poll.
 *
 * @param {unknown} run a WorkflowRun (or anything — tolerates partial shapes,
 *   since it is fed straight from an MCP tool result)
 * @param {RunProgressContext} [context] optional out-of-band detail the `run`
 *   object itself doesn't carry (see the typedef above). Omitted ⇒ output is
 *   byte-identical to calling this function with one argument, always.
 * @param {number} [now] injectable clock (ms) for the `elapsed=` detail — tests
 *   only; defaults to `Date.now()`.
 * @returns {string}
 */
export function describeRunProgress(run, context, now = Date.now()) {
  const parts = [`status=${run?.status ?? '?'}`]
  for (const stage of Array.isArray(run?.stages) ? run.stages : []) {
    const steps = Array.isArray(stage?.steps) ? stage.steps : []
    const done = steps.filter((s) => s?.status === 'done').length
    const running = steps.filter((s) => s?.status === 'running')
    parts.push(
      `stage${stage?.index ?? '?'}${stage?.label ? `(${stage.label})` : ''}` +
        `=${stage?.status ?? '?'} [${done}/${steps.length}]` +
        (running.length
          ? ` running=${running.map((s) => describeRunningStep(s, context, now)).join(',')}`
          : ''),
    )
  }
  if (run?.awaitingApproval) parts.push(`awaitingApproval=${run.awaitingApproval.approvalId}`)
  if (run?.awaitingSuspend) {
    parts.push(`awaitingSuspend=${(run.awaitingSuspend.on ?? []).join('|')}`)
  }
  if (context?.reviewerSessionId) parts.push(`reviewer=${context.reviewerSessionId}`)
  if (context?.adapter) parts.push(`adapter=${context.adapter}`)
  if (context?.model) parts.push(`model=${context.model}`)
  if (context?.cliSource) parts.push(`cliSource=${context.cliSource}`)
  return parts.join(' · ')
}
