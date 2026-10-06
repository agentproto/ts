// Runtime source of truth for WORKFLOW.md's step graph (the same pattern as
// repo-maintenance's `maintain/entry.mjs`) — the frontmatter mirrors this by
// id+kind for governance (`reconcileEntry` only checks the top-level id/kind
// sequence, never nested step bodies).
//
// Entry-based because every decision between the tool calls is a real
// function: splitting the plan, capping/ordering judge candidates, parsing the
// judge's JSON strictly, thresholding on `minConfidence`, and the report. The
// declarative manifest has no expression language for `compute`.
//
// Safety model: every mutation goes through `session_wrapup_apply`, which
// RE-CLASSIFIES each id itself immediately before acting and refuses
// `keep`-class ids outright. On top of that, this workflow:
//   - mutates no SESSION unless `apply` is true (every session-mutating map
//     runs over an empty list otherwise). The one dry-run write is the
//     append-only verdict-memory ledger (`app_state_append`) — never a
//     session, and disableable with `appId: ""`;
//   - only ever feeds `close`/`stuck` ids to the rules pass — a `keepAlive`
//     session can only ever be `judge` class, so rules never close it;
//   - drops the caller's own session from every candidate list;
//   - treats a malformed judge reply as `active` with confidence 0 (never
//     acted on);
//   - PROPOSES loop/stall nudges in the report only — never sends one, never
//     closes a `looping` session.
//
// The mechanical rules themselves live in `cron-rules.mjs` (pure, unit
// tested): loop detection, stall, never-ran, fast-path done, terminal
// relabel, self-exclusion, re-check, host saturation, and the verdict-memory
// fold. This file wires them over `session_list` / `tool_calls_list` /
// `host_load` / `app_state`.

import {
  classifyOrigin,
  decideAction,
  resolveOriginPolicy,
  DEFAULT_CLOSABLE_ORIGINS,
  DEFAULT_USER_ORIGINS,
} from "./origin-policy.mjs"
import {
  buildProposals,
  detectLoop,
  detectStall,
  evidenceFingerprint,
  explainZeroCandidates,
  foldVerdictMemory,
  isNeverRan,
  isSelfExcluded,
  saturationHeader,
  shouldRejudge,
  terminalRelabelCandidate,
  verdictMemoryEvent,
  NUDGE_CONTINUE,
  NUDGE_INTERRUPT,
} from "./cron-rules.mjs"

const DEFAULT_IDLE_MINUTES = 30
const DEFAULT_MIN_CONFIDENCE = 0.8
/** How many consecutive passes on an unchanged fingerprint before the judge
 *  cache stops re-judging a session. */
const DEFAULT_STABLE_VERDICT_PASSES = 2
/** The installed app whose `app_state` ledger holds the verdict memory. */
const DEFAULT_APP_ID = "session-steward"
// The agent judge's model is the `judge.session` model ROLE, resolved at run
// time by the `modelRoles` step (the daemon's `model_roles` tool): explicit
// `judgeModel` input > repo agentproto.json `models` > daemon config `models`
// > built-in default (packages/runtime/src/model-roles.ts). No model id here.
const ROLE_JUDGE_SESSION = "judge.session"
const DEFAULT_MAX_JUDGED = 15
const DEFAULT_JEV_MODEL = "jev-latest"
const JUDGE_BACKENDS = ["auto", "jev", "agent"]
/** Evidence JSON cap per session, in characters. */
const EVIDENCE_MAX_CHARS = 5_000
/** `ask`: 4 × 45 s long-polls ≈ 3 min bounded wait for the session's reply. */
const ASK_WAIT_POLLS = 4
const ASK_POLL_MS = 45_000

const JUDGE_REF = "@agentproto/session-steward-judge"
const VERDICTS = ["done", "abandoned", "blocked", "needs-input", "active"]

export const ASK_PROMPT =
  "Steward check: is your task complete? Reply exactly `STEWARD: DONE <one line>` " +
  "or `STEWARD: NOT-DONE <one line>`."

// ── settings ─────────────────────────────────────────────────────────────

function num(v, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback
}

/** An explicit input model, else the `modelRoles` step's resolution of `role`;
 *  undefined leaves the judge agent's own AGENT.md `model` in charge. */
function explicitOrRole(explicit, modelRoles, role) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim()
  const resolved = modelRoles?.models?.[role]
  return typeof resolved === "string" && resolved ? resolved : undefined
}

/** Every input with its default applied — steps read `$steps.settings.*`,
 *  never a raw `$input.*` that may be absent. */
export function resolveSettings(input, modelRoles) {
  const i = input ?? {}
  const originPolicy = resolveOriginPolicy({ userOrigins: i.userOrigins, closableOrigins: i.closableOrigins })
  return {
    idleMinutes: Math.floor(num(i.idleMinutes, DEFAULT_IDLE_MINUTES, { min: 1 })),
    apply: i.apply === true,
    minConfidence: num(i.minConfidence, DEFAULT_MIN_CONFIDENCE, { max: 1 }),
    judgeModel: explicitOrRole(i.judgeModel, modelRoles, ROLE_JUDGE_SESSION),
    judge: JUDGE_BACKENDS.includes(i.judge) ? i.judge : "auto",
    jevModel: typeof i.jevModel === "string" && i.jevModel.trim() ? i.jevModel.trim() : DEFAULT_JEV_MODEL,
    maxJudged: Math.floor(num(i.maxJudged, DEFAULT_MAX_JUDGED)),
    askSessions: i.askSessions === true,
    callerSessionId: typeof i.callerSessionId === "string" && i.callerSessionId ? i.callerSessionId : null,
    callerOrigin: typeof i.callerOrigin === "string" && i.callerOrigin ? i.callerOrigin : null,
    appId: typeof i.appId === "string" && i.appId.trim() ? i.appId.trim() : DEFAULT_APP_ID,
    stableVerdictPasses: Math.floor(num(i.stableVerdictPasses, DEFAULT_STABLE_VERDICT_PASSES, { min: 1 })),
    userOrigins: originPolicy.userOrigins,
    closableOrigins: originPolicy.closableOrigins,
  }
}

/** The origin policy a settings object carries, as `decideAction` wants it. */
function policyOf(settings) {
  return { userOrigins: settings?.userOrigins, closableOrigins: settings?.closableOrigins }
}

/** `decideAction` over one candidate entry, with the run's policy folded in.
 *  Used by both the apply-queue builders and the report, so the action shown
 *  and the action executed can never drift. */
export function decideFor(entry, planClass, verdict, confidence, settings) {
  return decideAction({
    session: entry,
    planClass,
    verdict,
    confidence,
    apply: settings?.apply === true,
    policy: policyOf(settings),
    minConfidence: settings?.minConfidence,
  })
}

// ── plan → candidates ────────────────────────────────────────────────────

/** Split `session_wrapup_plan`'s entries into this run's work lists. `keep`
 *  entries (only present if the plan was asked for them) and the caller's own
 *  session are dropped here, whatever the plan said. `judge` is ordered most
 *  RAM first and capped at `maxJudged`; the rest are counted as overflow. */
