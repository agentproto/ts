// Mechanical session-health rules, ported from the `kill-idle-sessions`
// cron prototype (`.plans/session-steward-cron/SESSIONS-LOG.md`, rules 1-9 +
// the three "Retours steward" dogfood blocks). Each rule here is a PURE
// function over data the workflow already gathers — `session_list`
// descriptors, `tool_calls_list` records, `host_load`, `app_state` events —
// with no I/O, no clock read, no daemon state, so a unit test pins it
// exactly. `entry.mjs` (the WORKFLOW.md step graph) wires them; the LLM/Jev
// judge only sees what stays ambiguous after these rules have spoken.
//
// Safety shape (mirrors origin-policy.mjs):
//   - a `looping` session is NEVER closed — the proposed action is a nudge
//     interrupt, and only ever a PROPOSAL in the report;
//   - a stall proposes a "continue" nudge, never a close;
//   - at most ONE nudge proposal per session per pass;
//   - the proposed actions are reported in dry run exactly as in apply —
//     `apply` never changes what these pure functions decide, only whether
//     the report is executed elsewhere.
//
// Provenance lives in origin-policy.mjs and still wins: a user-origin
// session is reported as observed, never nudged (a human is in the loop).

// ── loop detection (mission item 1) ──────────────────────────────────────

/** Rolling window the loop signals are computed over. */
export const LOOP_WINDOW_MS = 10 * 60 * 1000
/** Same call signature (verbatim argv) this many times in the window. */
export const LOOP_VERBATIM_MIN = 3
/** Distinct/total below this, with at least {@link LOOP_RATIO_MIN_CALLS}
 *  calls, is a repetition loop. */
export const LOOP_RATIO_MAX = 0.2
export const LOOP_RATIO_MIN_CALLS = 8
/** The same file re-read this many times in the window. */
export const LOOP_REREAD_MIN = 4

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0
const str = (v) => (isNonEmptyString(v) ? v.trim() : undefined)

/** The verbatim argv signature of one `tool_calls_list` record — tool name +
 *  command + args, whitespace-collapsed. This is the "même commande relancée
 *  verbatim" signal from the log (a `rg … | head -10` repeated six times). */
export function callSignature(record) {
  const tool = str(record?.tool) ?? "unknown"
  const command = str(record?.command)
  const args = Array.isArray(record?.args) ? record.args.map(String) : []
  const tail = args.length > 0 ? args.join(" ") : ""
  return `${tool} ${command ?? ""} ${tail}`.replace(/\s+/g, " ").trim()
}

/**
 * Command families the log explicitly calls USEFUL loops, not stuck ones:
 * `watch`, a test/type-check re-run, `git status` between steps, and a
 * `gh pr view`/`checks` watch poll. Their repeats are excluded from the
 * repetition signals, so a watchdog polling PR state for ten minutes is not
 * flagged as a loop (SESSIONS-LOG: "watch polling legitime", "tests re-run").
 */
export function isUsefulLoopCommand(signature) {
  const s = String(signature ?? "").toLowerCase()
  if (/(^|[^a-z])watch([^a-z]|$)/.test(s)) return true
  if (/(^|[^a-z])git\s+status([^a-z]|$)/.test(s)) return true
  if (/(pnpm|npm|yarn|npx|bun)\s+(run\s+)?(test|vitest|jest|mocha|check-types|typecheck|build|gate)\b/.test(s)) return true
  if (/(^|[^a-z])(vitest|jest|mocha)([^a-z]|$)/.test(s)) return true
  if (/(^|[^a-z])gh\s+pr\s+(view|checks|status|list|watch)\b/.test(s)) return true
  return false
}

const READ_TOOLS = new Set(["read", "cat", "rg", "grep", "sed", "head", "tail", "less", "view", "readfile"])
const READ_COMMAND = /\b(cat|rg|grep|sed|head|tail|less|view)\b/

/**
 * The file a read-like call targeted, or `null`. Best-effort: an in-agent
 * `Read` call records no shell command (see tool-call-record.ts), so this
 * only resolves for shell-shaped reads (`cat`, `rg`, `sed`, …). Absence is
 * not an error — it just means this call contributes no read-target signal.
 */
