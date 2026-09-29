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
//   - mutates nothing unless `apply` is true (every mutating map runs over an
//     empty list otherwise);
//   - only ever feeds `close`/`stuck` ids to the rules pass — a `keepAlive`
//     session can only ever be `judge` class, so rules never close it;
//   - drops the caller's own session from every candidate list;
//   - treats a malformed judge reply as `active` with confidence 0 (never
//     acted on).

const DEFAULT_IDLE_MINUTES = 30
const DEFAULT_MIN_CONFIDENCE = 0.8
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
const APPLY_VERDICTS = new Set(["done", "abandoned", "blocked", "needs-input"])

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
  }
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

/** Rules pass: `close` → done, `stuck` → abandoned — only when `apply`. */
export function buildRuleApplyQueue(candidates, settings) {
  if (!settings?.apply) return []
  return [
    ...(candidates?.close ?? []).map(e => ({
      sessionId: e.sessionId,
      verdict: "done",
      note: `steward-rules: ${(e.reasons ?? []).join("; ") || "close class"}`,
    })),
    ...(candidates?.stuck ?? []).map(e => ({
      sessionId: e.sessionId,
      verdict: "abandoned",
      note: "stuck starting, never ran",
    })),
  ]
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
 *  first, then the tail signal shortened). */
export function composeEvidence(entry, raw) {
  const signals = entry?.signals ?? {}
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
    signals: {
      lastAssistantTail: cut(signals.lastAssistantTail, 800),
      pendingToolCall: signals.pendingToolCall === true,
      parentEnded: signals.parentEnded === true,
      worktreeMerged: signals.worktreeMerged === true,
    },
    worktree: raw?.worktree ?? null,
    turns: Array.isArray(raw?.turns) ? [...raw.turns] : [],
  }
  while (JSON.stringify(evidence).length > EVIDENCE_MAX_CHARS && evidence.turns.length > 0) evidence.turns.shift()
  if (JSON.stringify(evidence).length > EVIDENCE_MAX_CHARS) evidence.signals.lastAssistantTail = cut(evidence.signals.lastAssistantTail, 200)
  return evidence
}