export function splitCandidates(planResult, settings) {
  const entries = Array.isArray(planResult?.entries) ? planResult.entries : []
  const self = settings?.callerSessionId ?? null
  const usable = entries.filter(e => e && typeof e.sessionId === "string" && e.class !== "keep" && e.sessionId !== self)
  const byClass = cls => usable.filter(e => e.class === cls)
  const judgeAll = byClass("judge").sort((a, b) => (b.rssBytes ?? 0) - (a.rssBytes ?? 0))
  const cap = settings?.maxJudged ?? DEFAULT_MAX_JUDGED
  return {
    close: byClass("close"),
    stuck: byClass("stuck"),
    judge: judgeAll.slice(0, cap),
    judgeOverflow: judgeAll.slice(cap),
    keepSkipped: entries.filter(e => e?.class === "keep").length,
    selfExcluded: self !== null && entries.some(e => e?.sessionId === self),
  }
}

/** Rules pass: `close` → done, `stuck` → abandoned — only when `apply`, and
 *  bounded by origin. A user-origin candidate is never closed: it is queued
 *  as a `needs-input` FLAG instead, with the "origine utilisateur" reason. */
export function buildRuleApplyQueue(candidates, settings) {
  if (!settings?.apply) return []
  const queue = []
  const push = (entries, planClass, closeVerdict, closeNote) => {
    for (const e of entries ?? []) {
      const d = decideFor(e, planClass, closeVerdict, 1, settings)
      if (d.action === "skip") continue
      queue.push({
        sessionId: e.sessionId,
        verdict: d.action === "close" ? closeVerdict : "needs-input",
        note: d.action === "close" ? closeNote(e) : d.reason,
      })
    }
  }
  push(candidates?.close, "close", "done", e => `steward-rules: ${(e.reasons ?? []).join("; ") || "close class"}`)
  push(candidates?.stuck, "stuck", "abandoned", () => "stuck starting, never ran")
  return queue
}

// ── evidence ─────────────────────────────────────────────────────────────

function mb(bytes) {
  return typeof bytes === "number" ? Math.round(bytes / (1024 * 1024)) : undefined
}

function cut(text, max) {
  if (typeof text !== "string") return undefined
  const t = text.trim()
  return t.length <= max ? t : `…${t.slice(t.length - (max - 1))}`
}

/** Plan entry + `session_evidence` → the compact object the judge sees,
 *  under {@link EVIDENCE_MAX_CHARS} once serialized (oldest turns dropped
 *  first, then the tail signal shortened). `memory` (a folded verdict map
 *  from `app_state`, optional) adds the previous verdict for this session.
 *  Every field added by the PR-3 enrichment is copied through only when the
 *  `session_evidence` tool supplied it — an old daemon still yields the old
 *  shape. */
export function composeEvidence(entry, raw, memory) {
  const signals = entry?.signals ?? {}
  const previous = memory instanceof Map ? memory.get(entry.sessionId) : memory?.[entry?.sessionId]
  const evidence = {
    sessionId: entry.sessionId,
    label: raw?.label ?? entry.label,
    cwd: raw?.cwd,
    adapter: raw?.adapter,
    idleMinutes: entry.idleMinutes,
    keepAlive: raw?.keepAlive === true,
    awaitingInput: raw?.awaitingInput === true,
    busy: raw?.busy === true,
    rssMB: mb(entry.rssBytes),
    planReasons: entry.reasons ?? [],
    origin: raw?.origin ?? entry.origin,
    parentSessionId: raw?.parentSessionId ?? entry.parentSessionId,
    signals: {
      lastAssistantTail: cut(signals.lastAssistantTail, 800),
      pendingToolCall: signals.pendingToolCall === true,
      parentEnded: signals.parentEnded === true,
      worktreeMerged: signals.worktreeMerged === true,
    },
    worktree: raw?.worktree ?? null,
    turns: Array.isArray(raw?.turns) ? [...raw.turns] : [],
    ...(raw?.liveChildren !== undefined ? { liveChildren: raw.liveChildren } : {}),
    ...(raw?.continuedFrom ? { continuedFrom: raw.continuedFrom } : {}),
    ...(raw?.continuedTo ? { continuedTo: raw.continuedTo } : {}),
    ...(raw?.tokensIn !== undefined ? { tokensIn: raw.tokensIn } : {}),
    ...(raw?.tokensOut !== undefined ? { tokensOut: raw.tokensOut } : {}),
    ...(raw?.lastTurnErroredAt ? { lastTurnErroredAt: raw.lastTurnErroredAt } : {}),
    ...(raw?.lastTurnError ? { lastTurnError: raw.lastTurnError } : {}),
    ...(raw?.outcome ? { outcome: raw.outcome } : {}),
    ...(raw?.pullRequests ? { pullRequests: raw.pullRequests } : {}),
    ...(raw?.toolStats ? { toolStats: raw.toolStats } : {}),
    ...(raw?.lastToolCall ? { lastToolCall: raw.lastToolCall } : {}),
    ...(raw?.minutesSinceUserMessage !== undefined ? { minutesSinceUserMessage: raw.minutesSinceUserMessage } : {}),
    ...(raw?.minutesSinceAgentMessage !== undefined ? { minutesSinceAgentMessage: raw.minutesSinceAgentMessage } : {}),
    ...(previous
      ? { previousVerdict: { verdict: previous.verdict, confidence: previous.confidence ?? null, streak: previous.streak ?? 1, ts: previous.ts ?? null } }
      : {}),
  }
  while (JSON.stringify(evidence).length > EVIDENCE_MAX_CHARS && evidence.turns.length > 0) evidence.turns.shift()
  if (JSON.stringify(evidence).length > EVIDENCE_MAX_CHARS) evidence.signals.lastAssistantTail = cut(evidence.signals.lastAssistantTail, 200)
  return evidence
}

export function buildJudgePrompt(evidence) {
  return (
    "You are the session steward's judge. Decide whether ONE idle AI coding-agent session " +
    "is finished, from the evidence below. Do NOT call any tool — answer from the evidence alone.\n\n" +
    "Verdicts (concrete signals — see the evidence fields named in each):\n" +
    "- `done`: finished with nothing pending — `pullRequests.merged` > 0 or " +
    "`worktree.pr.state`=\"merged\"; or `pullRequests.opened` > 0 with a final report and no " +
    "open question; or the last tool call is a `message_parent` with `kind:\"done\"`; or " +
    "`outcome.verdict`=\"done\"; or the user's last message is an acknowledgement with no " +
    "pending question.\n" +
    "- `abandoned`: superseded or a dead end — `outcome.verdict`=\"abandoned\"/\"failed\", or " +
    "the worktree is gone/merged elsewhere with no open PR and no pending question.\n" +
    "- `blocked`: waiting on something EXTERNAL — an open PR with CI/review pending, " +
    "`liveChildren` > 0, or a `lastTurnError` that clears on its own.\n" +
    "- `needs-input`: waiting on a HUMAN — `awaitingInput` true, or the LAST assistant turn " +
    "ends in a question to the user/operator.\n" +
    "- `active`: mid-work — `busy`, a progress update with no conclusion, recent distinct " +
    "`toolStats`, or an unchanged `previousVerdict` of active.\n" +
    "When the evidence is thin or ambiguous, say `active` with a LOW confidence. Closing a " +
    "session that still had work is worse than leaving an idle one open.\n\n" +
    "Reply with ONLY one JSON object, no prose, no code fence:\n" +
    `{"sessionId": "${evidence.sessionId}", "verdict": "done"|"abandoned"|"blocked"|"needs-input"|"active", ` +
    '"confidence": <number 0..1>, "reason": "<one line>"}\n\n' +
    `Evidence:\n${JSON.stringify(evidence)}`
  )
}

