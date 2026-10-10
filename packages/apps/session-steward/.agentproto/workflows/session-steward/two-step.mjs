// Shared pieces of the three-step steward — `classify` (fast, typed), `analyze`
// (LLM reasons for the relevant rows) and `act` (apply by rules). Each is its
// own workflow (`session-steward-classify` / `-analyze` / `-act`) that imports
// the step builders and pure helpers below; they all read and write the same
// persisted snapshot (`actions.mjs`'s `steward-snapshot/v1`).
//
// Footprint rule (daemon-footprint P2): no step here puts a full session list
// in a step output. Listing goes through `live-list.mjs` (projected, filtered,
// paged, merged only inside a compute); the act step looks sessions up by id.

import { LIVE_FIELDS, liveListSteps, scannedRows } from "./live-list.mjs"
import {
  applyRelabelEvidence,
  buildRelabelEvidenceQueue,
  buildRelabelQueue,
  collectVerdicts,
  composeEvidence,
  demoteErroredCloses,
  explainRefusal,
  foldRelabelEvidence,
  mergeNeverRan,
  remainingWorkOf,
  resolveMemoryApp,
  resolveSettings,
  scanListed,
  settled,
  splitCandidates,
} from "./entry.mjs"
import {
  DEFAULT_RELAUNCH_WINDOW_MINUTES,
  ACTIONS,
  ACTION_INFO,
  ANALYZE_DEFAULT_MAX,
  SNAPSHOT_SCHEMA,
  actTargets,
  applyAnalyses,
  buildAnalyzePrompt,
  buildSnapshot,
  foldActResults,
  heuristicAnalysis,
  parseAnalysis,
  planActs,
  renderPlan,
  renderSnapshot,
  selectForAnalysis,
  validateRules,
} from "./actions.mjs"
import { saturationHeader } from "./cron-rules.mjs"

export const PROFILE_FIELDS = ["id", "endpoint", "method", "credentialRef", "subaccount", "label", "disabled", "models", "keyStatus"]
export const SNAPSHOT_DIR = "snapshots"
export const LATEST_PATH = `${SNAPSHOT_DIR}/latest.json`
export const ANALYST_REF = "@agentproto/session-steward-analyst"

const DEFAULT_JUDGED = 40
const DEFAULT_ARCHIVE_AFTER_HOURS = 24
const DEFAULT_ARCHIVE_WINDOW_HOURS = 72
const DEFAULT_MAX_ARCHIVE = 100
const DEFAULT_MAX_HELD = 50

