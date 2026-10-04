// Runtime source of truth for WORKFLOW.md's step graph (same pattern as
// `session-steward/entry.mjs`; the frontmatter mirrors it by id+kind).
//
// READ-ONLY by construction: the only tools are `model_roles`, `session_list`
// and `session_evidence`, and the judge agent is told to call none. This
// workflow can neither close, flag, nudge nor write anything — it produces a
// prioritized "what needs you" digest, nothing else. (Closing/flagging stays
// in `session-steward --wrapup`.)
//
// Decisions live in `attention.mjs` (pure, unit tested); this file wires
// them over the live session list and per-session evidence.

import { isSelfExcluded } from "../session-steward/cron-rules.mjs"
import {
  DEFAULT_IDLE_MINUTES,
  buildAttentionPrompt,
  buildDigest,
  classifyAttention,
  displayTitle,
  excerptOf,
  findNewerSiblings,
  mergeJudged,
  parseAttentionVerdict,
} from "./attention.mjs"

const DEFAULT_MAX_JUDGED = 20
const DEFAULT_MAX_SESSIONS = 80
const DEFAULT_MAX_CHARS = 3500
const ROLE_JUDGE_SESSION = "judge.session"
const JUDGE_REF = "@agentproto/session-attention-judge"
const JUDGE_BACKENDS = ["agent", "rules"]
const JUDGE_EVIDENCE_MAX_CHARS = 6_000

function num(v, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback
}

function explicitOrRole(explicit, modelRoles, role) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim()
  const resolved = modelRoles?.models?.[role]
  return typeof resolved === "string" && resolved ? resolved : undefined
}

export function resolveSettings(input, modelRoles) {
  const i = input ?? {}
  return {
    idleMinutes: num(i.idleMinutes, DEFAULT_IDLE_MINUTES, { min: 0 }),
    judge: JUDGE_BACKENDS.includes(i.judge) ? i.judge : "agent",
    judgeModel: explicitOrRole(i.judgeModel, modelRoles, ROLE_JUDGE_SESSION),
    maxJudged: Math.floor(num(i.maxJudged, DEFAULT_MAX_JUDGED)),
    maxSessions: Math.floor(num(i.maxSessions, DEFAULT_MAX_SESSIONS, { min: 1 })),
    maxChars: Math.floor(num(i.maxChars, DEFAULT_MAX_CHARS, { min: 500 })),
    includeChildren: i.includeChildren === true,
    callerSessionId: typeof i.callerSessionId === "string" && i.callerSessionId ? i.callerSessionId : null,
    callerOrigin: typeof i.callerOrigin === "string" && i.callerOrigin ? i.callerOrigin : null,
  }
}

function liveRowsOf(liveSessions) {
  if (Array.isArray(liveSessions?.items)) return liveSessions.items
  if (Array.isArray(liveSessions)) return liveSessions
  return []
}

function idleMinutesOf(row, nowMs) {
  const ms = Date.parse(row?.lastActivityAt ?? row?.startedAt ?? "")
  return Number.isFinite(ms) ? Math.max(0, (nowMs - ms) / 60_000) : 0
}

/** Which live sessions get a look. Not the caller, not another run of the
 *  caller's cron job, not archived or a raw PTY, only `running`. A child of a
 *  live parent is that parent's business (unless it is awaiting input or
 *  `includeChildren`); an orphaned child is included. */
export function scanSessions(liveSessions, settings, nowMs) {
  const rows = liveRowsOf(liveSessions)
  const liveIds = new Set(rows.filter(r => r?.status === "running").map(r => r.id))
  const candidates = []
  const skipped = { caller: 0, archived: 0, pty: 0, notRunning: 0, childOfLive: 0 }
  for (const row of rows) {
    if (!row?.id) continue
    if (settings?.callerSessionId && row.id === settings.callerSessionId) { skipped.caller++; continue }
    if (isSelfExcluded(row, { callerSessionId: settings?.callerSessionId, callerOrigin: settings?.callerOrigin }).excluded) { skipped.caller++; continue }
    if (row.archived === true) { skipped.archived++; continue }
    if (row.pty === true) { skipped.pty++; continue }
    if (row.status !== "running") { skipped.notRunning++; continue }
    if (row.parentSessionId && liveIds.has(row.parentSessionId) && row.awaitingInput !== true && !settings?.includeChildren) { skipped.childOfLive++; continue }
    candidates.push({ sessionId: row.id, row })
  }
  candidates.sort((a, b) => idleMinutesOf(a.row, nowMs) - idleMinutesOf(b.row, nowMs))
  const cap = settings?.maxSessions ?? DEFAULT_MAX_SESSIONS
  return {
    candidates: candidates.slice(0, cap),
    counts: { live: liveIds.size, scanned: Math.min(candidates.length, cap), overflow: Math.max(0, candidates.length - cap), ...skipped },
  }
}