export function buildJudgePrompt(evidence) {
  return (
    "You are the session steward's judge. Decide whether ONE idle AI coding-agent session " +
    "is finished, from the evidence below. Do NOT call any tool — answer from the evidence alone.\n\n" +
    "Verdicts:\n" +
    "- `done`: the task visibly finished — a PR was opened or merged, a final report was given, " +
    "or the user said thanks/ok with nothing pending.\n" +
    "- `abandoned`: superseded or a dead end, with nothing worth keeping.\n" +
    "- `blocked`: waiting on something external (CI, another session, a dependency).\n" +
    "- `needs-input`: waiting on a human answer or decision.\n" +
    "- `active`: mid-work — keep it.\n" +
    "When unsure, say `active` with a LOW confidence. Closing a session that still had work " +
    "is worse than leaving an idle one open.\n\n" +
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
  const evidence = composeEvidence(b.item, raw)
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
 *  `minConfidence` — only when `apply`. A malformed reply is `active`/0 and
 *  can never qualify. */
export function buildJudgedApplyQueue(finalVerdicts, settings) {
  if (!settings?.apply) return []
  return (finalVerdicts ?? [])
    .filter(r => !r.malformed && APPLY_VERDICTS.has(r.verdict) && r.confidence >= settings.minConfidence)
    .map(r => ({
      sessionId: r.entry.sessionId,
      verdict: r.verdict,
      judgedBy: r.source === "declared" ? `steward-ask:${r.entry.sessionId}` : r.judgedBy ?? r.judgeSessionId ?? "steward-judge",
      note: r.reason,
    }))
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

function actionOf(applied, apply, wouldAct) {
  if (applied) return applied.ok ? applied.action ?? "applied" : `refused (${applied.error})`
  if (!apply) return wouldAct ? "none (dry run)" : "none"
  return "none"
}

export function buildReport(b) {
  const s = b.steps.settings ?? resolveSettings(b.input)
  const c = b.steps.candidates ?? { close: [], stuck: [], judge: [], judgeOverflow: [] }
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
  if (!s.apply) lines.push("", "_Dry run: nothing was closed or flagged. Re-run with `apply: true` to act._")
  lines.push("")
  lines.push("| class | session | idle | RAM | verdict | confidence | reason | action |")
  lines.push("|---|---|---|---|---|---|---|---|")
  const row = (cls, e, verdict, conf, reason, action) =>
    lines.push(
      `| ${cls} | ${cell(e.label ?? e.sessionId)} | ${e.idleMinutes ?? "?"} min | ${fmtMB(e.rssBytes)} | ` +
        `${cell(verdict)} | ${conf === undefined ? "—" : conf.toFixed(2)} | ${cell(reason)} | ${cell(action)} |`,
    )
  for (const e of c.close) row("close", e, "done (rules)", undefined, (e.reasons ?? []).join("; "), actionOf(applied.get(e.sessionId), s.apply, true))
  for (const e of c.stuck) row("stuck", e, "abandoned (rules)", undefined, "stuck starting, never ran", actionOf(applied.get(e.sessionId), s.apply, true))
  for (const r of verdicts) {
    const wouldAct = !r.malformed && APPLY_VERDICTS.has(r.verdict) && r.confidence >= s.minConfidence
    const action = applied.get(r.entry.sessionId)
      ? actionOf(applied.get(r.entry.sessionId), s.apply, wouldAct)
      : wouldAct
        ? s.apply ? "none" : "none (dry run)"
        : "untouched (below threshold or active)"
    const by = r.source === "declared" ? " (declared)" : r.source === "jev" ? " (jev)" : r.source === "judged" ? " (agent)" : ""
    const reason = r.jevFallback ? `${r.reason} [jev failed: ${r.jevFallback} → agent judge]` : r.reason
    row("judge", r.entry, `${r.verdict}${by}`, r.confidence, reason, action)
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
  return lines.join("\n")
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
    { id: "ruleApplyQueue", kind: "transform", compute: b => buildRuleApplyQueue(b.steps.candidates, b.steps.settings) },
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
    {
      id: "evidence",
      kind: "map",
      over: "$steps.candidates.judge",
      parallelism: 4,
      onError: "collect",
      steps: [
        { id: "evidenceOne", kind: "tool", tool: "session_evidence", inputs: { sessionId: "$item.sessionId" } },
        // Reads `$steps.evidenceOne` in the transform right after this item's
        // own tool step wrote it (no await between) and checks the id.
        { id: "evidenceFold", kind: "transform", compute: foldEvidence },
      ],
    },
    { id: "judgeQueue", kind: "transform", compute: b => settled(b.steps.evidence).ok.map(r => r.value) },
    {
      id: "jevQueue",
      kind: "transform",
      compute: b => (b.steps.settings?.judge === "agent" ? [] : b.steps.judgeQueue ?? []),
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
      compute: b => buildAgentJudgeQueue(b.steps.judgeQueue, b.steps.jevQueue, b.steps.jevJudge, b.steps.settings),
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
    { id: "verdicts", kind: "transform", compute: b =>
        collectVerdicts(b.steps.evidence, b.steps.judgeQueue, b.steps.jevJudge, b.steps.jevQueue, b.steps.agentJudgeQueue, b.steps.judge),
    },
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
    { id: "report", kind: "transform", compute: b => buildReport(b) },
  ],
  result: {
    report: "$steps.report",
    apply: "$steps.settings.apply",
    candidates: "$steps.candidates",
    verdicts: "$steps.finalVerdicts",
    autoApply: "$steps.autoApply",
    judgedApply: "$steps.judgedApply",
  },
}