const num = (v, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback

/** A CSV string or list → trimmed non-empty strings, else `undefined`. */
export function csvList(v) {
  if (v === undefined || v === null || v === "") return undefined
  const list = (Array.isArray(v) ? v : String(v).split(",")).map(s => String(s).trim()).filter(Boolean)
  return list.length ? list : undefined
}

// ── inputs ───────────────────────────────────────────────────────────────

/** Inputs every step of the three workflows understands. */
export const SHARED_INPUTS = {
  idleMinutes: { type: "number", description: "Idle threshold in minutes. Default 30.", default: 30 },
  minConfidence: { type: "number", description: "Confidence needed to act on a verdict. Default: the snapshot's own (0.8)." },
  relaunchWindowMinutes: { type: "number", description: "A failed session is only recommended for `relaunch` when it failed within this many minutes (older: `mark-failed`). Default 360. Rules key: `failedMinutesAgo`.", default: 360 },
  relabelWindowHours: { type: "number", description: "Ended sessions that finished within this many hours are classified (outcome labels). Default 24.", default: 24 },
  rules: { type: "object", description: "Custom rules, already parsed (`{version:1, rules:[…]}` or a bare list). First match wins, then the defaults. Validated; unknown keys are errors." },
  rulesSource: { type: "string", description: "Where `rules` came from (a file path), for the report." },
  userOrigins: { type: "array", description: "Origins that are always flag-only, never closed. Default chat-starter, vscode.", items: { type: "string" } },
  closableOrigins: { type: "array", description: "Origins the steward may close (harness / scheduler stamps). Trailing `*` is a prefix wildcard.", items: { type: "string" } },
  callerSessionId: { type: "string", description: "The calling session's id — never a candidate." },
  callerOrigin: { type: "string", description: "The calling session's origin (`cron:<jobId>`)." },
  appId: { type: "string", description: "Installed app whose data dir persists the snapshots. Default @agentproto/session-steward." },
  persist: { type: "boolean", description: "Write the snapshot to the app data dir (`snapshots/latest.json`). Default true.", default: true },
  history: { type: "boolean", description: "Also keep `snapshots/<id>.json`. Default true; the hourly routine sets false (latest only).", default: true },
  returnSnapshot: { type: "boolean", description: "Include the whole snapshot in the run output (the CLI's --json). Default false: only counts + the report.", default: false },
  showKeep: { type: "boolean", description: "List `keep` rows in the report too. Default false (count only).", default: false },
}

export const ACT_INPUTS = {
  apply: { type: "boolean", description: "Perform the planned actions. Default false = dry run.", default: false },
  only: { type: "array", description: `Restrict to these actions (${ACTIONS.join(" | ")}). \`relaunch\` and \`archive\` only run when named here.`, items: { type: "string" } },
  sessions: { type: "array", description: "Restrict to these session ids.", items: { type: "string" } },
  allowRelaunch: { type: "boolean", description: "Let `relaunch` run without naming it in `only`. Default false.", default: false },
}

export const SNAPSHOT_INPUTS = {
  snapshot: { type: "string", description: "Snapshot id, or `latest` (default).", default: "latest" },
  snapshotData: { type: "object", description: "A whole snapshot passed inline (skips the app data read)." },
}

/** Every input of the three workflows, resolved. The base is the old steward's
 *  `resolveSettings`, pinned to its dry-run/Jev-only shape: classification never
 *  mutates and never spawns an agent judge; `act` is the only flag that does. */
export function twoStepSettings(input, modelRoles, { planning = false } = {}) {
  const i = input ?? {}
  const base = resolveSettings({ ...i, apply: false, askSessions: false, judge: "jev", maxJudged: i.maxJudged ?? DEFAULT_JUDGED }, modelRoles ?? null)
  const archiveWindowHours = num(i.archiveWindowHours, DEFAULT_ARCHIVE_WINDOW_HOURS, { min: 1 })
  return {
    ...base,
    relaunchWindowMinutes: num(i.relaunchWindowMinutes, DEFAULT_RELAUNCH_WINDOW_MINUTES, { min: 0 }),
    act: i.apply === true,
    planning: planning || i.apply === true,
    allowRelaunch: i.allowRelaunch === true,
    only: csvList(i.only),
    sessions: csvList(i.sessions),
    minConfidenceOverride: typeof i.minConfidence === "number" ? base.minConfidence : undefined,
    archiveAfterHours: num(i.archiveAfterHours, DEFAULT_ARCHIVE_AFTER_HOURS, { min: 0 }),
    archiveWindowHours,
    listWindowHours: Math.max(base.relabelWindowHours, archiveWindowHours),
    maxArchive: Math.floor(num(i.maxArchive, DEFAULT_MAX_ARCHIVE)),
    maxHeld: Math.floor(num(i.maxHeld, DEFAULT_MAX_HELD)),
    maxSessions: Math.floor(num(i.maxSessions, ANALYZE_DEFAULT_MAX, { min: 1 })),
    analyzeJudge: i.judge === "jev" ? "jev" : "agent",
    persist: i.persist !== false,
    history: i.history !== false,
    returnSnapshot: i.returnSnapshot === true,
    showKeep: i.showKeep === true,
    snapshotRef: typeof i.snapshot === "string" && i.snapshot.trim() ? i.snapshot.trim() : "latest",
    hasInlineSnapshot: i.snapshotData !== undefined && i.snapshotData !== null,
  }
}

/** Validated custom rules. The compiled `tests` closures are stripped so the
 *  step output stays plain data (they are rebuilt from `when` on demand). */
export function resolveRules(input) {
  const v = validateRules(input?.rules, typeof input?.rulesSource === "string" && input.rulesSource ? input.rulesSource : "inline")
  return { ok: v.ok, source: v.source, errors: v.errors, rules: v.rules.map(({ tests: _tests, ...r }) => r) }
}

// ── classify ─────────────────────────────────────────────────────────────

/** One evidence map item for the typed classifier: id-checked, and without the
 *  free-text judge prompt the old steward stored beside it. */
export function foldEvidenceLean(b) {
  const raw = b.steps.evidenceOne
  if (!raw || raw.sessionId !== b.item?.sessionId) {
    throw new Error(`session_evidence answered for '${raw?.sessionId}', expected '${b.item?.sessionId}'`)
  }
  return { entry: b.item, evidence: composeEvidence(b.item, raw, null) }
}

/** Jev's queue (also the judged set): the candidates whose evidence read
 *  succeeded. Kept as the only second copy of the evidence in step outputs. */
export function buildJevQueue(evidenceResult) {
  return settled(evidenceResult).ok.map(r => r.value)
}

const isLive = r => r?.status === "running" || r?.status === "starting"

/** Live rows the steward leaves alone on purpose (pinned / pty / keepAlive /
 *  busy), capped — they appear in the snapshot as `keep` with the reason. */
export function heldRowsOf(steps, settings) {
  const { sessions } = scannedRows(steps)
  const self = settings?.callerSessionId ?? null
  const rows = []
  for (const r of sessions) {
    if (!r?.id || r.id === self || !isLive(r) || r.archived === true) continue
    const why = r.pinned === true ? "pinned" : r.pty === true ? "pty" : r.keepAlive === true ? "keepAlive" : r.busy === true ? "busy" : null
    if (why) rows.push({ sessionId: r.id, label: r.label ?? r.name, origin: r.origin, reason: `${why} — never touched` })
  }
  const cap = settings?.maxHeld ?? DEFAULT_MAX_HELD
  return { rows: rows.slice(0, cap), omitted: Math.max(0, rows.length - cap), total: rows.length }
}

/** Ended sessions with an outcome already recorded, older than
 *  `archiveAfterHours` — pure clutter, recommended `archive`. */
export function archiveRowsOf(steps, settings, nowMs) {
  const { sessions } = scannedRows(steps)
  const self = settings?.callerSessionId ?? null
  const afterMs = (settings?.archiveAfterHours ?? DEFAULT_ARCHIVE_AFTER_HOURS) * 3_600_000
  const rows = []
  for (const r of sessions) {
    if (!r?.id || r.id === self || isLive(r) || r.archived === true || r.pinned === true || !r.outcome) continue
    const endedMs = Date.parse(r.endedAt ?? r.lastActivityAt ?? r.startedAt ?? "")
    if (!Number.isFinite(endedMs) || nowMs - endedMs < afterMs) continue
    rows.push({ id: r.id, label: r.label ?? r.name, origin: r.origin })
  }
  const cap = settings?.maxArchive ?? DEFAULT_MAX_ARCHIVE
  return { rows: rows.slice(0, cap), omitted: Math.max(0, rows.length - cap), total: rows.length }
}

/** `auth_profile_list` rows under any of its shapes. */
export function profilesOf(result) {
  const v = settled(result).ok[0]?.value
  const rows = Array.isArray(v) ? v : Array.isArray(v?.profiles) ? v.profiles : Array.isArray(v?.items) ? v.items : []
  return rows.filter(p => p && typeof p.id === "string")
}

function slimHost(h) {
  if (!h || typeof h !== "object") return undefined
  return {
    ...(typeof h.loadPerCore === "number" ? { loadPerCore: h.loadPerCore } : {}),
    ...(typeof h.swap?.percent === "number" ? { swapPercent: h.swap.percent } : {}),
    ...(Array.isArray(h.warnings) && h.warnings.length ? { warnings: h.warnings.slice(0, 5).map(w => w?.message ?? String(w)) } : {}),
  }
}

/** The classify snapshot, from everything the earlier steps gathered. */
export function snapshotStep(b, nowMs = Date.now()) {
  const s = b.steps.settings
  const scanned = scannedRows(b.steps)
  const jevQueue = buildJevQueue(b.steps.evidence)
  const verdicts = collectVerdicts(b.steps.evidence, jevQueue, b.steps.jevJudge, jevQueue, [], [])
  const held = b.steps.heldRows ?? { rows: [], omitted: 0, total: 0 }
  const archive = b.steps.archiveRows ?? { rows: [], omitted: 0, total: 0 }
  const snap = buildSnapshot({
    settings: s,
    rules: b.steps.rules,
    candidates: b.steps.candidatesPlus,
    verdicts,
    relabel: b.steps.relabelFinal,
    archive: archive.rows,
    held: held.rows,
    liveRows: scanned.sessions,
    profiles: profilesOf(b.steps.profilesRead),
    nowMs,
    remainingOf: remainingWorkOf,
    hostLoad: slimHost(b.steps.hostLoad),
  })
  const unjudged = verdicts.filter(v => v.source === "none").length
  return {
    ...snap,
    scan: {
      listed: scanned.sessions.length,
      truncated: scanned.truncated,
      heldOmitted: held.omitted,
      archiveOmitted: archive.omitted,
      ...(b.steps.candidatesPlus?.judgeOverflow?.length ? { judgeOverflow: b.steps.candidatesPlus.judgeOverflow.length } : {}),
      jevJudged: verdicts.length - unjudged,
      jevUnavailable: unjudged,
    },
  }
}

// ── persisting ───────────────────────────────────────────────────────────

export function snapshotPaths(id, history) {
  return history ? [LATEST_PATH, `${SNAPSHOT_DIR}/${id}.json`] : [LATEST_PATH]
}

/** `app_data_write` steps persisting `$steps.<snapKey>[.path]`. The write
 *  content is a ref, so the snapshot is never copied into a queue item. */
export function persistSteps(snapRef, getSnapshot) {
  return [
    {
      id: "persistQueue",
      kind: "transform",
      compute: b => {
        const app = b.steps.memoryApp
        const s = b.steps.settings
        const snap = getSnapshot(b)
        if (!s.persist || !app?.appId || !snap?.id) return []
        return snapshotPaths(snap.id, s.history).map(path => ({ appId: app.appId, path }))
      },
    },
    {
      id: "persist",
      kind: "map",
      over: "$steps.persistQueue",
      parallelism: 1,
      onError: "collect",
      steps: [{ id: "persistOne", kind: "tool", tool: "app_data_write", inputs: { appId: "$item.appId", path: "$item.path", content: snapRef } }],
    },
  ]
}

/** `{ ok, paths, errors, note }` for the persist map. */
export function persistedOf(b) {
  const s = b.steps.settings
  const app = b.steps.memoryApp
  const queue = b.steps.persistQueue ?? []
  if (!s.persist) return { ok: false, paths: [], errors: [], note: "not persisted (persist: false)" }
  if (!app?.appId) return { ok: false, paths: [], errors: [], note: `not persisted — ${app?.note ?? "no installed app to hold it"}` }
  const { ok, failed } = settled(b.steps.persist)
  const errors = failed.map(f => String(f.error ?? f.status))
  const bad = ok.filter(r => r.value?.isError === true || r.value?.error).map(r => String(r.value.error ?? "write failed"))
  errors.push(...bad)
  return { ok: errors.length === 0 && ok.length === queue.length, paths: queue.map(q => q.path), errors, appId: app.appId }
}

// ── reading a snapshot ───────────────────────────────────────────────────

export function snapshotReadSteps() {
  return [
    {
      id: "snapshotQueue",
      kind: "transform",
      compute: b => {
        const s = b.steps.settings
        const app = b.steps.memoryApp
        if (s.hasInlineSnapshot || !app?.appId) return []
        const path = s.snapshotRef === "latest" ? LATEST_PATH : `${SNAPSHOT_DIR}/${s.snapshotRef}.json`
        return [{ appId: app.appId, path }]
      },
    },
    {
      id: "snapshotRead",
      kind: "map",
      over: "$steps.snapshotQueue",
      parallelism: 1,
      onError: "collect",
      steps: [{ id: "snapshotReadOne", kind: "tool", tool: "app_data_read", inputs: { appId: "$item.appId", path: "$item.path" } }],
    },
    { id: "loaded", kind: "transform", compute: loadSnapshot },
  ]
}

/** The snapshot to work on: the inline one, else the persisted file. Always
 *  an object; a failure is `{ error }` (no `schema`) so callers stay total. */
export function loadSnapshot(b) {
  const s = b.steps.settings
  const inline = b.input?.snapshotData
  const check = doc => {
    if (!doc || typeof doc !== "object") return { error: "snapshot is empty or not an object" }
    if (doc.schema !== SNAPSHOT_SCHEMA) return { error: `unsupported snapshot schema ${JSON.stringify(doc.schema)} (expected ${SNAPSHOT_SCHEMA})` }
    if (!Array.isArray(doc.sessions)) return { error: "snapshot has no sessions list" }
    return doc
  }
  if (s.hasInlineSnapshot) return check(inline)
  if (!b.steps.memoryApp?.appId) return { error: `no persisted snapshot: ${b.steps.memoryApp?.note ?? "no installed app holds it"} — pass snapshotData` }
  const read = settled(b.steps.snapshotRead)
  if (read.failed.length) return { error: `could not read snapshot "${s.snapshotRef}": ${read.failed[0].error ?? read.failed[0].status}` }
  const v = read.ok[0]?.value
  if (!v || v.isError || v.error) return { error: `could not read snapshot "${s.snapshotRef}": ${v?.error ?? "no answer"}` }
  if (v.exists === false) return { error: `no snapshot "${s.snapshotRef}" — run \`agentproto steward classify\` first` }
  const doc = check(v.content)
  if (doc.error) return doc
  if (s.snapshotRef !== "latest" && doc.id !== s.snapshotRef) return { error: `snapshot file holds ${doc.id}, expected ${s.snapshotRef}` }
  return doc
}

// ── analyze ──────────────────────────────────────────────────────────────

/** Rows the analysis reads, by id (their facts stay in the snapshot). */
export function analysisSelection(b) {
  const snap = b.steps.loaded
  if (!snap?.schema) return { queue: [], overflow: 0, errors: [snap?.error ?? "no snapshot"] }
  const s = b.steps.settings
  const sel = selectForAnalysis(snap, { only: s.only, sessions: s.sessions, maxSessions: s.maxSessions, minConfidence: s.minConfidenceOverride })
  return { queue: sel.selected.map(r => ({ sessionId: r.sessionId, label: r.label, idleMinutes: r.idleMinutes, origin: r.origin })), overflow: sel.overflow, errors: sel.errors }
}

export function foldAnalysisEvidence(b) {
  const raw = b.steps.analysisEvidenceOne
  if (!raw || raw.sessionId !== b.item?.sessionId) {
    throw new Error(`session_evidence answered for '${raw?.sessionId}', expected '${b.item?.sessionId}'`)
  }
  return { sessionId: b.item.sessionId, evidence: composeEvidence({ ...b.item, signals: {} }, raw, null) }
}

const rowOf = (snap, id) => snap.sessions.find(r => r.sessionId === id)

/** The analyst's prompts: one per row whose evidence read, agent mode only. */
export function analysisPrompts(b) {
  const snap = b.steps.loaded
  if (!snap?.schema || b.steps.settings.analyzeJudge !== "agent") return []
  return settled(b.steps.analysisEvidence).ok.flatMap(r => {
    const row = rowOf(snap, r.value?.sessionId)
    return row ? [{ sessionId: row.sessionId, prompt: buildAnalyzePrompt(row, r.value.evidence) }] : []
  })
}

export function parseAnalystItem(b) {
  return { sessionId: b.item?.sessionId, ...parseAnalysis(b.steps.analystOne?.text, b.item?.sessionId) }
}

/** Fold the evidence + the analyst replies (or the heuristic) into the snapshot. */
export function analyzedStep(b, nowMs = Date.now()) {
  const snap = b.steps.loaded
  if (!snap?.schema) return snap
  const s = b.steps.settings
  const analyses = new Map()
  const ev = new Map(settled(b.steps.analysisEvidence).ok.map(r => [r.value?.sessionId, r.value?.evidence]))
  for (const f of settled(b.steps.analysisEvidence).failed) {
    const id = f.item?.sessionId
    if (id) analyses.set(id, { malformed: true, reason: `evidence failed: ${f.error ?? f.status}` })
  }
  if (s.analyzeJudge === "agent") {
    const queue = analysisPrompts(b)
    const out = settled(b.steps.analyst)
    const byIndex = new Map(out.ok.map(r => [r.index, r.value]))
    const failedByIndex = new Map(out.failed.map(r => [r.index, r]))
    queue.forEach((q, index) => {
      const v = byIndex.get(index)
      if (v && v.sessionId === q.sessionId) analyses.set(q.sessionId, v.malformed ? v : { ...v, by: "agent" })
      else analyses.set(q.sessionId, { malformed: true, reason: failedByIndex.get(index) ? `analyst failed: ${failedByIndex.get(index).error ?? failedByIndex.get(index).status}` : "analyst produced no reply" })
    })
  } else {
    for (const [id, evidence] of ev) {
      const row = rowOf(snap, id)
      if (!row) continue
      const h = heuristicAnalysis(row, evidence)
      analyses.set(id, { ...h, by: row.judgedBy && String(row.judgedBy).startsWith("jev") ? "jev" : "steward-rules" })
    }
  }
  const applied = applyAnalyses(snap, analyses, { minConfidence: s.minConfidenceOverride, by: s.analyzeJudge === "agent" ? "agent" : "steward-rules", nowMs })
  const sel = b.steps.analysisSelection
  return { ...applied.snapshot, lastAnalysis: { at: new Date(nowMs).toISOString(), by: s.analyzeJudge, analyzed: applied.analyzed, revised: applied.revised, overflow: sel?.overflow ?? 0 } }
}

// ── act ──────────────────────────────────────────────────────────────────

const EMPTY_QUEUES = () => ({ wrapup: [], label: [], archive: [], restart: [], fresh: [], prompt: [] })

function actOptions(b) {
  const s = b.steps.settings
  return { apply: s.act, only: s.only, sessions: s.sessions, rules: b.steps.rules, allowRelaunch: s.allowRelaunch, minConfidence: s.minConfidenceOverride }
}

function actBlocked(b, snap) {
  const errors = []
  if (!snap?.schema) errors.push(snap?.error ?? "no snapshot")
  if (b.steps.rules?.ok === false) errors.push(...b.steps.rules.errors.map(e => `rules: ${e}`))
  return errors
}

export function actTargetQueue(b, snapKey) {
  if (!b.steps.settings.planning) return []
  const snap = b.steps[snapKey]
  if (actBlocked(b, snap).length) return []
  return actTargets(snap, actOptions(b)).map(sessionId => ({ sessionId }))
}

/** The exact-id row out of a `session_list q=<id>` page (or none). */
export function pickLiveRow(page, sessionId) {
  const rows = Array.isArray(page?.items) ? page.items : Array.isArray(page?.sessions) ? page.sessions : []
  return rows.find(r => r?.id === sessionId) ?? null
}

export function actPlanStep(b, snapKey) {
  if (!b.steps.settings.planning) return { plan: [], queues: EMPTY_QUEUES(), errors: [] }
  const snap = b.steps[snapKey]
  const errors = actBlocked(b, snap)
  if (errors.length) return { plan: [], queues: EMPTY_QUEUES(), errors }
  const live = settled(b.steps.actLive).ok.map(r => r.value).filter(Boolean)
  return planActs(snap, live, actOptions(b))
}

export function actResultStep(b) {
  const p = b.steps.actPlan
  const maps = { wrapup: b.steps.actWrapup, label: b.steps.actLabel, archive: b.steps.actArchive, restart: b.steps.actRestart, fresh: b.steps.actFresh, prompt: b.steps.actPrompt }
  const rows = foldActResults(p.plan, p.queues, maps, explainRefusal)
  return { errors: p.errors, rows: rows.map(({ call: _call, ...r }) => r) }
}

const queueMap = (id, queue, tool, inputs, parallelism = 1) => ({
  id,
  kind: "map",
  over: `$steps.actPlan.queues.${queue}`,
  parallelism,
  onError: "collect",
  steps: [{ id: `${id}One`, kind: "tool", tool, inputs }],
})

/** The act half: look up only the planned sessions, plan, dispatch (empty
 *  unless `apply`), fold. Reads `settings`, `rules` and the snapshot step
 *  named `snapKey` from the host workflow. */
export function actSteps(snapKey) {
  return [
    { id: "actTargets", kind: "transform", compute: b => actTargetQueue(b, snapKey) },
    {
      id: "actLive",
      kind: "map",
      over: "$steps.actTargets",
      parallelism: 8,
      onError: "collect",
      steps: [
        { id: "actLiveOne", kind: "tool", tool: "session_list", inputs: { q: "$item.sessionId", fields: LIVE_FIELDS, limit: 10, includeArchived: true } },
        { id: "actLivePick", kind: "transform", compute: b => pickLiveRow(b.steps.actLiveOne, b.item?.sessionId) },
      ],
    },
    { id: "actPlan", kind: "transform", compute: b => actPlanStep(b, snapKey) },
    queueMap("actWrapup", "wrapup", "session_wrapup_apply", {
      sessionIds: ["$item.sessionId"],
      verdict: "$item.verdict",
      judgedBy: "$item.judgedBy",
      note: "$item.note",
      reason: "$item.reason",
      question: "$item.question",
      errorKind: "$item.errorKind",
      nextStep: "$item.nextStep",
      by: "$item.by",
      wait: true,
    }),
    queueMap("actLabel", "label", "agent_kill", { sessionId: "$item.sessionId", outcome: "$item.outcome" }),
    queueMap("actArchive", "archive", "session_archive", { idOrName: "$item.idOrName" }),
    queueMap("actRestart", "restart", "session_restart", { idOrName: "$item.idOrName" }),
    queueMap("actFresh", "fresh", "session_continue_fresh", { idOrName: "$item.idOrName", access: "$item.access", askSource: "$item.askSource" }),
    queueMap("actPrompt", "prompt", "agent_prompt", { sessionId: "$item.sessionId", prompt: "$item.prompt" }),
    { id: "actResult", kind: "transform", compute: actResultStep },
  ]
}

// ── reports ──────────────────────────────────────────────────────────────

export function classifyReport(b) {
  const snap = b.steps.snapshot
  const s = b.steps.settings
  const lines = [renderSnapshot(snap, { showKeep: s.showKeep })]
  const notes = []
  for (const l of saturationHeader(b.steps.hostLoad)) notes.push(l)
  if (b.steps.rules?.ok === false) notes.push(`- RULES IGNORED (${b.steps.rules.source}) — fix and re-run: ${b.steps.rules.errors.join("; ")}`)
  if (snap.scan.jevUnavailable > 0) {
    notes.push(`- ${snap.scan.jevUnavailable} candidate(s) were not judged (Jev unavailable: no JEV_API_KEY, or the call failed) — the rules classified what they could; run \`steward analyze\` for the rest.`)
  }
  if (snap.scan.judgeOverflow) notes.push(`- ${snap.scan.judgeOverflow} judge-class candidate(s) over maxJudged ${s.maxJudged} were not classified this pass.`)
  if (snap.scan.truncated) notes.push("- the session listing was truncated at 600 rows per query — older sessions are not in this snapshot.")
  if (snap.scan.heldOmitted || snap.scan.archiveOmitted) notes.push(`- omitted from the snapshot: ${snap.scan.heldOmitted} held, ${snap.scan.archiveOmitted} archivable (caps maxHeld ${s.maxHeld}, maxArchive ${s.maxArchive}).`)
  const p = persistedOf(b)
  notes.push(p.ok ? `- snapshot saved: ${p.paths.join(", ")} (app ${p.appId})` : `- ${p.note ?? `snapshot NOT saved: ${p.errors.join("; ")}`}`)
  if (notes.length) lines.push("", ...notes)
  lines.push("", `Next: \`agentproto steward analyze ${snap.id}\` (LLM reasons) · \`agentproto steward act ${snap.id}\` (dry run) · \`agentproto steward act ${snap.id} --apply\``)
  if (s.planning) lines.push("", renderPlan(snap.id, b.steps.actResult.rows, { apply: s.act, errors: b.steps.actResult.errors, rulesSource: b.steps.rules.source }))
  return lines.join("\n")
}

export function analyzeReport(b) {
  const snap = b.steps.analyzed
  const s = b.steps.settings
  if (!snap?.schema) return `# Session steward — analyze\n\n- ERROR: ${snap?.error ?? "no snapshot"}`
  const lines = [renderSnapshot(snap, { showKeep: s.showKeep })]
  const la = snap.lastAnalysis
  lines.push("", `- analysis (${la.by}): ${la.analyzed} session(s) analysed, ${la.revised} action(s) revised${la.overflow ? `, ${la.overflow} more over maxSessions ${s.maxSessions}` : ""}`)
  const failed = snap.sessions.filter(r => r.analysisError)
  for (const r of failed.slice(0, 10)) lines.push(`- ${r.label ?? r.sessionId}: ${r.analysisError} (kept the classify action)`)
  const p = persistedOf(b)
  lines.push(p.ok ? `- snapshot updated: ${p.paths.join(", ")}` : `- ${p.note ?? `snapshot NOT saved: ${p.errors.join("; ")}`}`)
  lines.push("", `Next: \`agentproto steward act ${snap.id}\` (dry run)`)
  return lines.join("\n")
}

export function actReport(b) {
  const snap = b.steps.loaded
  const r = b.steps.actResult
  const s = b.steps.settings
  return renderPlan(snap?.id ?? s.snapshotRef, r.rows, { apply: s.act, errors: r.errors, rulesSource: b.steps.rules.source })
}

export { ACTION_INFO }

// ── step graphs ──────────────────────────────────────────────────────────

const mapOver = (id, over, parallelism, steps) => ({ id, kind: "map", over, parallelism, onError: "collect", steps })

const rulesStep = { id: "rules", kind: "transform", compute: b => resolveRules(b.input) }

const memoryAppSteps = [
  { id: "installedApps", kind: "tool", tool: "app_list", inputs: {} },
  { id: "memoryApp", kind: "transform", compute: b => resolveMemoryApp(b.steps.settings, b.steps.installedApps) },
]

/** Step 1 — rules + the Jev typed classifier over a projected, paged scan.
 *  With `apply` it continues into the act half (one-shot `steward --apply`). */
export function classifySteps() {
  return [
    { id: "settings", kind: "transform", compute: b => twoStepSettings(b.input, null) },
    rulesStep,
    { id: "plan", kind: "tool", tool: "session_wrapup_plan", inputs: { idleMinutes: "$steps.settings.idleMinutes", wait: true } },
    { id: "candidates", kind: "transform", compute: b => splitCandidates(b.steps.plan, b.steps.settings) },
    { id: "hostLoad", kind: "tool", tool: "host_load", inputs: {} },
    ...liveListSteps(),
    { id: "scan", kind: "transform", compute: b => scanListed(b.steps, b.steps.settings, Date.now()) },
    { id: "candidatesPlus", kind: "transform", compute: b => demoteErroredCloses(mergeNeverRan(b.steps.candidates, b.steps.scan), b.steps.scan) },
    { id: "relabelQueue", kind: "transform", compute: b => buildRelabelQueue(b.steps.scan) },
    { id: "relabelEvidenceQueue", kind: "transform", compute: b => buildRelabelEvidenceQueue(b.steps.relabelQueue) },
    mapOver("relabelEvidence", "$steps.relabelEvidenceQueue", 4, [
      { id: "relabelEvidenceOne", kind: "tool", tool: "session_evidence", inputs: { sessionId: "$item.sessionId" } },
      { id: "relabelEvidenceFold", kind: "transform", compute: foldRelabelEvidence },
    ]),
    { id: "relabelFinal", kind: "transform", compute: b => applyRelabelEvidence(b.steps.relabelQueue, b.steps.relabelEvidence) },
    mapOver("evidence", "$steps.candidatesPlus.judge", 4, [
      { id: "evidenceOne", kind: "tool", tool: "session_evidence", inputs: { sessionId: "$item.sessionId" } },
      { id: "evidenceFold", kind: "transform", compute: foldEvidenceLean },
    ]),
    { id: "jevQueue", kind: "transform", compute: b => buildJevQueue(b.steps.evidence) },
    mapOver("jevJudge", "$steps.jevQueue", 4, [
      { id: "jevOne", kind: "tool", tool: "session_judge_jev", inputs: { sessionId: "$item.entry.sessionId", evidence: "$item.evidence", model: "$steps.settings.jevModel" } },
    ]),
    { id: "archiveRows", kind: "transform", compute: b => archiveRowsOf(b.steps, b.steps.settings, Date.now()) },
    { id: "heldRows", kind: "transform", compute: b => heldRowsOf(b.steps, b.steps.settings) },
    { id: "profilesQueue", kind: "transform", compute: () => [{}] },
    mapOver("profilesRead", "$steps.profilesQueue", 1, [
      { id: "profilesReadOne", kind: "tool", tool: "auth_profile_list", inputs: { fields: PROFILE_FIELDS, limit: 200 } },
    ]),
    ...memoryAppSteps,
    { id: "snapshot", kind: "transform", compute: b => snapshotStep(b, Date.now()) },
    ...persistSteps("$steps.snapshot", b => b.steps.snapshot),
    ...actSteps("snapshot"),
    { id: "report", kind: "transform", compute: classifyReport },
    { id: "summary", kind: "transform", compute: classifySummary },
  ]
}

export const CLASSIFY_RESULT = {
  report: "$steps.report",
  summary: "$steps.summary",
}

/** Step 2 — the LLM pass over the relevant sessions only. Never acts. */
export function analyzeSteps() {
  return [
    { id: "modelRoles", kind: "tool", tool: "model_roles", inputs: { roles: ["judge.session"], inputs: { "judge.session": "$input.judgeModel" } } },
    { id: "settings", kind: "transform", compute: b => twoStepSettings(b.input, b.steps.modelRoles) },
    rulesStep,
    ...memoryAppSteps,
    ...snapshotReadSteps(),
    { id: "analysisSelection", kind: "transform", compute: analysisSelection },
    mapOver("analysisEvidence", "$steps.analysisSelection.queue", 4, [
      { id: "analysisEvidenceOne", kind: "tool", tool: "session_evidence", inputs: { sessionId: "$item.sessionId" } },
      { id: "analysisEvidenceFold", kind: "transform", compute: foldAnalysisEvidence },
    ]),
    { id: "analysisPrompts", kind: "transform", compute: analysisPrompts },
    mapOver("analyst", "$steps.analysisPrompts", 3, [
      { id: "analystOne", kind: "agent", agent: { ref: ANALYST_REF }, prompt: "$item.prompt", model: b => b.steps.settings?.judgeModel },
      { id: "analystParse", kind: "transform", compute: parseAnalystItem },
    ]),
    { id: "analyzed", kind: "transform", compute: b => analyzedStep(b, Date.now()) },
    ...persistSteps("$steps.analyzed", b => b.steps.analyzed),
    { id: "report", kind: "transform", compute: analyzeReport },
    { id: "summary", kind: "transform", compute: analyzeSummary },
  ]
}

export const ANALYZE_RESULT = {
  report: "$steps.report",
  summary: "$steps.summary",
}

/** Step 3 — apply a persisted snapshot by the rules (dry run unless `apply`). */
export function actWorkflowSteps() {
  return [
    { id: "settings", kind: "transform", compute: b => twoStepSettings(b.input, null, { planning: true }) },
    rulesStep,
    ...memoryAppSteps,
    ...snapshotReadSteps(),
    ...actSteps("loaded"),
    { id: "report", kind: "transform", compute: actReport },
    { id: "summary", kind: "transform", compute: actSummary },
  ]
}

export const ACT_RESULT = {
  report: "$steps.report",
  summary: "$steps.summary",
  plan: "$steps.actResult",
}

// ── summaries (what `--json` and the routine see) ────────────────────────

const countRows = rows => {
  const out = {}
  for (const r of rows ?? []) out[r.action] = (out[r.action] ?? 0) + 1
  return out
}

/** `planned | kept | skipped` from the plan, `applied | refused` once a daemon verb ran. */
export const rowStatus = r => (r.result ? (r.result.ok ? "applied" : "refused") : r.status)

const statusCounts = rows => {
  const out = {}
  for (const r of rows ?? []) out[rowStatus(r)] = (out[rowStatus(r)] ?? 0) + 1
  return out
}

/** Small, stable run output — never the session rows themselves unless the
 *  caller asked (`returnSnapshot`). */
export function classifySummary(b) {
  const snap = b.steps.snapshot
  const s = b.steps.settings
  return {
    snapshotId: snap.id,
    createdAt: snap.createdAt,
    sessions: snap.sessions.length,
    counts: snap.counts,
    scan: snap.scan,
    persisted: persistedOf(b),
    rules: { source: b.steps.rules.source, ok: b.steps.rules.ok, errors: b.steps.rules.errors },
    act: s.planning ? { apply: s.act, statuses: statusCounts(b.steps.actResult.rows), errors: b.steps.actResult.errors } : undefined,
    ...(s.returnSnapshot ? { snapshot: snap } : {}),
  }
}

export function analyzeSummary(b) {
  const snap = b.steps.analyzed
  const s = b.steps.settings
  if (!snap?.schema) return { error: snap?.error ?? "no snapshot" }
  return {
    snapshotId: snap.id,
    counts: countRows(snap.sessions),
    analysis: snap.lastAnalysis,
    persisted: persistedOf(b),
    ...(s.returnSnapshot ? { snapshot: snap } : {}),
  }
}

export function actSummary(b) {
  const r = b.steps.actResult
  const s = b.steps.settings
  return {
    snapshotId: b.steps.loaded?.id ?? s.snapshotRef,
    apply: s.act,
    statuses: statusCounts(r.rows),
    actions: countRows(r.rows.filter(x => x.status === "planned")),
    errors: r.errors,
    rows: r.rows.map(x => ({ ...x, status: rowStatus(x) })),
  }
}