/** Fold one evidence map item: the `session_evidence` answer read off the
 *  step slot this item's tool step just wrote. The id check guards against
 *  ever pairing one session's evidence with another's plan entry. */
function foldEvidence(b) {
  const raw = b.steps.evidenceOne
  if (!raw || raw.sessionId !== b.item?.sessionId) {
    throw new Error(`session_evidence answered for '${raw?.sessionId}', expected '${b.item?.sessionId}'`)
  }
  const evidence = composeEvidence(b.item, raw, b.steps.memory)
  return { entry: b.item, evidence, judgePrompt: buildJudgePrompt(evidence) }
}

/** Items of a tolerant (`onError: collect`) map, split by outcome. */
function settled(mapResult) {
  if (Array.isArray(mapResult)) return { ok: mapResult.map((value, index) => ({ index, value })), failed: [] }
  const results = Array.isArray(mapResult?.results) ? mapResult.results : []
  return {
    ok: results.filter(r => r?.status === "fulfilled").map(r => ({ index: r.index, value: r.value })),
    failed: results.filter(r => r && r.status !== "fulfilled"),
  }
}

// ── judge ────────────────────────────────────────────────────────────────

/** Strict parse of the judge's reply. ANYTHING off — not a lone JSON object,
 *  wrong/missing sessionId, unknown verdict, confidence outside 0..1, no
 *  reason — is `active` with confidence 0, which is never acted on. */
export function parseJudgeVerdict(text, sessionId) {
  const malformed = why => ({ verdict: "active", confidence: 0, reason: `malformed judge reply: ${why}`, malformed: true })
  if (typeof text !== "string" || !text.trim()) return malformed("empty")
  let body = text.trim()
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fence) body = fence[1].trim()
  if (!body.startsWith("{") || !body.endsWith("}")) return malformed("not a lone JSON object")
  let v
  try {
    v = JSON.parse(body)
  } catch {
    return malformed("invalid JSON")
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return malformed("not an object")
  if (v.sessionId !== sessionId) return malformed("sessionId mismatch")
  if (!VERDICTS.includes(v.verdict)) return malformed("unknown verdict")
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) {
    return malformed("confidence not a number in 0..1")
  }
  if (typeof v.reason !== "string" || !v.reason.trim()) return malformed("no reason")
  return { verdict: v.verdict, confidence: v.confidence, reason: v.reason.trim().split("\n")[0].slice(0, 300) }
}

/** Jev answers (`session_judge_jev`) by session id — only the items whose
 *  map step ran AND answered for the session it was asked about. */
function jevAnswers(jevResult, jevQueue) {
  const out = new Map()
  const { ok, failed } = settled(jevResult)
  for (const { index, value } of ok) {
    const q = (jevQueue ?? [])[index]
    if (q && value?.sessionId === q.entry.sessionId) out.set(q.entry.sessionId, value)
  }
  for (const f of failed) {
    const q = (jevQueue ?? [])[f.index]
    if (q) out.set(q.entry.sessionId, { ok: false, sessionId: q.entry.sessionId, error: f.error ?? f.status })
  }
  return out
}

/** Candidates the agent judge takes: all of them with `judge: "agent"`,
 *  else those Jev didn't answer. `jevFallback` records why — except `auto`
 *  with no key, which is simply the agent backend, not a failure. */
export function buildAgentJudgeQueue(judgeQueue, jevQueue, jevResult, settings) {
  if (settings?.judge === "agent") return [...(judgeQueue ?? [])]
  const answers = jevAnswers(jevResult, jevQueue)
  const out = []
  for (const q of judgeQueue ?? []) {
    const a = answers.get(q.entry.sessionId)
    if (a?.ok === true) continue
    const quietNoKey = settings?.judge === "auto" && a?.noKey === true
    out.push({ ...q, ...(quietNoKey ? {} : { jevFallback: a?.error ?? "no Jev answer" }) })
  }
  return out
}

function formatProbabilities(p) {
  return Object.entries(p ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
    .join(" ")
}

/** One row per judged candidate: Jev's answer, else the agent judge's
 *  parsed verdict, else `active`/0 when its turn failed outright.
 *  Candidates whose evidence failed are rows too (never judged, never acted
 *  on). */
export function collectVerdicts(evidenceResult, judgeQueue, jevResult, jevQueue, agentJudgeQueue, judgeResult) {
  const rows = []
  const ev = settled(evidenceResult)
  for (const f of ev.failed) {
    const entry = f.item ?? {}
    rows.push({ entry, evidence: null, verdict: "active", confidence: 0, reason: `evidence failed: ${f.error ?? f.status}`, source: "none" })
  }
  const jev = jevAnswers(jevResult, jevQueue)
  const agent = new Map()
  const judged = settled(judgeResult)
  const failedByIndex = new Map(judged.failed.map(r => [r.index, r]))
  ;(agentJudgeQueue ?? []).forEach((q, index) => {
    const v = judged.ok.find(r => r.index === index)?.value
    if (v && v.sessionId === q.entry.sessionId) {
      agent.set(q.entry.sessionId, { ...v, source: "judged" })
    } else {
      const f = failedByIndex.get(index)
      agent.set(q.entry.sessionId, {
        verdict: "active",
        confidence: 0,
        reason: f ? `judge failed: ${f.error ?? f.status}` : "judge produced no verdict",
        source: "none",
      })
    }
    if (q.jevFallback) agent.get(q.entry.sessionId).jevFallback = q.jevFallback
  })
  for (const q of judgeQueue ?? []) {
    const id = q.entry.sessionId
    const j = jev.get(id)
    if (j?.ok === true) {
      rows.push({
        entry: q.entry,
        evidence: q.evidence,
        verdict: j.verdict,
        confidence: j.confidence,
        reason: `jev ${j.verdict} — p: ${formatProbabilities(j.probabilities)}`,
        probabilities: j.probabilities,
        source: "jev",
        judgedBy: `jev:${j.model}`,
      })
      continue
    }
    const a = agent.get(id) ?? { verdict: "active", confidence: 0, reason: "not judged", source: "none" }
    rows.push({ entry: q.entry, evidence: q.evidence, ...a })
  }
  return rows
}

// ── ask (opt-in) ─────────────────────────────────────────────────────────

/** Sessions to ask directly: judged below `minConfidence`, and idle, not
 *  keepAlive, not awaitingInput — only when `askSessions`. */
export function buildAskQueue(verdicts, settings) {
  if (!settings?.askSessions) return []
  return (verdicts ?? [])
    .filter(
      r =>
        r.evidence &&
        r.confidence < settings.minConfidence &&
        r.evidence.keepAlive !== true &&
        r.evidence.awaitingInput !== true &&
        r.evidence.busy !== true,
    )
    .map(r => ({ sessionId: r.entry.sessionId }))
}

/** `STEWARD: DONE <line>` / `STEWARD: NOT-DONE <line>` in the session's
 *  newest assistant turn. Anything else ⇒ `null` (no declaration). */
export function parseStewardReply(text) {
  if (typeof text !== "string") return null
  const lines = text.split("\n").map(l => l.trim().replace(/^`+|`+$/g, ""))
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^STEWARD:\s*(DONE|NOT-DONE)\b\s*(.*)$/)
    if (m) return { declared: m[1] === "DONE" ? "done" : "not-done", line: m[2].trim().slice(0, 300) }
  }
  return null
}