/** Fold one `session_evidence` answer with its list row into a classified
 *  entry. The id check guards against pairing the wrong evidence. */
export function foldEvidence(b) {
  const row = b.item?.row ?? {}
  const raw = b.steps.evidenceOne
  if (!raw || raw.sessionId !== b.item?.sessionId) {
    throw new Error(`session_evidence answered for '${raw?.sessionId}', expected '${b.item?.sessionId}'`)
  }
  const nowMs = Date.now()
  const evidence = { ...raw, idleMinutes: typeof raw.idleMinutes === "number" ? raw.idleMinutes : idleMinutesOf(row, nowMs) }
  const settings = b.steps.settings
  const title = displayTitle(row, evidence)
  const siblings = findNewerSiblings(liveRowsOf(b.steps.liveSessions), row, nowMs)
  const rule = classifyAttention(evidence, { nowMs, idleMinutes: settings?.idleMinutes, siblings, title })
  return { sessionId: b.item.sessionId, row, evidence, title, siblings, rule }
}

function settled(mapResult) {
  if (Array.isArray(mapResult)) return { ok: mapResult.map((value, index) => ({ index, value })), failed: [] }
  const results = Array.isArray(mapResult?.results) ? mapResult.results : []
  return {
    ok: results.filter(r => r?.status === "fulfilled").map(r => ({ index: r.index, value: r.value })),
    failed: results.filter(r => r && r.status !== "fulfilled"),
  }
}

/** Compact judge evidence: the evidence object plus the title and newer
 *  siblings, under a size cap (oldest turns dropped first). */
export function judgeEvidenceOf(entry) {
  const ev = { ...entry.evidence, title: entry.title, newerSiblings: entry.siblings, turns: [...(entry.evidence.turns ?? [])] }
  while (JSON.stringify(ev).length > JUDGE_EVIDENCE_MAX_CHARS && ev.turns.length > 1) ev.turns.shift()
  return ev
}

/** Ambiguous entries the judge takes: most recently active first, capped. */
export function buildJudgeQueue(entries, settings) {
  if (settings?.judge === "rules") return []
  return (entries ?? [])
    .filter(e => e.rule.ambiguous)
    .sort((a, b) => (a.evidence.idleMinutes ?? 0) - (b.evidence.idleMinutes ?? 0))
    .slice(0, settings?.maxJudged ?? DEFAULT_MAX_JUDGED)
    .map(e => ({ sessionId: e.sessionId, prompt: buildAttentionPrompt(judgeEvidenceOf(e), e.rule) }))
}

/** An idle session whose turn ended is never `active`: whatever slipped
 *  through (a future rule, a judge) becomes `parked`. */
export function guardIdle(item, evidence, idleThreshold) {
  if (item.verdict !== "active") return item
  if (evidence?.busy === true) return item
  if ((evidence?.idleMinutes ?? 0) < idleThreshold) return item
  return { ...item, verdict: "parked", waitingOnYou: false, reason: `idle ${Math.round(evidence.idleMinutes)}m, not working — ${item.reason}`, guarded: true }
}

/** Every scanned session → one digest item (rules, judge-merged, guarded). */
export function buildItems(entries, judgeQueue, judgeResult, evidenceFailures, settings) {
  const verdicts = new Map()
  const { ok } = settled(judgeResult)
  for (const { index, value } of ok) {
    const q = (judgeQueue ?? [])[index]
    if (q && value?.sessionId === q.sessionId) verdicts.set(q.sessionId, value)
  }
  const items = []
  for (const e of entries ?? []) {
    const judged = verdicts.get(e.sessionId)
    const merged = mergeJudged(e.rule, judged && judged.verdict ? judged : null)
    const g = guardIdle(merged, e.evidence, settings?.idleMinutes ?? DEFAULT_IDLE_MINUTES)
    items.push({
      sessionId: e.sessionId,
      title: e.title,
      verdict: g.verdict,
      confidence: g.confidence,
      reason: g.reason,
      flags: g.flags ?? [],
      waitingOnYou: g.waitingOnYou === true,
      source: g.source,
      idleMinutes: Math.round(e.evidence.idleMinutes ?? 0),
      excerpt: excerptOf(e.evidence),
      cwd: e.evidence.cwd ?? e.row.cwd,
      adapter: e.evidence.adapter ?? e.row.adapter,
      origin: e.evidence.origin ?? e.row.origin,
      ...(g.rule ? { rule: g.rule } : {}),
      ...(g.guarded ? { guarded: true } : {}),
    })
  }
  for (const f of evidenceFailures ?? []) {
    const row = f.item?.row ?? {}
    items.push({
      sessionId: f.item?.sessionId ?? "?",
      title: displayTitle(row),
      verdict: "parked",
      confidence: 0,
      reason: `evidence unavailable (${f.error ?? f.status}) — could not be assessed`,
      flags: ["no-evidence"],
      waitingOnYou: false,
      source: "none",
      idleMinutes: Math.round(idleMinutesOf(row, Date.now())),
      excerpt: "",
      cwd: row.cwd,
    })
  }
  return items
}