export function readTargetOf(record) {
  const tool = String(record?.tool ?? "").toLowerCase()
  const command = str(record?.command)
  const args = Array.isArray(record?.args) ? record.args.map(String) : []
  const isRead = READ_TOOLS.has(tool) || (command !== undefined && READ_COMMAND.test(command))
  if (!isRead) return null
  const tokens = command !== undefined ? command.split(/\s+/) : args
  for (const raw of tokens) {
    const t = raw.replace(/^['"]|['"]$/g, "")
    if (!t || t.startsWith("-") || t.includes("=")) continue
    if (t.includes("/") || /\.(md|ts|tsx|js|mjs|cjs|json|txt|py|go|rs|sql|yml|yaml|toml)$/.test(t)) return t
  }
  return args[0] ?? null
}

function topEntry(counts) {
  let best = null
  for (const [key, n] of counts) if (best === null || n > best.count) best = { key, count: n }
  return best
}

/**
 * Detect a repetition loop from one session's recent tool calls. `looping`
 * when, inside `windowMs`:
 *   - the same call signature appears verbatim ≥ `verbatimMin`; OR
 *   - distinct/total < `ratioMax` over at least `ratioMinCalls` calls; OR
 *   - the same file is read ≥ `rereadMin` times.
 * Useful-loop command families are excluded from the counts first (see
 * {@link isUsefulLoopCommand}), so a watchdog poll or a test re-run never
 * trips it. Returns the stats either way, so the report can show its work.
 */
export function detectLoop(records, opts = {}) {
  const nowMs = opts.nowMs ?? 0
  const windowMs = opts.windowMs ?? LOOP_WINDOW_MS
  const verbatimMin = opts.verbatimMin ?? LOOP_VERBATIM_MIN
  const ratioMax = opts.ratioMax ?? LOOP_RATIO_MAX
  const ratioMinCalls = opts.ratioMinCalls ?? LOOP_RATIO_MIN_CALLS
  const rereadMin = opts.rereadMin ?? LOOP_REREAD_MIN

  const inWindow = (Array.isArray(records) ? records : []).filter((r) => {
    const ts = Date.parse(r?.ts)
    return Number.isFinite(ts) && ts <= nowMs + 1000 && nowMs - ts <= windowMs
  })
  const calls = inWindow.filter((r) => !isUsefulLoopCommand(callSignature(r)))
  const counts = new Map()
  const reads = new Map()
  for (const r of calls) {
    const sig = callSignature(r)
    counts.set(sig, (counts.get(sig) ?? 0) + 1)
    const target = readTargetOf(r)
    if (target) reads.set(target, (reads.get(target) ?? 0) + 1)
  }
  const total = calls.length
  const distinct = counts.size
  const ratio = total > 0 ? distinct / total : 1
  const maxVerbatim = topEntry(counts)?.count ?? 0
  const maxReads = topEntry(reads)?.count ?? 0
  const top = topEntry(counts)

  const reasons = []
  if (maxVerbatim >= verbatimMin) reasons.push(`same call verbatim x${maxVerbatim} in ${Math.round(windowMs / 60_000)}m`)
  if (total >= ratioMinCalls && ratio < ratioMax) reasons.push(`distinct/total ${distinct}/${total} < ${ratioMax}`)
  if (maxReads >= rereadMin) reasons.push(`same file read x${maxReads}`)

  return {
    looping: reasons.length > 0,
    reasons,
    stats: {
      windowMs,
      total,
      distinct,
      ratio: Math.round(ratio * 100) / 100,
      maxVerbatim,
      maxReads,
      usefulExcluded: inWindow.length - total,
      topCommand: top ? top.key : null,
      topCommandCount: top ? top.count : 0,
    },
  }
}

// ── stall (mission item 2) ───────────────────────────────────────────────

/** Busy this many minutes with no new activity is a stall. */
export const STALL_BUSY_MINUTES = 20
/** A turn error younger than this, on an idle process, is a stall. */
export const STALL_ERROR_RECENT_MINUTES = 30

/**
 * A stall is either (a) busy longer than {@link STALL_BUSY_MINUTES} with no
 * new activity, or (b) a recent `lastTurnErroredAt` on a process that is NOT
 * busy (the turn already ended in an error; a "continue" restarts it). The
 * proposed action is a single "continue" nudge — never a close.
 */
export function detectStall(input = {}) {
  const nowMs = input.nowMs ?? 0
  const busyMinutes = input.busyStallMinutes ?? STALL_BUSY_MINUTES
  const errorRecentMinutes = input.errorRecentMinutes ?? STALL_ERROR_RECENT_MINUTES
  const idle = typeof input.idleMinutes === "number" && Number.isFinite(input.idleMinutes) ? input.idleMinutes : undefined
  if (input.busy === true && idle !== undefined && idle > busyMinutes) {
    return { stalled: true, kind: "busy", reason: `busy ${Math.round(idle)}min > ${busyMinutes}min without new activity` }
  }
  const errTs = input.lastTurnErroredAt ? Date.parse(input.lastTurnErroredAt) : Number.NaN
  if (Number.isFinite(errTs)) {
    const ageMin = (nowMs - errTs) / 60_000
    if (ageMin >= 0 && ageMin <= errorRecentMinutes && input.busy !== true) {
      return { stalled: true, kind: "error", reason: `turn errored ${Math.round(ageMin)}min ago and process idle` }
    }
  }
  return { stalled: false, kind: null, reason: null }
}

// ── never-ran (mission item 3) ───────────────────────────────────────────

const minutesSince = (ts, nowMs) => {
  const ms = ts ? Date.parse(ts) : Number.NaN
  return Number.isFinite(ms) ? (nowMs - ms) / 60_000 : undefined
}

/**
 * A session that never actually ran: explicit 0 in AND 0 out. `undefined`
 * tokens (not reported) is NOT "never ran" — only a hard 0/0 is. A session
 * that is busy, still starting/provisioning, or has a prompt queued for its
 * first turn is merely young, not stuck. With `opts.nowMs`, the session must
 * also be at least `opts.idleMinutes` old (`startedAt`) AND idle
 * (`lastActivityAt`, else `startedAt`); an absent timestamp does not block.
 */
export function isNeverRan(session, opts = {}) {
  if (!(session?.tokensIn === 0 && session?.tokensOut === 0)) return false
  if (session.busy === true || session.status === "starting" || session.provisioning) return false
  if (Array.isArray(session.pendingPrompts) && session.pendingPrompts.length > 0) return false
  if (typeof opts.nowMs === "number") {
    const threshold = opts.idleMinutes ?? 0
    const age = minutesSince(session.startedAt, opts.nowMs)
    const idle = minutesSince(session.lastActivityAt ?? session.startedAt, opts.nowMs)
    if (age !== undefined && age < threshold) return false
    if (idle !== undefined && idle < threshold) return false
  }
  return true
}

// ── fast-path done (mission item 4) ──────────────────────────────────────

/** A tool-call record whose tool name is a `message_parent` call. */
export function isMessageParentCall(record) {
  const tool = String(record?.tool ?? "").toLowerCase()
  return tool.includes("message_parent")
}

/** A `message_parent` call carrying `kind: "done"` in any of the shapes a
 *  record can expose it (tool name, command, args, or an explicit `kind`). */
export function isDoneMessageParent(record) {
  if (!isMessageParentCall(record)) return false
  const blob = `${record?.kind ?? ""} ${record?.command ?? ""} ${Array.isArray(record?.args) ? record.args.join(" ") : ""}`.toLowerCase()
  return /(^|[^a-z])done([^a-z]|$)/.test(blob) || record?.kind === "done"
}

/** A call that commits or opens a PR — the second half of the done fast-path. */
export function isCommitOrPrCall(record) {
  if (record?.createdPrUrl || typeof record?.createdPrNumber === "number") return true
  const tool = String(record?.tool ?? "").toLowerCase()
  if (tool.includes("git_commit") || tool.includes("create_pull_request") || tool.includes("pr_create")) return true
  const command = String(record?.command ?? "").toLowerCase()
  return /\bgit\s+commit\b/.test(command) || /\bgh\s+pr\s+create\b/.test(command)
}

/**
 * The done fast-path: the last tool call is `message_parent(kind:done)` AND
 * the window shows a commit/PR (or the worktree/PR state or the derived
 * outcome already proves one). That is `done` without spending a judge.
 * Anything short of both halves returns `{ done: false }`.
 */
export function detectFastPathDone(input = {}) {
  const calls = Array.isArray(input.toolCalls) ? input.toolCalls : []
  const last = input.lastToolCall ?? (calls.length > 0 ? calls[calls.length - 1] : null)
  const doneMessage = isDoneMessageParent(last) || calls.some(isDoneMessageParent)
  if (!doneMessage) return { done: false, reason: "no message_parent(kind:done)" }
  const prState = input.worktree?.pr?.state
  const merged = prState === "merged" || prState === "MERGED"
  const opened = prState === "open" || prState === "OPEN"
  const outcomePrs = Array.isArray(input.outcome?.pullRequests) ? input.outcome.pullRequests.length : 0
  const hasCommitOrPr = calls.some(isCommitOrPrCall) || merged || opened || outcomePrs > 0
  if (!hasCommitOrPr) return { done: false, reason: "message_parent(kind:done) but no commit/PR" }
  return { done: true, reason: merged || outcomePrs > 0 ? "message_parent(kind:done) + merged/opened PR" : "message_parent(kind:done) + commit" }
}

// ── terminal sessions without an outcome (mission item 5) ────────────────

const TERMINAL_STATUSES = new Set(["killed", "exited", "error", "stopped", "completed", "failed"])

/** PR numbers a `session_list` row records: `openedPrs[].number` plus the
 *  `outcome.artifacts` `pr` entries (`#N` title or a `…/pull/N` ref). Sorted,
 *  de-duplicated. */
export function prNumbersOf(session) {
  const nums = new Set()
  for (const pr of Array.isArray(session?.openedPrs) ? session.openedPrs : []) {
    if (Number.isInteger(pr?.number)) nums.add(pr.number)
  }
  for (const a of Array.isArray(session?.outcome?.artifacts) ? session.outcome.artifacts : []) {
    if (a?.type !== "pr") continue
    const m = /#(\d+)$/.exec(String(a.title ?? "")) ?? /\/pull\/(\d+)/.exec(String(a.ref ?? ""))
    if (m) nums.add(Number(m[1]))
  }
  return [...nums].sort((a, b) => a - b)
}

const fmtPrs = nums => nums.map(n => `#${n}`).join(", ")
const isMergedState = state => state === "merged" || state === "MERGED"

/**
 * A terminal session that still carries no derived outcome and no wrapup
 * flag is a relabel CANDIDATE — visible instead of invisible, as the log
 * asks. The proposed verdict is `done` when the session's own record shows a
 * PR (merged, or merely opened — the PR is the hand-off), else `abandoned`.
 * `reason` carries the evidence (`PR #1738 merged`, `PRs #1738, #1740 opened`).
 */
export function terminalRelabelCandidate(session) {
  if (!TERMINAL_STATUSES.has(String(session?.status ?? ""))) return { candidate: false, reason: "not terminal" }
  if (session?.outcome?.verdict) return { candidate: false, reason: "outcome already recorded" }
  if (session?.wrapupFlag) return { candidate: false, reason: "already flagged" }
  const prs = prNumbersOf(session)
  const wt = session?.worktree?.pr
  if (isMergedState(wt?.state)) {
    const n = Number.isInteger(wt.number) ? [wt.number] : prs
    return { candidate: true, proposedVerdict: "done", reason: n.length > 0 ? `PR ${fmtPrs(n)} merged` : "PR merged", prs }
  }
  if (prs.length > 0) {
    return { candidate: true, proposedVerdict: "done", reason: `PR${prs.length > 1 ? "s" : ""} ${fmtPrs(prs)} opened`, prs }
  }
  return { candidate: true, proposedVerdict: "abandoned", reason: "terminal, no outcome recorded", prs }
}

/**
 * Sharpen one relabel proposal with its `session_evidence` answer: a merged
 * PR / merged worktree (`pullRequests.merged`, `worktree.pr.state`) →
 * `done` with `PR #N merged`; an open or recorded PR the list row did not
 * carry → `done`. Anything else leaves the proposal untouched.
 */
export function refineRelabel(item, evidence) {
  if (!evidence) return item
  const wt = evidence.worktree?.pr
  const state = wt?.state ?? evidence.pullRequests?.state ?? null
  const known = Array.isArray(item?.prs) ? item.prs : []
  const merged = isMergedState(state) || (evidence.pullRequests?.merged ?? 0) > 0
  if (merged) {
    const n = Number.isInteger(wt?.number) ? wt.number : known.length === 1 ? known[0] : undefined
    const others = known.filter(k => k !== n)
    const reason = (n !== undefined ? `PR #${n} merged` : "PR merged") + (others.length > 0 && n !== undefined ? `; also opened ${fmtPrs(others)}` : "")
    return { ...item, proposedVerdict: "done", reason }
  }
  if (item?.proposedVerdict === "done") return item
  if (state === "open" || state === "OPEN") {
    return { ...item, proposedVerdict: "done", reason: Number.isInteger(wt?.number) ? `PR #${wt.number} open` : "PR open" }
  }
  const opened = evidence.pullRequests?.opened ?? 0
  if (opened > 0) return { ...item, proposedVerdict: "done", reason: `${opened} PR${opened > 1 ? "s" : ""} opened` }
  return item
}

// ── self-exclusion (mission item 7) ──────────────────────────────────────

/** Two origins name the same cron job (`cron:<jobId>`). */
export function sameCronJob(origin, otherOrigin) {
  return isNonEmptyString(origin) && origin === otherOrigin && origin.startsWith("cron:")
}

/**
 * Whether a candidate is the steward's OWN cron lineage and must never be
 * judged as user work: the caller itself, or an older run of the same cron
 * job (`origin === callerOrigin`, both `cron:<jobId>`). A finished cron run
 * closes itself, or is a certain close — never a judge candidate.
 */
export function isSelfExcluded(session, opts = {}) {
  if (!session) return { excluded: true, reason: "no session" }
  if (opts.callerSessionId && session.id === opts.callerSessionId) return { excluded: true, reason: "caller session" }
  if (sameCronJob(session.origin, opts.callerOrigin)) return { excluded: true, reason: "same cron job as caller" }
  return { excluded: false, reason: null }
}

// ── re-check at apply time (mission item 6) ──────────────────────────────

/**
 * Re-read a candidate's live state right before acting. If it became busy,
 * or is no longer running/starting, SKIP — the snapshot it was planned from
 * is stale. `live` is a fresh `session_list` row (or `{status,busy}`).
 */
export function recheckApply(_entry, live) {
  if (!live) return { proceed: false, reason: "session disappeared before apply" }
  if (live.busy === true) return { proceed: false, reason: "became busy before apply" }
  if (live.status !== "running" && live.status !== "starting") {
    return { proceed: false, reason: `terminal before apply (${live.status})` }
  }
  return { proceed: true, reason: null }
}

// ── verdict memory (mission item 10) ─────────────────────────────────────

/** A short, stable fingerprint of the decision-relevant evidence — NOT the
 *  transcript text, which changes on every turn. Two passes with the same
 *  fingerprint reached the same verdict on unchanged evidence. */
export function evidenceFingerprint(evidence) {
  const pick = {
    status: evidence?.status ?? null,
    busy: evidence?.busy === true,
    awaitingInput: evidence?.awaitingInput === true,
    keepAlive: evidence?.keepAlive === true,
    turnsCompleted: evidence?.turnsCompleted ?? null,
    tokensIn: evidence?.tokensIn ?? null,
    tokensOut: evidence?.tokensOut ?? null,
    lastToolCall: evidence?.lastToolCall?.tool ?? null,
    toolTotal: evidence?.toolStats?.total ?? null,
    toolDistinct: evidence?.toolStats?.distinct ?? null,
    pr: evidence?.worktree?.pr?.state ?? null,
    lastTurnError: evidence?.lastTurnError ?? null,
    liveChildren: evidence?.liveChildren ?? null,
    continuedTo: evidence?.continuedTo ?? null,
    outcome: evidence?.outcome?.verdict ?? null,
  }
  return JSON.stringify(pick)
}

/**
 * Fold `app_state` `note` events of payload `kind:"steward-verdict"` into a
 * per-session memory: the last verdict, its fingerprint, and how many
 * consecutive passes agreed on the same (verdict, fingerprint). `streak`
 * resets the moment either changes.
 */
export function foldVerdictMemory(events) {
  const memory = new Map()
  for (const e of Array.isArray(events) ? events : []) {
    const p = e?.payload
    if (e?.kind !== "note" || p?.kind !== "steward-verdict" || !isNonEmptyString(p.sessionId)) continue
    const prev = memory.get(p.sessionId)
    const streak = prev && prev.verdict === p.verdict && prev.fingerprint === p.fingerprint ? prev.streak + 1 : 1
    memory.set(p.sessionId, {
      verdict: p.verdict,
      confidence: typeof p.confidence === "number" ? p.confidence : null,
      fingerprint: p.fingerprint ?? null,
      streak,
      ts: e.ts ?? null,
      judgedBy: p.judgedBy ?? null,
    })
  }
  return memory
}

/**
 * Cache decision: a session already judged the SAME verdict on the SAME
 * evidence fingerprint for at least `stablePasses` consecutive passes is not
 * re-judged. Any evidence change (fingerprint differs) re-opens it.
 */
export function shouldRejudge(memory, sessionId, fingerprint, opts = {}) {
  const stablePasses = opts.stablePasses ?? 2
  const m = memory instanceof Map ? memory.get(sessionId) : memory?.[sessionId]
  if (!m) return { rejudge: true, cached: null }
  if (m.fingerprint !== fingerprint) return { rejudge: true, cached: null }
  if ((m.streak ?? 0) >= stablePasses) return { rejudge: false, cached: m }
  return { rejudge: true, cached: null }
}

/** The `app_state` event to append for one recorded verdict. */
export function verdictMemoryEvent(input = {}) {
  const payload = {
    kind: "steward-verdict",
    sessionId: input.sessionId,
    verdict: input.verdict,
    confidence: input.confidence ?? null,
    fingerprint: input.fingerprint ?? null,
    ...(input.judgedBy ? { judgedBy: input.judgedBy } : {}),
    ...(input.note ? { note: input.note } : {}),
  }
  return {
    kind: "note",
    by: "policy",
    stage: "session-steward",
    item: input.sessionId,
    payload,
  }
}

/**
 * An operator disagreement with a recorded verdict — logged as a Jev example
 * (mission item 10: "les désaccords opérateur sont journalisés comme
 * exemples"). Returns `null` when the operator agrees (or there is no prior).
 */
export function operatorDisagreement(memory, sessionId, operatorVerdict, opts = {}) {
  const m = memory instanceof Map ? memory.get(sessionId) : memory?.[sessionId]
  if (!m || !operatorVerdict || m.verdict === operatorVerdict) return null
  return {
    sessionId,
    judgeVerdict: m.verdict,
    judgeConfidence: m.confidence,
    operatorVerdict,
    fingerprint: m.fingerprint,
    ...(opts.at ? { at: opts.at } : {}),
  }
}

// ── host saturation (mission item 9) ─────────────────────────────────────

/** Load / core ratio above which the host counts as saturated. */
export const SATURATION_LOAD_PER_CORE = 4
/** Swap used above this percent counts as saturated. */
export const SATURATION_SWAP_PERCENT = 50
/** Available RAM below this percent of total counts as saturated. */
export const SATURATION_FREE_PERCENT = 15

/**
 * Is the host saturated, by the same thresholds `host_load`'s own warnings
 * use? Returns the reasons so the report can say why.
 */
export function hostSaturation(hostLoad) {
  if (!hostLoad) return { critical: false, reasons: [] }
  const reasons = []
  const perCore = typeof hostLoad.loadPerCore === "number" ? hostLoad.loadPerCore : null
  if (perCore !== null && perCore > SATURATION_LOAD_PER_CORE) {
    reasons.push(`load ${hostLoad.loadAvg?.[0]?.toFixed?.(1) ?? "?"} = ${perCore}x cores (> ${SATURATION_LOAD_PER_CORE}x)`)
  }
  const swapPct = hostLoad.swap?.percent
  if (typeof swapPct === "number" && swapPct > SATURATION_SWAP_PERCENT) reasons.push(`swap ${Math.round(swapPct)}% used`)
  const mem = hostLoad.memory
  if (mem && typeof mem.totalBytes === "number" && mem.totalBytes > 0) {
    const availPct = ((mem.availableBytes ?? mem.freeBytes ?? 0) / mem.totalBytes) * 100
    if (availPct < SATURATION_FREE_PERCENT) reasons.push(`RAM available ${availPct.toFixed(1)}% (< ${SATURATION_FREE_PERCENT}%)`)
  }
  return { critical: reasons.length > 0, reasons }
}

const fmtBytes = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?"
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** Processes the log wants surfaced under saturation: reparented orphans,
 *  then big processes that are NOT owned by a session (acting on sessions
 *  alone fixes nothing). Report-only — no process is ever touched here. */
export function saturationHeader(hostLoad) {
  if (!hostLoad) return []
  const { critical, reasons } = hostSaturation(hostLoad)
  if (!critical) return []
  const lines = [`## ⚠ Host saturated — orphans & non-session processes first (report only)`, ""]
  lines.push(`- ${reasons.join(" · ")}`)
  const proc = (p) => `pid ${p.pid} ${p.command} (${fmtBytes(p.memoryBytes ?? p.rssBytes)}${p.elapsedSec ? `, ${Math.round(p.elapsedSec / 3600)}h` : ""})`
  const orphans = (hostLoad.processes ?? hostLoad.topByMemory ?? []).filter((p) => p?.owner?.kind === "orphan")
  const others = (hostLoad.processes ?? hostLoad.topByMemory ?? []).filter(
    (p) => p?.owner?.kind === "other" || p?.owner?.kind === "system" || p?.owner?.kind === "provisioning",
  )
  if (orphans.length > 0) lines.push(`- orphans: ${orphans.slice(0, 5).map(proc).join("; ")}`)
  if (others.length > 0) lines.push(`- big non-session: ${others.slice(0, 5).map(proc).join("; ")}`)
  const criticalWarnings = (hostLoad.warnings ?? []).filter((w) => w?.severity === "critical")
  if (criticalWarnings.length > 0) lines.push(`- warnings: ${criticalWarnings.map((w) => w.message).join("; ")}`)
  lines.push("")
  return lines
}

// ── explicit 0-candidate report (mission item 8) ─────────────────────────

/**
 * Why there is nothing to do, stated explicitly instead of an empty report:
 * how many live sessions were seen, how many were busy, how many were
 * terminal (and whether any still need a relabel), and how many were
 * excluded (self / same cron job / pinned / pty / keepAlive).
 */
export function explainZeroCandidates(counts = {}) {
  const n = (v) => (typeof v === "number" ? v : 0)
  return (
    `0 candidates: ${n(counts.live)} live (` +
    `${n(counts.busy)} busy, ${n(counts.idle)} idle), ` +
    `${n(counts.terminal)} terminal (${n(counts.terminalRelabel)} need a relabel), ` +
    `${n(counts.excluded)} excluded (self/cron/pinned/pty/keepAlive)`
  )
}

/** Nothing idle AND nothing terminal-without-outcome ⇒ a full workflow is
 *  not worth it; the caller can report and stop. */
export function shouldFastPath(scan = {}) {
  const busy = (scan.busy ?? []).length
  const idle = (scan.idle ?? []).length
  const terminalRelabel = (scan.terminalRelabel ?? []).length
  const neverRan = (scan.neverRan ?? []).length
  const anyIdleCandidate = idle > 0 || neverRan > 0 || terminalRelabel > 0
  return { fastPath: !anyIdleCandidate && busy > 0, anyIdleCandidate }
}

// ── proposals (mission items 1, 2) ───────────────────────────────────────

export const NUDGE_INTERRUPT = "interrupt"
export const NUDGE_CONTINUE = "continue"

/**
 * Merge loop and stall findings into at most ONE nudge proposal per session
 * per pass (interrupt wins over continue: a loop is more specific). A
 * user-origin session is NEVER proposed for a nudge — it is reported as
 * observed-only, so a human stays in the loop. Never proposes a close.
 */
export function buildProposals(input = {}) {
  const bySession = new Map()
  const consider = (id, kind, reason, originClass) => {
    if (!id) return
    const existing = bySession.get(id)
    if (existing) {
      if (existing.kind === NUDGE_INTERRUPT) return
      if (kind !== NUDGE_INTERRUPT) return
    }
    bySession.set(id, { sessionId: id, kind, reason, originClass })
  }
  for (const r of input.loopResults ?? []) {
    if (r?.looping) consider(r.sessionId, NUDGE_INTERRUPT, `loop: ${(r.reasons ?? []).join("; ")}`, r.originClass)
  }
  for (const r of input.stallResults ?? []) {
    if (r?.stalled) consider(r.sessionId, NUDGE_CONTINUE, `stall: ${r.reason}`, r.originClass)
  }
  const proposals = []
  const observed = []
  for (const p of bySession.values()) {
    if (p.originClass === "user") observed.push({ ...p, suppressed: "origine utilisateur" })
    else proposals.push(p)
  }
  return { proposals, observed }
}