function lastAssistantText(evidence) {
  const turns = Array.isArray(evidence?.turns) ? evidence.turns : []
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]?.role === "assistant") return turns[i].text
  return undefined
}

/** Merge the `ask` answers into the verdict rows: a declared DONE becomes a
 *  `done` verdict at confidence 1 (`source: "declared"`); a NOT-DONE becomes
 *  `active` at confidence 1 (keep). No/unparseable reply ⇒ row unchanged. */
export function mergeDeclared(verdicts, askQueue, askResult) {
  const answers = new Map()
  const ok = settled(askResult).ok
  for (const { index, value } of ok) {
    const q = (askQueue ?? [])[index]
    if (q && value?.sessionId === q.sessionId && value.declared) answers.set(q.sessionId, value)
  }
  return (verdicts ?? []).map(r => {
    const a = answers.get(r.entry.sessionId)
    if (!a) return r
    return {
      ...r,
      verdict: a.declared === "done" ? "done" : "active",
      confidence: 1,
      reason: `self-declared ${a.declared.toUpperCase()}: ${a.line || "(no detail)"}`,
      source: "declared",
      judgeVerdict: { verdict: r.verdict, confidence: r.confidence, reason: r.reason },
    }
  })
}

// ── judged apply ─────────────────────────────────────────────────────────

/** `done`/`abandoned` (close) and `blocked`/`needs-input` (flag) at or above
 *  `minConfidence` — only when `apply`, and bounded by origin: a user-origin
 *  candidate is downgraded to a `needs-input` FLAG, never a close. A malformed
 *  reply is `active`/0 and can never qualify. */
export function buildJudgedApplyQueue(finalVerdicts, settings) {
  if (!settings?.apply) return []
  const queue = []
  for (const r of finalVerdicts ?? []) {
    if (r.malformed) continue
    const d = decideFor(r.entry, "judge", r.verdict, r.confidence, settings)
    if (d.action === "skip") continue
    const isFlagVerdict = r.verdict === "blocked" || r.verdict === "needs-input"
    queue.push({
      sessionId: r.entry.sessionId,
      verdict: d.action === "close" ? r.verdict : isFlagVerdict ? r.verdict : "needs-input",
      judgedBy: r.source === "declared" ? `steward-ask:${r.entry.sessionId}` : r.judgedBy ?? r.judgeSessionId ?? "steward-judge",
      note: d.action === "close" ? r.reason : `${d.reason}${r.reason ? ` — ${r.reason}` : ""}`,
    })
  }
  return queue
}

// ── report ───────────────────────────────────────────────────────────────

/** Per-session `session_wrapup_apply` results across both apply passes. */
export function collectApplyResults(...mapResults) {
  const out = new Map()
  for (const m of mapResults) {
    for (const { value } of settled(m).ok) {
      for (const r of Array.isArray(value?.results) ? value.results : []) out.set(r.sessionId, r)
    }
    for (const f of settled(m).failed) {
      if (f.item?.sessionId) out.set(f.item.sessionId, { sessionId: f.item.sessionId, ok: false, error: f.error ?? f.status })
    }
  }
  return out
}

function fmtMB(bytes) {
  return typeof bytes === "number" ? `${mb(bytes)} MB` : "?"
}

function cell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function actionOf(applied) {
  return applied.ok ? applied.action ?? "applied" : `refused (${applied.error})`
}

/** The `origin` column: the provenance label plus `(user)` when the origin
 *  policy bounds this candidate to flag-only. `(none, user)` is a root with
 *  no origin and no parent — human-launched, never closed. */
function originCell(entry, settings) {
  const origin = entry?.origin
  const userBound = classifyOrigin(entry, policyOf(settings)) === "user"
  if (!origin) return userBound ? "(none, user)" : "(none)"
  return userBound ? `${origin} (user)` : origin
}

/** The `action` column: what actually happened (apply) or the retained action
 *  the policy decided (dry run / skipped). When an outcome exists, the
 *  retained-action label stays visible next to it — that label is what
 *  carries the origin bound ("flag (origine utilisateur)"). */
function actionCell(id, decision, applied) {
  const a = applied.get(id)
  if (!a) return decision.reason
  return `${actionOf(a)} — ${decision.reason}`
}