/** Judge answers parsed from the agent step output (one per queue item). */
export function parseJudgeItem(b) {
  const sessionId = b.item?.sessionId
  const parsed = parseAttentionVerdict(b.steps.judgeOne?.text, sessionId)
  return { sessionId, ...(parsed ?? {}) }
}

export function buildAttentionDigest(b) {
  const settings = b.steps.settings ?? resolveSettings(b.input)
  return buildDigest(b.steps.items, { maxChars: settings.maxChars, now: new Date().toISOString().slice(0, 16).replace("T", " ") + "Z" })
}

export default {
  name: "Session Attention",
  id: "session-attention",
  description:
    "Read-only triage of every live session for its human owner: which ones need a reply, are blocked, stuck " +
    "(looping/errored), done, superseded or merely parked — most urgent first, each with a one-line reason and " +
    "an excerpt. Rules decide the certain cases; a cheap judge decides the ambiguous ones. Never closes or " +
    "messages anything.",
  version: "0.1.0",
  inputs: {
    idleMinutes: { type: "number", description: `Minutes since its last activity before a finished turn counts as waiting. Default ${DEFAULT_IDLE_MINUTES}.`, default: DEFAULT_IDLE_MINUTES },
    judge: { type: "string", description: "Judge backend for ambiguous sessions: `agent` (default) or `rules` (rules only, no model).", default: "agent" },
    judgeModel: { type: "string", description: `Model for the judge. Default: the \`${ROLE_JUDGE_SESSION}\` model role.` },
    maxJudged: { type: "number", description: `Most ambiguous sessions judged per run. Default ${DEFAULT_MAX_JUDGED}.`, default: DEFAULT_MAX_JUDGED },
    maxSessions: { type: "number", description: `Most live sessions examined per run. Default ${DEFAULT_MAX_SESSIONS}.`, default: DEFAULT_MAX_SESSIONS },
    maxChars: { type: "number", description: `Cap on the plain-text digest (chat delivery). Default ${DEFAULT_MAX_CHARS}.`, default: DEFAULT_MAX_CHARS },
    includeChildren: { type: "boolean", description: "Also triage executors whose supervisor is still live. Default false.", default: false },
    callerSessionId: { type: "string", description: "The calling session's id — never triaged. The CLI passes AGENTPROTO_SESSION_ID." },
    callerOrigin: { type: "string", description: "The calling session's origin (`cron:<jobId>`) — an older run of the SAME cron job is never triaged." },
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
    { id: "liveSessions", kind: "tool", tool: "session_list", inputs: { full: true, onlyAlive: true, limit: 200 } },
    { id: "scan", kind: "transform", compute: b => scanSessions(b.steps.liveSessions, b.steps.settings, Date.now()) },
    {
      id: "evidence",
      kind: "map",
      over: "$steps.scan.candidates",
      parallelism: 6,
      onError: "collect",
      steps: [
        { id: "evidenceOne", kind: "tool", tool: "session_evidence", inputs: { sessionId: "$item.sessionId" } },
        { id: "evidenceFold", kind: "transform", compute: foldEvidence },
      ],
    },
    { id: "entries", kind: "transform", compute: b => settled(b.steps.evidence).ok.map(r => r.value) },
    { id: "judgeQueue", kind: "transform", compute: b => buildJudgeQueue(b.steps.entries, b.steps.settings) },
    {
      id: "judge",
      kind: "map",
      over: "$steps.judgeQueue",
      parallelism: 3,
      onError: "collect",
      steps: [
        {
          id: "judgeOne",
          kind: "agent",
          agent: { ref: JUDGE_REF },
          prompt: "$item.prompt",
          model: b => b.steps.settings?.judgeModel,
        },
        { id: "judgeParse", kind: "transform", compute: parseJudgeItem },
      ],
    },
    {
      id: "items",
      kind: "transform",
      compute: b => buildItems(b.steps.entries, b.steps.judgeQueue, b.steps.judge, settled(b.steps.evidence).failed, b.steps.settings),
    },
    { id: "digest", kind: "transform", compute: buildAttentionDigest },
  ],
  result: {
    report: "$steps.digest.markdown",
    text: "$steps.digest.text",
    counts: "$steps.digest.counts",
    items: "$steps.digest.ordered",
    scan: "$steps.scan.counts",
  },
}