export function buildReport(b) {
  const s = b.steps.settings ?? resolveSettings(b.input)
  const c = b.steps.candidatesPlus ?? b.steps.candidates ?? { close: [], stuck: [], judge: [], judgeOverflow: [] }
  const verdicts = b.steps.finalVerdicts ?? []
  const applied = collectApplyResults(b.steps.autoApply, b.steps.judgedApply)
  const lines = []
  lines.push(`# Session steward — ${s.apply ? "apply" : "dry run"}`)
  lines.push("")
  lines.push(
    `idle ≥ ${s.idleMinutes} min · minConfidence ${s.minConfidence} · judge \`${s.judge}\` ` +
      `(jev \`${s.jevModel}\`, agent \`${s.judgeModel ?? "agent default"}\`)` +
      (s.askSessions ? " · askSessions on" : ""),
  )
  lines.push(`origins: user=${s.userOrigins.join(", ")} · closable=${s.closableOrigins.join(", ")}`)
  // Host saturation header first, report-only (mission item 9).
  for (const line of saturationHeader(b.steps.hostLoad)) lines.push(line)
  if (!s.apply) lines.push("", "_Dry run: nothing was closed or flagged. Re-run with `apply: true` to act._")
  lines.push("")
  lines.push("| class | session | origin | idle | RAM | verdict | confidence | reason | action |")
  lines.push("|---|---|---|---|---|---|---|---|---|")
  const row = (cls, e, verdict, conf, reason, action) =>
    lines.push(
      `| ${cls} | ${cell(e.label ?? e.sessionId)} | ${cell(originCell(e, s))} | ${e.idleMinutes ?? "?"} min | ${fmtMB(e.rssBytes)} | ` +
        `${cell(verdict)} | ${conf === undefined ? "—" : conf.toFixed(2)} | ${cell(reason)} | ${cell(action)} |`,
    )
  for (const e of c.close) {
    const d = decideFor(e, "close", "done", 1, s)
    row("close", e, "done (rules)", undefined, (e.reasons ?? []).join("; "), actionCell(e.sessionId, d, applied))
  }
  for (const e of c.stuck) {
    const d = decideFor(e, "stuck", "abandoned", 1, s)
    row("stuck", e, "abandoned (rules)", undefined, (e.reasons ?? []).join("; ") || "stuck starting, never ran", actionCell(e.sessionId, d, applied))
  }
  for (const r of verdicts) {
    const d = decideFor(r.entry, "judge", r.verdict, r.confidence, s)
    const by = r.source === "declared" ? " (declared)" : r.source === "jev" ? " (jev)" : r.source === "judged" ? " (agent)" : ""
    const reason = r.jevFallback ? `${r.reason} [jev failed: ${r.jevFallback} → agent judge]` : r.reason
    row("judge", r.entry, `${r.verdict}${by}`, r.confidence, reason, actionCell(r.entry.sessionId, d, applied))
  }
  for (const e of c.judgeOverflow ?? []) row("judge", e, "—", undefined, `not judged this run (maxJudged ${s.maxJudged})`, "none")
  lines.push("")

  const all = [...c.close, ...c.stuck, ...verdicts.map(r => r.entry), ...(c.judgeOverflow ?? [])]
  let freed = 0
  let held = 0
  for (const e of all) {
    const a = applied.get(e.sessionId)
    if (a?.ok && a.action === "closed") freed += e.rssBytes ?? 0
    else held += e.rssBytes ?? 0
  }
  const counts = {}
  for (const r of verdicts) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1
  lines.push(
    `- candidates: close=${c.close.length} stuck=${c.stuck.length} judge=${verdicts.length}` +
      (c.judgeOverflow?.length ? ` (+${c.judgeOverflow.length} not judged)` : ""),
  )
  if (verdicts.length > 0) lines.push(`- verdicts: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ")}`)
  const bySource = { jev: 0, agent: 0 }
  let fallbacks = 0
  for (const r of verdicts) {
    if (r.source === "jev" || r.judgeVerdict?.reason?.startsWith("jev ")) bySource.jev++
    else if (r.source === "judged" || r.judgeSessionId) bySource.agent++
    if (r.jevFallback) fallbacks++
  }
  if (verdicts.length > 0) {
    lines.push(`- judged by: jev=${bySource.jev} agent=${bySource.agent}` + (fallbacks > 0 ? ` (${fallbacks} Jev failure(s) fell back to the agent judge)` : ""))
  }
  lines.push(`- RAM freed (closed sessions): ${fmtMB(freed)}`)
  lines.push(`- RAM still held by idle sessions: ${fmtMB(held)}`)

  // Explicit "0 candidates" explanation (mission item 8) — say WHY, instead
  // of leaving an empty table to interpret.
  const scan = b.steps.scan
  if (scan && c.close.length === 0 && c.stuck.length === 0 && verdicts.length === 0) {
    lines.push(`- ${explainZeroCandidates(scan.counts)}`)
  }

  // Nudge proposals (mission items 1-2) — report only, NEVER executed here.
  const prop = b.steps.proposals ?? { proposals: [], observed: [] }
  if ((prop.proposals ?? []).length > 0 || (prop.observed ?? []).length > 0) {
    lines.push("", "## Proposals (report only — no nudge is sent by this workflow)")
    for (const p of prop.proposals ?? []) lines.push(`- ${p.kind} nudge → ${p.sessionId} — ${p.reason}`)
    for (const p of prop.observed ?? []) lines.push(`- observed → ${p.sessionId} — ${p.reason} (no nudge: ${p.suppressed})`)
  }

  // Terminal sessions with no outcome (mission item 5).
  const relabel = b.steps.relabelQueue ?? []
  if (relabel.length > 0) {
    lines.push("", "## Terminal sessions missing an outcome (relabel candidates)")
    for (const r of relabel) lines.push(`- ${r.sessionId} → ${r.proposedVerdict} — ${r.reason}`)
  }

  // Verdict memory / cache (mission item 10).
  const memory = b.steps.memory
  const cachedCount = verdicts.filter(r => r.source === "cache").length
  if (memory instanceof Map && memory.size > 0) {
    lines.push(`- verdict memory: ${memory.size} session(s) known` + (cachedCount > 0 ? `, ${cachedCount} served from cache` : ""))
  }

  return lines.join("\n")
}

// ── live scan, loop/stall, memory (mission items 1-10) ───────────────────

const TERMINAL_STATUSES = new Set(["killed", "exited", "error", "stopped", "completed", "failed"])

function idleMinutesOf(row, nowMs) {
  const ts = row?.lastActivityAt ?? row?.startedAt
  const ms = ts ? Date.parse(ts) : Number.NaN
  return Number.isFinite(ms) ? Math.max(0, (nowMs - ms) / 60_000) : 0
}

function liveRowsOf(liveSessions) {
  if (Array.isArray(liveSessions?.items)) return liveSessions.items
  if (Array.isArray(liveSessions)) return liveSessions
  return []
}

/**
 * One deterministic pass over the live `session_list` rows: busy sessions
 * (loop/stall scan), idle sessions (zero-candidate accounting), terminal
 * sessions missing an outcome (relabel candidates), never-ran 0/0 sessions,
 * and everything excluded (self / same cron job / archived / pinned / pty /
 * keepAlive). Pure over the rows + settings + an injected `nowMs`.
 */
export function scanLive(liveSessions, settings, nowMs) {
  const rows = liveRowsOf(liveSessions)
  const policy = policyOf(settings)
  const self = settings?.callerSessionId ?? null
  const idleThreshold = settings?.idleMinutes ?? DEFAULT_IDLE_MINUTES
  const busy = []
  const idle = []
  const terminal = []
  const terminalRelabel = []
  const neverRan = []
  const excluded = []
  const loopQueue = []
  const stallInputs = []
  let liveCount = 0
  for (const s of rows) {
    const id = s?.id
    if (!id) continue
    if (self && id === self) {
      excluded.push({ sessionId: id, reason: "caller session" })
      continue
    }
    if (isSelfExcluded(s, { callerSessionId: self, callerOrigin: settings?.callerOrigin }).excluded) {
      excluded.push({ sessionId: id, reason: "same cron job as caller" })
      continue
    }
    if (s.archived === true) {
      excluded.push({ sessionId: id, reason: "archived" })
      continue
    }
    if (s.pinned === true) {
      excluded.push({ sessionId: id, reason: "pinned" })
      continue
    }
    if (s.pty === true) {
      excluded.push({ sessionId: id, reason: "pty" })
      continue
    }
    const originClass = classifyOrigin(s, policy)
    const label = s.label ?? s.name
    const idleMinutes = idleMinutesOf(s, nowMs)
    if (TERMINAL_STATUSES.has(String(s.status ?? ""))) {
      terminal.push({ sessionId: id, origin: s.origin, originClass, label })
      const cand = terminalRelabelCandidate(s)
      if (cand.candidate) {
        terminalRelabel.push({ sessionId: id, origin: s.origin, originClass, label, proposedVerdict: cand.proposedVerdict, reason: cand.reason })
      }
      continue
    }
    if (s.status !== "running" && s.status !== "starting") continue
    liveCount++
    if (s.keepAlive === true) {
      excluded.push({ sessionId: id, reason: "keepAlive" })
      continue
    }
    const row = { sessionId: id, origin: s.origin, originClass, label, idleMinutes, lastTurnErroredAt: s.lastTurnErroredAt ?? null }
    if (isNeverRan(s)) neverRan.push(row)
    if (s.busy === true) {
      busy.push(row)
      loopQueue.push({ sessionId: id, originClass, label })
      stallInputs.push({ sessionId: id, originClass, busy: true, idleMinutes, lastTurnErroredAt: s.lastTurnErroredAt ?? null })
    } else if (idleMinutes >= idleThreshold) {
      idle.push(row)
    }
  }
  const counts = {
    live: liveCount,
    busy: busy.length,
    idle: idle.length,
    terminal: terminal.length,
    terminalRelabel: terminalRelabel.length,
    neverRan: neverRan.length,
    excluded: excluded.length,
  }
  return { busy, idle, terminal, terminalRelabel, neverRan, excluded, loopQueue, stallInputs, counts }
}

/** Fold the never-ran 0/0 sessions into the plan as `stuck` (no judge,
 *  whatever the idle) and drop them from the judge queue — mission item 3. */
export function mergeNeverRan(candidates, scan) {
  const never = scan?.neverRan ?? []
  const neverIds = new Set(never.map(n => n.sessionId))
  const existing = new Set((candidates?.stuck ?? []).map(e => e.sessionId))
  const added = never
    .filter(n => !existing.has(n.sessionId))
    .map(n => ({
      sessionId: n.sessionId,
      ...(n.label ? { label: n.label } : {}),
      idleMinutes: Math.round(n.idleMinutes ?? 0),
      class: "stuck",
      reasons: ["0 tokens in/out — never ran"],
      signals: {},
      ...(n.origin ? { origin: n.origin } : {}),
    }))
  return {
    ...candidates,
    stuck: [...(candidates?.stuck ?? []), ...added],
    judge: (candidates?.judge ?? []).filter(e => !neverIds.has(e.sessionId)),
    judgeOverflow: (candidates?.judgeOverflow ?? []).filter(e => !neverIds.has(e.sessionId)),
  }
}

/** `tool_calls_list` map item → the loop verdict + stats for one session. */
export function analyzeLoopItem(b) {
  const item = b.item ?? {}
  const raw = b.steps.loopCallsOne
  const records = Array.isArray(raw?.records) ? raw.records : Array.isArray(raw) ? raw : []
  const r = detectLoop(records, { nowMs: Date.now() })
  return { sessionId: item.sessionId, label: item.label, originClass: item.originClass, ...r }
}

/** Stall verdicts for every busy live session. */
export function analyzeStalls(scan, nowMs) {
  return (scan?.stallInputs ?? []).map(s => ({
    sessionId: s.sessionId,
    originClass: s.originClass,
    ...detectStall({ busy: s.busy, idleMinutes: s.idleMinutes, lastTurnErroredAt: s.lastTurnErroredAt, nowMs }),
  }))
}

/** Fold the `app_state` read into the per-session verdict memory map. */
export function foldMemory(b) {
  const events = settled(b.steps.memoryRead).ok.flatMap(r => (Array.isArray(r.value?.events) ? r.value.events : []))
  return foldVerdictMemory(events)
}

/** Judge candidates minus those already judged the same verdict on the same
 *  evidence fingerprint for `stableVerdictPasses` passes (the cache). */
export function buildJudgeQueueFiltered(evidenceResult, memory, settings) {
  const rows = settled(evidenceResult).ok.map(r => r.value)
  const queue = []
  const cached = []
  for (const q of rows) {
    const fingerprint = evidenceFingerprint(q.evidence)
    const decision = shouldRejudge(memory, q.entry.sessionId, fingerprint, { stablePasses: settings?.stableVerdictPasses })
    if (!decision.rejudge && decision.cached) cached.push({ ...q, cached: decision.cached, fingerprint })
    else queue.push(q)
  }
  return { queue, cached }
}

/** Cached rows as verdict rows, so they appear in the report and (when they
 *  carry a confident close verdict) can still be applied without re-judging. */
export function buildCachedVerdicts(cachedQueue) {
  return (cachedQueue ?? []).map(q => ({
    entry: q.entry,
    evidence: q.evidence,
    verdict: q.cached.verdict,
    confidence: typeof q.cached.confidence === "number" ? q.cached.confidence : 0,
    reason: `cached verdict (stable ${q.cached.streak ?? "?"} passes, evidence unchanged)`,
    source: "cache",
    cached: true,
    judgedBy: q.cached.judgedBy ?? "steward-cache",
  }))
}

/** `collectVerdicts` + the cached rows (cache rows are never re-judged). */
export function buildVerdicts(b) {
  const jq = b.steps.judgeQueue ?? {}
  return [
    ...collectVerdicts(b.steps.evidence, jq.queue, b.steps.jevJudge, b.steps.jevQueue, b.steps.agentJudgeQueue, b.steps.judge),
    ...buildCachedVerdicts(jq.cached),
  ]
}

/** The report's nudge PROPOSALS (loop → interrupt, stall → continue) plus
 *  the user-origin findings reported as observed-only. Never a close. */
export function buildProposalsStep(scan, loopResults, settings, nowMs) {
  const stalls = analyzeStalls(scan, nowMs)
  const { proposals, observed } = buildProposals({ loopResults, stallResults: stalls })
  return { proposals, observed, stalls }
}

/** Terminal sessions missing an outcome, as relabel candidates. */
export function buildRelabelQueue(scan) {
  return (scan?.terminalRelabel ?? []).map(t => ({ ...t }))
}

/** The `app_state` events to append for this pass's verdicts. The memory is
 *  written on every pass (it is a ledger, never a session action) so streaks
 *  accumulate and the cache can engage. */
export function buildMemoryWriteQueue(finalVerdicts, settings) {
  if (!settings?.appId) return []
  const out = []
  for (const r of finalVerdicts ?? []) {
    if (!r?.entry?.sessionId || r.malformed) continue
    const fingerprint = r.evidence ? evidenceFingerprint(r.evidence) : null
    out.push({
      appId: settings.appId,
      event: verdictMemoryEvent({
        sessionId: r.entry.sessionId,
        verdict: r.verdict,
        confidence: r.confidence,
        fingerprint,
        judgedBy: r.judgedBy ?? r.source ?? null,
        note: r.reason,
      }),
    })
  }
  return out
}

// ── the workflow ─────────────────────────────────────────────────────────

export default {
  name: "Session Steward",
  id: "session-steward",
  description:
    "Plan idle-session wrap-up (session_wrapup_plan), close the rule-certain " +
    "`close`/`stuck` sessions, judge the ambiguous `judge` ones with a cheap " +
    "one-shot model over compact evidence, optionally ask a session directly, " +
    "then close or flag the confident verdicts with a recorded outcome — and report. " +
    "Origin-bounded: a human-launched session (`chat-starter`, `vscode`, or a " +
    "root with no origin and no parent) is only ever flagged, never closed. " +
    "Dry run unless `apply` is true.",
  version: "0.1.0",
  inputs: {
    idleMinutes: { type: "number", description: `Idle threshold in minutes. Default ${DEFAULT_IDLE_MINUTES}.`, default: DEFAULT_IDLE_MINUTES },
    apply: { type: "boolean", description: "Close/flag sessions. Default false = dry run (plan + verdicts, no mutation).", default: false },
    minConfidence: { type: "number", description: `Judge confidence needed to act. Default ${DEFAULT_MIN_CONFIDENCE}.`, default: DEFAULT_MIN_CONFIDENCE },
    judge: { type: "string", description: "Judge backend: `auto` (Jev when JEV_API_KEY resolves, else the agent judge), `jev`, or `agent`. A Jev failure always falls back to the agent judge. Default auto.", default: "auto" },
    jevModel: { type: "string", description: `Jev model. Default ${DEFAULT_JEV_MODEL}.`, default: DEFAULT_JEV_MODEL },
    judgeModel: { type: "string", description: `Model for the agent judge. Default: the \`${ROLE_JUDGE_SESSION}\` model role (repo agentproto.json \`models\` > daemon config \`models\` > built-in).` },
    maxJudged: { type: "number", description: `Most \`judge\` sessions judged per run, most RAM first. Default ${DEFAULT_MAX_JUDGED}.`, default: DEFAULT_MAX_JUDGED },
    askSessions: { type: "boolean", description: "Ask low-confidence idle sessions directly whether they're done. Default false — it spends a turn in someone else's conversation.", default: false },
    callerSessionId: { type: "string", description: "The calling session's id — never a candidate. The CLI passes AGENTPROTO_SESSION_ID." },
    callerOrigin: { type: "string", description: "The calling session's origin (`cron:<jobId>`) — an older run of the SAME cron job is never judged as user work." },
    appId: { type: "string", description: `Installed app whose \`app_state\` ledger holds the verdict memory. Default ${DEFAULT_APP_ID}.` },
    stableVerdictPasses: { type: "number", description: `Consecutive passes on an unchanged evidence fingerprint before the judge cache stops re-judging. Default ${DEFAULT_STABLE_VERDICT_PASSES}.`, default: DEFAULT_STABLE_VERDICT_PASSES },
    userOrigins: { type: "array", description: `Origins that are ALWAYS flag-only, never closed (a human is in the loop). Trailing \`*\` is a prefix wildcard. Default ${JSON.stringify(DEFAULT_USER_ORIGINS)}.`, items: { type: "string" }, default: DEFAULT_USER_ORIGINS },
    closableOrigins: { type: "array", description: `Origins that may be closed under the current rules (cron jobs, gates). Trailing \`*\` is a prefix wildcard. Executors (a session with a parentSessionId) are closable regardless. Default ${JSON.stringify(DEFAULT_CLOSABLE_ORIGINS)}.`, items: { type: "string" }, default: DEFAULT_CLOSABLE_ORIGINS },
  },
  outputs: {},
  steps: [
    {
      id: "modelRoles",
      kind: "tool",
      tool: "model_roles",
      inputs: { roles: [ROLE_JUDGE_SESSION], inputs: { [ROLE_JUDGE_SESSION]: "$input.judgeModel" } },
    },
    { id: "settings", kind: "transform", compute: b => resolveSettings(b.input, b.steps.modelRoles) },
    {
      id: "plan",
      kind: "tool",
      tool: "session_wrapup_plan",
      inputs: { idleMinutes: "$steps.settings.idleMinutes" },
    },
    { id: "candidates", kind: "transform", compute: b => splitCandidates(b.steps.plan, b.steps.settings) },
    // Host saturation header (report only — mission item 9) and the live
    // session scan behind loop/stall/never-ran/terminal rules (items 1-5).
    { id: "hostLoad", kind: "tool", tool: "host_load", inputs: {} },
    { id: "liveSessions", kind: "tool", tool: "session_list", inputs: { full: true } },
    { id: "scan", kind: "transform", compute: b => scanLive(b.steps.liveSessions, b.steps.settings, Date.now()) },
    // Never-ran 0/0 sessions are `stuck` immediately, never judged (item 3).
    { id: "candidatesPlus", kind: "transform", compute: b => mergeNeverRan(b.steps.candidates, b.steps.scan) },
    { id: "ruleApplyQueue", kind: "transform", compute: b => buildRuleApplyQueue(b.steps.candidatesPlus, b.steps.settings) },
    {
      // Empty unless `apply` — a dry run dispatches no apply call at all.
      id: "autoApply",
      kind: "map",
      over: "$steps.ruleApplyQueue",
      parallelism: 1,
      onError: "collect",
      steps: [
        {
          id: "autoApplyOne",
          kind: "tool",
          tool: "session_wrapup_apply",
          inputs: { sessionIds: ["$item.sessionId"], verdict: "$item.verdict", note: "$item.note" },
        },
      ],
    },
    // Verdict memory (item 10): read the app_state ledger best-effort. The
    // map is empty when no app id is set, so a caller can turn memory off.
    { id: "memoryQueue", kind: "transform", compute: b => (b.steps.settings?.appId ? [{ appId: b.steps.settings.appId }] : []) },
    {
      id: "memoryRead",
      kind: "map",
      over: "$steps.memoryQueue",
      parallelism: 1,
      onError: "collect",
      steps: [
        {
          id: "memoryReadOne",
          kind: "tool",
          tool: "app_state_list",
          inputs: { appId: "$item.appId", stage: "session-steward", kinds: ["note"], limit: 500 },
        },
      ],
    },
    { id: "memory", kind: "transform", compute: foldMemory },
    // Loop sanity over the busy sessions (item 1) — one tool_calls_list each.
    {
      id: "loopScan",
      kind: "map",
      over: "$steps.scan.loopQueue",
      parallelism: 4,
      onError: "collect",
      steps: [
        { id: "loopCallsOne", kind: "tool", tool: "tool_calls_list", inputs: { sessionId: "$item.sessionId", lastN: 60 } },
        { id: "loopFold", kind: "transform", compute: analyzeLoopItem },
      ],
    },
    { id: "loopResults", kind: "transform", compute: b => settled(b.steps.loopScan).ok.map(r => r.value) },
    // Nudge PROPOSALS (never executed here): loop → interrupt, stall →
    // continue, at most one per session per pass, user origins observed only.
    { id: "proposals", kind: "transform", compute: b => buildProposalsStep(b.steps.scan, b.steps.loopResults, b.steps.settings, Date.now()) },
    { id: "relabelQueue", kind: "transform", compute: b => buildRelabelQueue(b.steps.scan) },
    {
      id: "evidence",
      kind: "map",
      over: "$steps.candidatesPlus.judge",
      parallelism: 4,
      onError: "collect",
      steps: [
        { id: "evidenceOne", kind: "tool", tool: "session_evidence", inputs: { sessionId: "$item.sessionId" } },
        // Reads `$steps.evidenceOne` in the transform right after this item's
        // own tool step wrote it (no await between) and checks the id.
        { id: "evidenceFold", kind: "transform", compute: foldEvidence },
      ],
    },
    // Judge queue minus sessions cached by stable verdict+fingerprint (item 10).
    { id: "judgeQueue", kind: "transform", compute: b => buildJudgeQueueFiltered(b.steps.evidence, b.steps.memory, b.steps.settings) },
    {
      id: "jevQueue",
      kind: "transform",
      compute: b => (b.steps.settings?.judge === "agent" ? [] : b.steps.judgeQueue?.queue ?? []),
    },
    {
      // Jev backend: one calibrated `choice` call per candidate. Never an
      // error result — a missing key or failure is `ok:false`, and that
      // candidate goes to the agent judge instead.
      id: "jevJudge",
      kind: "map",
      over: "$steps.jevQueue",
      parallelism: 4,
      onError: "collect",
      steps: [
        {
          id: "jevOne",
          kind: "tool",
          tool: "session_judge_jev",
          inputs: { sessionId: "$item.entry.sessionId", evidence: "$item.evidence", model: "$steps.settings.jevModel" },
        },
      ],
    },
    {
      id: "agentJudgeQueue",
      kind: "transform",
      compute: b => buildAgentJudgeQueue(b.steps.judgeQueue?.queue, b.steps.jevQueue, b.steps.jevJudge, b.steps.settings),
    },
    {
      // One-shot judge per candidate. The engine releases (kills + archives)
      // each judge session as soon as its map item settles.
      id: "judge",
      kind: "map",
      over: "$steps.agentJudgeQueue",
      parallelism: 3,
      onError: "collect",
      steps: [
        {
          id: "judgeOne",
          kind: "agent",
          agent: { ref: JUDGE_REF },
          prompt: "$item.judgePrompt",
          model: b => b.steps.settings?.judgeModel,
        },
        {
          id: "judgeParse",
          kind: "transform",
          compute: b => ({
            sessionId: b.item?.entry?.sessionId,
            judgeSessionId: b.steps.judgeOne?.sessionId,
            ...parseJudgeVerdict(b.steps.judgeOne?.text, b.item?.entry?.sessionId),
          }),
        },
      ],
    },
    { id: "verdicts", kind: "transform", compute: buildVerdicts },
    { id: "askQueue", kind: "transform", compute: b => buildAskQueue(b.steps.verdicts, b.steps.settings) },
    {
      // Empty unless `askSessions`. ONE prompt per session (queue:false — a
      // session that turned busy meanwhile refuses it), then a bounded wait,
      // then its newest assistant turn is parsed for the STEWARD line.
      id: "ask",
      kind: "map",
      over: "$steps.askQueue",
      parallelism: 2,
      onError: "collect",
      steps: [
        {
          id: "askPrompt",
          kind: "tool",
          tool: "agent_prompt",
          inputs: { sessionId: "$item.sessionId", prompt: ASK_PROMPT, queue: false, interrupt: false },
        },
        { id: "askArm", kind: "transform", compute: b => ((b.item.askWaiting = true), true) },
        {
          id: "askWait",
          kind: "loop",
          while: "$item.askWaiting",
          max_iterations: ASK_WAIT_POLLS,
          steps: [
            {
              id: "askMonitor",
              kind: "tool",
              tool: "session_monitor",
              inputs: { sessionId: "$item.sessionId", event: "turn-end", timeoutMs: ASK_POLL_MS },
            },
            {
              id: "askMonitorFold",
              kind: "transform",
              compute: b => ((b.item.askWaiting = b.steps.askMonitor?.timedOut === true), b.item.askWaiting),
            },
          ],
        },
        { id: "askRead", kind: "tool", tool: "session_evidence", inputs: { sessionId: "$item.sessionId" } },
        {
          id: "askParse",
          kind: "transform",
          compute: b => {
            const raw = b.steps.askRead
            if (raw?.sessionId !== b.item.sessionId) return { sessionId: b.item.sessionId, declared: null }
            const parsed = parseStewardReply(lastAssistantText(raw))
            return { sessionId: b.item.sessionId, declared: parsed?.declared ?? null, line: parsed?.line ?? "" }
          },
        },
      ],
    },
    { id: "finalVerdicts", kind: "transform", compute: b => mergeDeclared(b.steps.verdicts, b.steps.askQueue, b.steps.ask) },
    { id: "judgedApplyQueue", kind: "transform", compute: b => buildJudgedApplyQueue(b.steps.finalVerdicts, b.steps.settings) },
    {
      // Empty unless `apply`. blocked/needs-input only FLAG (the tool never
      // closes on those); done/abandoned close resumably with the outcome.
      id: "judgedApply",
      kind: "map",
      over: "$steps.judgedApplyQueue",
      parallelism: 1,
      onError: "collect",
      steps: [
        {
          id: "judgedApplyOne",
          kind: "tool",
          tool: "session_wrapup_apply",
          inputs: { sessionIds: ["$item.sessionId"], verdict: "$item.verdict", judgedBy: "$item.judgedBy", note: "$item.note" },
        },
      ],
    },
    // Verdict memory write-back (item 10) — a ledger append, never a session
    // action; best-effort (an uninstalled app just yields no memory).
    { id: "memoryWriteQueue", kind: "transform", compute: b => buildMemoryWriteQueue(b.steps.finalVerdicts, b.steps.settings) },
    {
      id: "memoryWrite",
      kind: "map",
      over: "$steps.memoryWriteQueue",
      parallelism: 1,
      onError: "collect",
      steps: [
        { id: "memoryWriteOne", kind: "tool", tool: "app_state_append", inputs: { appId: "$item.appId", event: "$item.event" } },
      ],
    },
    { id: "report", kind: "transform", compute: b => buildReport(b) },
  ],
  result: {
    report: "$steps.report",
    apply: "$steps.settings.apply",
    candidates: "$steps.candidatesPlus",
    verdicts: "$steps.finalVerdicts",
    autoApply: "$steps.autoApply",
    judgedApply: "$steps.judgedApply",
    proposals: "$steps.proposals",
    relabel: "$steps.relabelQueue",
    scan: "$steps.scan",
  },
}
