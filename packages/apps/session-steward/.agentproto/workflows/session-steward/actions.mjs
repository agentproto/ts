// Pure logic behind the two-step steward: `classify` (snapshot at time T, one
// recommended action per session), `analyze` (an LLM/heuristic pass that
// writes reason/question/errorKind/nextStep into the snapshot) and `act`
// (apply the recommendations, with a staleness re-check and origin bounds).
//
// Everything here is a plain function over plain data — no tool calls — so the
// vocabulary, the rules matcher, the staleness re-check and the act planner are
// unit-tested with fixtures (`session-steward-actions.test.ts`). The workflows
// (`session-steward-classify|analyze|act`) wire these over the daemon's verbs.

import { classifyOrigin } from "./origin-policy.mjs"

// ── vocabulary ───────────────────────────────────────────────────────────

/** The closed set of recommended actions. */
export const ACTIONS = ["keep", "mark-complete", "mark-failed", "relaunch", "needs-input", "close-abandoned", "archive"]

export const ACTION_INFO = {
  keep: "leave alone — active, busy, pinned/keepAlive, or not confident enough to act",
  "mark-complete": "done, nothing pending (the remaining-work check applies) — records outcome `done`",
  "mark-failed": "ended or stuck on a non-transient error — records outcome `failed`",
  relaunch: "failed on a TRANSIENT cause (quota, upstream, timeout, crash) — continue it or restart it on another profile",
  "needs-input": "waiting on a human / blocked — flags the session and surfaces the question",
  "close-abandoned": "never ran, orphaned or superseded, no value — records outcome `abandoned`",
  archive: "already ended with an outcome recorded — just clutter, hide it from the default list",
}

/** Actions that only act when the caller names them in `--only`: they spawn
 *  new work (relaunch) or change what the operator sees (archive). */
export const OPT_IN_ACTIONS = ["relaunch", "archive"]

export const ERROR_KINDS = ["quota", "upstream", "timeout", "crash", "logic", "none"]
export const TRANSIENT_ERROR_KINDS = ["quota", "upstream", "timeout", "crash"]
export const OUTCOME_VERDICTS = ["done", "failed", "abandoned", "needs-input"]
export const OUTCOME_BY = ["steward-rules", "jev", "agent", "user"]
export const SNAPSHOT_SCHEMA = "steward-snapshot/v1"
export const RULES_JUDGE = "steward-rules"

const ACTION_TO_VERDICT = {
  "mark-complete": "done",
  "mark-failed": "failed",
  "close-abandoned": "abandoned",
  "needs-input": "needs-input",
}

// ── error classification ─────────────────────────────────────────────────

const ERROR_PATTERNS = [
  ["quota", /usage limit|quota|rate.?limit|429|credit|insufficient|billing|out of (?:extra )?usage|exhaust|too many requests|limit reached|plan limit/i],
  ["timeout", /timed? ?out|timeout|etimedout|deadline exceeded|no output|\bstall(?:ed)?\b/i],
  ["upstream", /overloaded|529|503|502|504|unavailable|bad gateway|econnreset|econnrefused|enotfound|socket hang up|network|upstream|internal server error|\b500\b|temporarily/i],
  ["crash", /daemon restart|restart(?:ed)?|crash|sigkill|sigterm|killed|exited unexpectedly|interrupted|\boom\b|out of memory|segfault/i],
]

/** Free-text error → `{ kind, transient, wallet? }`. `wallet` is the auth
 *  profile ref the daemon tags provider-limit errors with (`[wallet: profile
 *  "<ref>" …]`). No text ⇒ `{ kind: "none" }`; unmatched text ⇒ `logic`. */
export function classifyError(message) {
  const text = typeof message === "string" ? message.trim() : ""
  if (!text) return { kind: "none", transient: false }
  const wallet = text.match(/\[wallet: profile "([^"]+)"/)?.[1]
  for (const [kind, re] of ERROR_PATTERNS) {
    if (re.test(text)) return { kind, transient: true, ...(wallet ? { wallet } : {}) }
  }
  return { kind: "logic", transient: false }
}

/** A model that only exists on a free tier (`…:free`, `…-free`, `free/…`): a
 *  relaunch must never land it on a metered profile. */
export function isFreeOnlyModel(model) {
  return typeof model === "string" && /(^|[:/_-])free($|[:/_-])/i.test(model)
}

// ── glob + numeric matchers ──────────────────────────────────────────────

/** `*` (any run, including `/`) and `?` (one char) glob; anchored. */
export function globMatch(pattern, text, { caseInsensitive = true } = {}) {
  if (typeof pattern !== "string" || typeof text !== "string") return false
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*").replace(/\?/g, ".")}$`,
    caseInsensitive ? "is" : "s",
  )
  return re.test(text)
}

/** `120`, `">=120"`, `"<30"`, `"10..60"`, `{min,max}` → a predicate, or an
 *  error string. A bare number means "at least". */
export function parseNumeric(spec) {
  if (typeof spec === "number" && Number.isFinite(spec)) return { test: n => n >= spec }
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    const keys = Object.keys(spec)
    if (keys.length === 0 || keys.some(k => k !== "min" && k !== "max")) return { error: "expected {min, max}" }
    const { min, max } = spec
    if ((min !== undefined && typeof min !== "number") || (max !== undefined && typeof max !== "number")) return { error: "min/max must be numbers" }
    return { test: n => (min === undefined || n >= min) && (max === undefined || n <= max) }
  }
  if (typeof spec === "string") {
    const s = spec.trim()
    const range = s.match(/^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/)
    if (range) return { test: n => n >= Number(range[1]) && n <= Number(range[2]) }
    const cmp = s.match(/^(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/)
    if (cmp) {
      const v = Number(cmp[2])
      const ops = { ">=": n => n >= v, "<=": n => n <= v, ">": n => n > v, "<": n => n < v, "=": n => n === v }
      return { test: ops[cmp[1]] }
    }
  }
  return { error: `cannot read ${JSON.stringify(spec)} as a number test (use 120, ">=120", "<30", "10..60" or {min,max})` }
}

// ── rules ────────────────────────────────────────────────────────────────

/** `when` keys and how each matches the session's facts. */
export const WHEN_KEYS = {
  origin: "glob",
  label: "glob",
  cwd: "glob",
  model: "glob",
  profile: "glob",
  class: "enum",
  state: "enum",
  verdict: "enum",
  errorKind: "enum",
  action: "enum",
  idleMinutes: "number",
  confidence: "number",
  originClass: "enum",
  transient: "bool",
  errored: "bool",
  neverRan: "bool",
  remainingWork: "bool",
  confident: "bool",
}
const ENUM_VALUES = {
  class: ["held", "close", "stuck", "judge", "terminal", "archive"],
  state: ["live", "ended"],
  verdict: ["done", "abandoned", "blocked", "needs-input", "active", "unknown", "needs-follow-up"],
  errorKind: ERROR_KINDS,
  action: ACTIONS,
  originClass: ["user", "closable", "other"],
}
const RULE_KEYS = ["id", "when", "action", "reason"]
const TOP_KEYS = ["version", "rules"]

/**
 * Validate a rules document (already parsed from YAML/JSON). Unknown keys,
 * bad values and unknown actions are ERRORS (a typo must never silently turn
 * a rule off). Returns `{ ok, rules, errors, source }`; `rules` is empty when
 * `ok` is false so a caller can never act on a half-valid file.
 */
export function validateRules(raw, source = "inline") {
  const errors = []
  if (raw === undefined || raw === null) return { ok: true, rules: [], errors, source: "none" }
  let list
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === "object") {
    for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) errors.push(`unknown top-level key "${k}" (allowed: ${TOP_KEYS.join(", ")})`)
    if (raw.version !== undefined && raw.version !== 1) errors.push(`unsupported version ${JSON.stringify(raw.version)} (expected 1)`)
    list = raw.rules
    if (list === undefined) list = []
  } else {
    return { ok: false, rules: [], errors: ["rules must be an object with a `rules` list (or a bare list)"], source }
  }
  if (!Array.isArray(list)) return { ok: false, rules: [], errors: [...errors, "`rules` must be a list"], source }
  const rules = []
  const seen = new Set()
  list.forEach((r, i) => {
    const at = `rules[${i}]${r && typeof r.id === "string" ? ` (${r.id})` : ""}`
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      errors.push(`${at}: must be an object`)
      return
    }
    for (const k of Object.keys(r)) if (!RULE_KEYS.includes(k)) errors.push(`${at}: unknown key "${k}" (allowed: ${RULE_KEYS.join(", ")})`)
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : `rule-${i + 1}`
    if (seen.has(id)) errors.push(`${at}: duplicate id "${id}"`)
    seen.add(id)
    if (r.action !== "skip" && !ACTIONS.includes(r.action)) {
      errors.push(`${at}: action ${JSON.stringify(r.action)} must be "skip" or one of ${ACTIONS.join(", ")}`)
    }
    if (r.reason !== undefined && typeof r.reason !== "string") errors.push(`${at}: reason must be a string`)
    const when = r.when === undefined ? {} : r.when
    if (!when || typeof when !== "object" || Array.isArray(when)) {
      errors.push(`${at}: when must be an object`)
      return
    }
    if (r.when === undefined || Object.keys(when).length === 0) errors.push(`${at}: empty \`when\` would match every session — name at least one condition`)
    const tests = []
    for (const [k, v] of Object.entries(when)) {
      const kind = WHEN_KEYS[k]
      if (!kind) {
        errors.push(`${at}: unknown when key "${k}" (allowed: ${Object.keys(WHEN_KEYS).join(", ")})`)
        continue
      }
      const t = compileCondition(k, kind, v)
      if (t.error) errors.push(`${at}: when.${k}: ${t.error}`)
      else tests.push([k, t.test])
    }
    rules.push({ id, when, action: r.action, ...(typeof r.reason === "string" ? { reason: r.reason } : {}), tests })
  })
  const ok = errors.length === 0
  return { ok, rules: ok ? rules : [], errors, source }
}

function compileCondition(key, kind, v) {
  const alts = Array.isArray(v) ? v : [v]
  if (alts.length === 0) return { error: "empty list" }
  if (kind === "bool") {
    if (typeof v !== "boolean") return { error: "expected true or false" }
    return { test: f => Boolean(f[key]) === v }
  }
  if (kind === "number") {
    const preds = alts.map(parseNumeric)
    const bad = preds.find(p => p.error)
    if (bad) return { error: bad.error }
    return { test: f => typeof f[key] === "number" && preds.some(p => p.test(f[key])) }
  }
  if (!alts.every(a => typeof a === "string" && a.length > 0)) return { error: "expected a string (or a list of strings)" }
  if (kind === "enum") {
    const allowed = ENUM_VALUES[key]
    const bad = alts.find(a => !allowed.includes(a))
    if (bad !== undefined) return { error: `${JSON.stringify(bad)} is not one of ${allowed.join(", ")}` }
    return { test: f => alts.includes(f[key]) }
  }
  const sensitive = key === "cwd"
  return { test: f => typeof f[key] === "string" && alts.some(a => globMatch(a, f[key], { caseInsensitive: !sensitive })) }
}

/** First rule whose every condition matches the facts, else `null`. */
export function matchRule(rules, facts) {
  for (const r of rules ?? []) {
    const tests = r.tests ?? compileTests(r)
    if (tests.length > 0 && tests.every(([, t]) => t(facts))) return r
  }
  return null
}

function compileTests(rule) {
  const out = []
  for (const [k, v] of Object.entries(rule.when ?? {})) {
    const kind = WHEN_KEYS[k]
    const c = kind ? compileCondition(k, kind, v) : { error: "unknown" }
    if (!c.error) out.push([k, c.test])
  }
  return out
}

/** The default policy, as data — the same condition language as a custom
 *  rules file, evaluated after it (first match wins). */
export const DEFAULT_POLICY = [
  { id: "held", when: { class: "held" }, action: "keep", reason: "pinned / keepAlive / busy / pty — never touched" },
  { id: "archive-ended", when: { class: "archive" }, action: "archive", reason: "ended with an outcome recorded — clutter" },
  { id: "transient-error", when: { transient: true }, action: "relaunch", reason: "last turn failed on a transient cause" },
  { id: "errored", when: { errored: true }, action: "mark-failed", reason: "last turn errored (non-transient)" },
  { id: "never-ran", when: { neverRan: true }, action: "close-abandoned", reason: "0 tokens in/out — never ran" },
  { id: "close-remaining-work", when: { class: "close", remainingWork: true }, action: "needs-input", reason: "rule-certain done, but work remains" },
  { id: "close-rules", when: { class: "close" }, action: "mark-complete", reason: "rule-certain done (parent ended / worktree merged / finished)" },
  { id: "terminal-merged", when: { class: "terminal", verdict: "done" }, action: "mark-complete", reason: "ended, its PR is merged" },
  { id: "terminal-abandoned", when: { class: "terminal", verdict: "abandoned" }, action: "close-abandoned", reason: "ended without a PR or a completed turn" },
  { id: "judge-done-remaining", when: { class: "judge", verdict: "done", confident: true, remainingWork: true }, action: "needs-input", reason: "judged done but work remains" },
  { id: "judge-done", when: { class: "judge", verdict: "done", confident: true }, action: "mark-complete", reason: "judged done" },
  { id: "judge-abandoned", when: { class: "judge", verdict: "abandoned", confident: true }, action: "close-abandoned", reason: "judged abandoned" },
  { id: "judge-waiting", when: { class: "judge", verdict: ["needs-input", "blocked"], confident: true }, action: "needs-input", reason: "judged waiting on someone" },
  { id: "fallthrough", when: { class: ["held", "close", "stuck", "judge", "terminal", "archive"] }, action: "keep", reason: "active, or not confident enough to act" },
]

const COMPILED_DEFAULTS = validateRules({ version: 1, rules: DEFAULT_POLICY }, "defaults").rules

// ── decisions ────────────────────────────────────────────────────────────

const CLOSING_ACTIONS = new Set(["mark-complete", "mark-failed", "close-abandoned", "relaunch", "archive"])

/** Origin bound: a user-origin LIVE session is never closed or killed — every
 *  closing action becomes a `needs-input` flag. An ENDED user-origin session
 *  has nothing left to close, so outcome labels stand (it can only be labelled),
 *  but it is never relaunched or archived. */
export function boundByOrigin(action, facts) {
  if (facts.originClass !== "user" || !CLOSING_ACTIONS.has(action)) return { action, bound: false }
  if (facts.state === "live") return { action: "needs-input", bound: true, boundFrom: action }
  if (action === "relaunch") return { action: "mark-failed", bound: true, boundFrom: action }
  if (action === "archive") return { action: "keep", bound: true, boundFrom: action }
  return { action, bound: false }
}

/** Custom rules first, then the defaults; the origin bound last. */
export function decideAction(facts, customRules = []) {
  const custom = matchRule(customRules, facts)
  let chosen
  if (custom) {
    chosen = { action: custom.action, ruleId: custom.id, source: "custom", reason: custom.reason ?? `custom rule ${custom.id}` }
  } else {
    const d = matchRule(COMPILED_DEFAULTS, facts) ?? { id: "fallthrough", action: "keep", reason: "no rule matched" }
    chosen = { action: d.action, ruleId: d.id, source: "default", reason: d.reason }
  }
  if (chosen.action === "skip") return { ...chosen, action: "keep", skipped: true }
  const b = boundByOrigin(chosen.action, facts)
  if (!b.bound) return chosen
  return { ...chosen, action: b.action, bound: true, boundFrom: b.boundFrom, reason: `${chosen.reason} — user origin: ${b.boundFrom} → ${b.action}` }
}

// ── relaunch hint ────────────────────────────────────────────────────────

/** Another profile of the same provider (billing endpoint) that is not
 *  exhausted, for a quota failure. Never a metered profile for a free-only
 *  model. `exhausted` is the set of profile refs known to be out of quota. */
export function suggestProfile({ failedProfile, model, profiles, exhausted }) {
  const list = Array.isArray(profiles) ? profiles : []
  const failed = list.find(p => p?.id === failedProfile)
  if (!failed) return { reason: failedProfile ? `profile "${failedProfile}" not in the profile list` : "the session carries no named profile" }
  const out = exhausted instanceof Set ? exhausted : new Set(exhausted ?? [])
  const freeOnly = isFreeOnlyModel(model)
  const candidates = list.filter(p => {
    if (!p || p.id === failed.id || p.disabled === true || out.has(p.id)) return false
    if (p.endpoint !== failed.endpoint) return false
    if (p.keyStatus === "unavailable") return false
    if (freeOnly && p.method === "api-key") return false
    return true
  })
  if (candidates.length === 0) {
    return { reason: `no other non-exhausted ${failed.endpoint} profile${freeOnly ? " that is free-tier safe" : ""}` }
  }
  candidates.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return { profileRef: candidates[0].id, endpoint: failed.endpoint, reason: `same provider (${failed.endpoint}), not exhausted` }
}

/** `relaunchHint` for a transient failure: `continue` (resume the same
 *  session) or `fresh` (a new session on another profile) — `deferred` when
 *  the quota is exhausted everywhere and retrying now would just fail again. */
export function relaunchHintFor(facts, { profiles, exhausted } = {}) {
  if (facts.errorKind !== "quota") {
    return { mode: "continue", why: `${facts.errorKind} error is transient — resume the same session` }
  }
  const s = suggestProfile({ failedProfile: facts.walletProfile ?? facts.profile, model: facts.model, profiles, exhausted })
  if (s.profileRef) return { mode: "fresh", profileRef: s.profileRef, why: `quota on "${facts.walletProfile ?? facts.profile}" → ${s.reason}` }
  return { mode: "continue", deferred: true, why: `quota exhausted and ${s.reason} — retry after the limit resets` }
}

// ── snapshot ─────────────────────────────────────────────────────────────

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

function cut(text, max) {
  if (typeof text !== "string") return undefined
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

function errorTextOf(row, evidence) {
  return row?.lastTurnErrorMessage ?? evidence?.lastTurnError ?? (row?.status === "error" ? row?.lastError : undefined)
}

function ymdhms(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
}

export function newSnapshotId(nowMs, suffix) {
  const s = suffix ?? Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")
  return `snap_${ymdhms(nowMs)}_${s}`
}

/** The facts a session is matched on. `row` is the `session_list` row (any
 *  of it may be missing), `item` carries the classification. */
export function makeFacts({ cls, state, row, entry, verdict, confidence, evidence, settings, neverRan, remainingWork }) {
  const idle = num(entry?.idleMinutes) ?? num(row?.idleMinutes)
  const errText = errorTextOf(row, evidence)
  const errored = Boolean(row?.lastTurnErroredAt) || (state === "ended" && row?.status === "error" && Boolean(errText))
  const err = errored ? classifyError(errText) : { kind: "none", transient: false }
  const errorKind = errored && err.kind === "none" ? "logic" : err.kind
  const originSource = row ?? entry ?? {}
  const min = settings?.minConfidence ?? 0.8
  return {
    sessionId: row?.id ?? entry?.sessionId,
    label: row?.label ?? row?.name ?? entry?.label,
    origin: row?.origin ?? entry?.origin,
    originClass: classifyOrigin(originSource, { userOrigins: settings?.userOrigins, closableOrigins: settings?.closableOrigins }),
    cwd: row?.cwd,
    model: row?.model,
    profile: row?.accessProfile?.profileRef,
    walletProfile: err.wallet,
    class: cls,
    state,
    status: row?.status,
    idleMinutes: idle,
    verdict,
    confidence,
    confident: typeof confidence === "number" && confidence >= min,
    errored,
    errorKind,
    transient: errored && err.transient,
    errorText: cut(errText, 300),
    neverRan: neverRan === true,
    remainingWork: remainingWork === true,
    tokensIn: num(row?.tokensIn),
    tokensOut: num(row?.tokensOut),
  }
}

/** One compact line of why a session is where it is, for the table. */
export function evidenceSummary(f) {
  const parts = []
  if (f.state === "live") parts.push(`idle ${Math.round(f.idleMinutes ?? 0)}m`)
  if (f.tokensIn !== undefined || f.tokensOut !== undefined) parts.push(`${f.tokensIn ?? 0}/${f.tokensOut ?? 0} tok`)
  if (f.neverRan) parts.push("never ran")
  if (f.errored) parts.push(`error ${f.errorKind}${f.errorText ? `: ${cut(f.errorText, 60)}` : ""}`)
  if (f.remainingWork) parts.push("work remains")
  return parts.join(" · ")
}

/**
 * Build the snapshot from this pass's classification inputs.
 *
 * - `candidates` — `{close, stuck, judge, judgeOverflow}` plan entries
 * - `verdicts`  — Jev rows from `collectVerdicts` (`{entry, verdict,
 *   confidence, probabilities, source, judgedBy, reason}`)
 * - `relabel`   — terminal-session-without-outcome proposals
 * - `archive`   — ended sessions with an outcome (`session_list` rows)
 * - `held`      — live rows deliberately left alone (`{sessionId, reason}`) plus busy rows
 * - `liveRows`  — `session_list` rows by id
 */
export function buildSnapshot(input) {
  const { settings, rules, candidates, verdicts, relabel, archive, held, liveRows, profiles, nowMs, remainingOf, hostLoad } = input
  const byId = new Map((liveRows ?? []).map(r => [r.id, r]))
  const customRules = rules?.rules ?? []
  const rows = []
  const seen = new Set()
  const add = (cls, state, entry, extra = {}) => {
    const id = entry.sessionId
    if (!id || seen.has(id)) return
    seen.add(id)
    const row = byId.get(id)
    const facts = makeFacts({ cls, state, row, entry, settings, ...extra })
    rows.push({ id, entry, row, facts, extra })
  }
  for (const e of candidates?.close ?? []) add("close", "live", e, { verdict: "done", confidence: 1, remainingWork: (remainingOf?.(e) ?? []).length > 0 })
  for (const e of candidates?.stuck ?? []) add("stuck", "live", e, { verdict: "abandoned", confidence: 1, neverRan: true })
  for (const v of verdicts ?? []) {
    if (!v?.entry?.sessionId) continue
    add("judge", "live", v.entry, {
      verdict: v.malformed || v.source === "none" ? undefined : v.verdict,
      confidence: v.malformed || v.source === "none" ? undefined : v.confidence,
      evidence: v.evidence,
      remainingWork: (remainingOf?.(v.entry) ?? []).length > 0,
      judged: v,
    })
  }
  for (const e of candidates?.judgeOverflow ?? []) add("judge", "live", e, { remainingWork: (remainingOf?.(e) ?? []).length > 0 })
  for (const r of relabel ?? []) {
    add("terminal", "ended", { sessionId: r.sessionId, label: r.label, origin: r.origin }, { verdict: r.proposedVerdict, confidence: r.proposedVerdict === "unknown" ? undefined : 1, relabel: r })
  }
  for (const h of held ?? []) add("held", "live", { sessionId: h.sessionId, label: h.label, origin: h.origin }, { held: h })
  for (const a of archive ?? []) add("archive", "ended", { sessionId: a.id, label: a.label ?? a.name, origin: a.origin }, {})

  const exhausted = new Set(rows.filter(r => r.facts.errorKind === "quota").map(r => r.facts.walletProfile ?? r.facts.profile).filter(Boolean))
  const sessions = rows.map(({ id, row, facts, extra }) => {
    const decision = decideAction(facts, customRules)
    const hint = decision.action === "relaunch" || (decision.boundFrom === "relaunch") ? relaunchHintFor(facts, { profiles, exhausted }) : undefined
    const j = extra.judged
    const why = extra.relabel?.reason ?? extra.held?.reason ?? j?.reason
    return {
      sessionId: id,
      label: facts.label,
      origin: facts.origin,
      originClass: facts.originClass,
      cwd: facts.cwd,
      model: facts.model,
      profile: facts.profile,
      state: facts.state,
      class: facts.class,
      status: facts.status,
      idleMinutes: facts.idleMinutes !== undefined ? Math.round(facts.idleMinutes) : undefined,
      verdict: facts.verdict ?? null,
      confidence: facts.confidence ?? null,
      ...(j?.probabilities ? { probabilities: j.probabilities } : {}),
      judgedBy: j?.judgedBy ?? (facts.class === "judge" ? null : RULES_JUDGE),
      errored: facts.errored,
      errorKind: facts.errorKind,
      transient: facts.transient,
      ...(facts.walletProfile ? { walletProfile: facts.walletProfile } : {}),
      neverRan: facts.neverRan,
      remainingWork: facts.remainingWork,
      evidence: { summary: evidenceSummary(facts), ...(facts.errorText ? { error: facts.errorText } : {}), ...(why ? { note: cut(why, 300) } : {}) },
      action: decision.action,
      actionReason: decision.reason,
      ruleId: decision.ruleId,
      ruleSource: decision.source,
      ...(decision.bound ? { boundFrom: decision.boundFrom } : {}),
      ...(decision.skipped ? { skipped: true } : {}),
      ...(hint ? { relaunchHint: hint } : {}),
      fingerprint: fingerprintOf(row),
    }
  })
  const counts = {}
  for (const s of sessions) counts[s.action] = (counts[s.action] ?? 0) + 1
  return {
    schema: SNAPSHOT_SCHEMA,
    id: input.id ?? newSnapshotId(nowMs),
    createdAt: new Date(nowMs).toISOString(),
    createdAtMs: nowMs,
    settings: {
      idleMinutes: settings?.idleMinutes,
      minConfidence: settings?.minConfidence,
      jevModel: settings?.jevModel,
      userOrigins: settings?.userOrigins,
      closableOrigins: settings?.closableOrigins,
    },
    rules: { source: rules?.source ?? "none", count: customRules.length },
    ...(hostLoad ? { host: hostLoad } : {}),
    counts,
    sessions,
  }
}

// ── staleness ────────────────────────────────────────────────────────────

/** What must be unchanged between the snapshot and the act for the
 *  recommendation to still hold. */
export function fingerprintOf(row) {
  if (!row) return null
  return {
    status: row.status ?? null,
    lastActivityAt: row.lastActivityAt ?? null,
    lastTurnErroredAt: row.lastTurnErroredAt ?? null,
    turnsCompleted: num(row.turnsCompleted) ?? null,
    tokensIn: num(row.tokensIn) ?? null,
    tokensOut: num(row.tokensOut) ?? null,
    busy: row.busy === true,
    archived: row.archived === true,
    outcome: row.outcome?.verdict ?? null,
    flag: row.wrapupFlag?.at ?? null,
  }
}

/** `{ changed, why[] }` — compare a snapshot row's fingerprint with the live
 *  `session_list` row now. A session that vanished from the list changed. */
export function staleness(snapshotRow, liveRow) {
  if (!liveRow) return { changed: true, why: ["no longer listed (archived, deleted or garbage-collected)"] }
  const was = snapshotRow.fingerprint
  if (!was) return { changed: false, why: [] }
  const now = fingerprintOf(liveRow)
  const why = []
  const labels = {
    status: "status",
    lastActivityAt: "new activity",
    lastTurnErroredAt: "error state",
    turnsCompleted: "new turn",
    tokensIn: "token usage",
    tokensOut: "token usage",
    busy: "busy state",
    archived: "archived state",
    outcome: "outcome recorded",
    flag: "flag set",
  }
  for (const k of Object.keys(labels)) {
    if (was[k] !== now[k] && !why.includes(labels[k])) why.push(`${labels[k]} (${was[k]} → ${now[k]})`)
  }
  return { changed: why.length > 0, why }
}

// ── act planner ──────────────────────────────────────────────────────────

function splitSet(v) {
  if (v === undefined || v === null || v === "") return null
  const list = Array.isArray(v) ? v : String(v).split(",")
  const out = list.map(s => String(s).trim()).filter(Boolean)
  return out.length ? new Set(out) : null
}

/** Normalize `--only` / `--session` (CSV string or list) and reject unknown actions. */
export function parseSelectors({ only, sessions } = {}) {
  const onlySet = splitSet(only)
  const errors = []
  if (onlySet) for (const a of onlySet) if (!ACTIONS.includes(a)) errors.push(`--only: unknown action "${a}" (one of ${ACTIONS.join(", ")})`)
  return { only: onlySet, sessions: splitSet(sessions), errors }
}

/** The outcome detail an act writes onto the session record. */
export function outcomeDetailOf(row) {
  const a = row.analysis
  const by = a?.by ?? (row.judgedBy && String(row.judgedBy).startsWith("jev") ? "jev" : "steward-rules")
  const errorKind = a?.errorKind ?? (row.errored ? row.errorKind : undefined)
  return {
    reason: a?.reason ?? row.actionReason,
    ...(a?.question ? { question: a.question } : {}),
    ...(errorKind && errorKind !== "none" ? { errorKind } : {}),
    ...((a?.nextStep ?? a?.remainingWork) ? { nextStep: a.nextStep ?? (Array.isArray(a.remainingWork) ? a.remainingWork.join("; ") : a.remainingWork) } : {}),
    by,
  }
}

const CONTINUE_PROMPT =
  "Your last turn was cut off by a transient error (quota, upstream or timeout). " +
  "Check the state on disk and continue where you left off."

/**
 * Turn a snapshot into this act's plan, per session:
 * `{ sessionId, label, origin, action, from?, ruleId, status, why, tool?, call? }`
 * where `status` is `planned | kept | skipped`. `queues` holds the daemon
 * calls to dispatch — EMPTY unless `apply`.
 *
 * Order of gates: session selector → rules re-evaluation → origin bound →
 * `--only` → keep → staleness → opt-in gate (relaunch / archive) → call.
 */
export function planActs(snapshot, liveRows, opts = {}) {
  const sel = parseSelectors({ only: opts.only, sessions: opts.sessions })
  const queues = { wrapup: [], label: [], archive: [], restart: [], fresh: [], prompt: [] }
  const plan = []
  if (sel.errors.length) return { plan, queues, errors: sel.errors }
  const live = new Map((liveRows ?? []).map(r => [r.id, r]))
  for (const row of snapshot?.sessions ?? []) {
    if (sel.sessions && !sel.sessions.has(row.sessionId)) continue
    const base = { sessionId: row.sessionId, label: row.label, origin: row.origin, class: row.class }
    const r = resolveRowAction(row, snapshot, sel, opts)
    const { action, from, ruleId, reason } = r
    if (r.status) {
      plan.push({ ...base, action, from, ruleId, status: r.status, why: r.why })
      continue
    }
    const fresh = live.get(row.sessionId)
    const stale = staleness(row, fresh)
    if (stale.changed) {
      plan.push({ ...base, action, from, ruleId, status: "skipped", why: `changed since snapshot: ${stale.why.join(", ")}` })
      continue
    }
    if (OPT_IN_ACTIONS.includes(action)) {
      const explicit = sel.only?.has(action) === true || (action === "relaunch" && opts.allowRelaunch === true)
      if (!explicit) {
        plan.push({ ...base, action, from, ruleId, status: "skipped", why: `${action} only runs when named in --only${action === "relaunch" ? " (or --allow-relaunch)" : ""}` })
        continue
      }
    }
    const call = callFor(action, row, fresh, reason)
    if (call.skip) {
      plan.push({ ...base, action, from, ruleId, status: "skipped", why: call.skip })
      continue
    }
    plan.push({ ...base, action, from, ruleId, status: "planned", why: reason, tool: call.tool, call: call.args })
    if (opts.apply === true) queues[call.queue].push(call.item)
  }
  return { plan, queues, errors: [] }
}

/** The action for one snapshot row after the custom rules, the origin bound
 *  and `--only`. `status` is set (`kept` / `skipped`) when the row is settled
 *  without needing a live re-check. */
function resolveRowAction(row, snapshot, sel, opts) {
  const customRules = opts.rules?.rules ?? []
  const settings = { ...snapshot?.settings, minConfidence: opts.minConfidence ?? snapshot?.settings?.minConfidence }
  let action = row.action
  let ruleId = row.ruleId
  let reason = row.actionReason
  let from
  if (customRules.length > 0) {
    const facts = { ...factsOfRow(row, settings), action: row.action }
    const d = decideAction(facts, customRules)
    if (d.source === "custom") {
      from = row.action !== d.action ? row.action : undefined
      action = d.action
      ruleId = d.ruleId
      reason = d.reason
      if (d.skipped) return { action: "keep", from: row.action, ruleId, reason, status: "skipped", why: `rule ${ruleId}: skip` }
    }
  }
  const bound = boundByOrigin(action, factsOfRow(row, settings))
  if (bound.bound) {
    from = from ?? action
    action = bound.action
    reason = `${reason} — user origin: ${bound.boundFrom} → ${bound.action}`
  }
  if (sel.only && !sel.only.has(action)) return { action, from, ruleId, reason, status: "skipped", why: `not in --only (${[...sel.only].join(",")})` }
  if (action === "keep") return { action, from, ruleId, reason, status: "kept", why: reason }
  return { action, from, ruleId, reason }
}

/** Ids a plan would need a live re-check for: every row that survives the
 *  selectors, the rules and the origin bound with an action to run. Lets the
 *  workflow look up just those sessions instead of re-listing the registry. */
export function actTargets(snapshot, opts = {}) {
  const sel = parseSelectors({ only: opts.only, sessions: opts.sessions })
  if (sel.errors.length) return []
  const out = []
  for (const row of snapshot?.sessions ?? []) {
    if (sel.sessions && !sel.sessions.has(row.sessionId)) continue
    if (!resolveRowAction(row, snapshot, sel, opts).status) out.push(row.sessionId)
  }
  return out
}

function factsOfRow(row, settings) {
  const min = settings?.minConfidence ?? 0.8
  return {
    sessionId: row.sessionId,
    label: row.label,
    origin: row.origin,
    originClass: row.originClass,
    cwd: row.cwd,
    model: row.model,
    profile: row.profile,
    class: row.class,
    state: row.state,
    idleMinutes: row.idleMinutes,
    verdict: row.analysis?.verdict ?? row.verdict ?? undefined,
    confidence: row.confidence ?? undefined,
    confident: typeof row.confidence === "number" && row.confidence >= min,
    errored: row.errored,
    errorKind: row.analysis?.errorKind ?? row.errorKind,
    transient: row.transient,
    neverRan: row.neverRan,
    remainingWork: row.remainingWork,
  }
}

function callFor(action, row, fresh, reason) {
  const ended = fresh ? !["running", "starting"].includes(String(fresh.status ?? "")) : row.state === "ended"
  const detail = outcomeDetailOf({ ...row, actionReason: reason })
  const id = row.sessionId
  if (action === "archive") {
    if (!ended) return { skip: "a live session cannot be archived" }
    return { queue: "archive", tool: "session_archive", args: { idOrName: id }, item: { sessionId: id, idOrName: id } }
  }
  if (action === "relaunch") {
    const hint = row.analysis?.relaunchHint ?? row.relaunchHint
    if (!hint) return { skip: "no relaunch hint in the snapshot (re-run classify/analyze)" }
    if (hint.deferred) return { skip: `deferred: ${hint.why}` }
    if (hint.mode === "fresh" && hint.profileRef) {
      const args = { idOrName: id, access: { profileRef: hint.profileRef }, askSource: false }
      return { queue: "fresh", tool: "session_continue_fresh", args, item: { sessionId: id, ...args } }
    }
    if (ended) return { queue: "restart", tool: "session_restart", args: { idOrName: id }, item: { sessionId: id, idOrName: id } }
    return { queue: "prompt", tool: "agent_prompt", args: { sessionId: id }, item: { sessionId: id, prompt: CONTINUE_PROMPT } }
  }
  const verdict = ACTION_TO_VERDICT[action]
  if (!verdict) return { skip: `unknown action ${action}` }
  if (ended) {
    if (action === "needs-input") return { skip: "an ended session cannot be flagged — nothing is waiting" }
    const outcome = { verdict, ...detail }
    return { queue: "label", tool: "agent_kill", args: { sessionId: id, outcome }, item: { sessionId: id, outcome } }
  }
  const judgedBy = row.judgedBy && row.judgedBy !== "steward-rules" ? row.judgedBy : RULES_JUDGE
  const item = { sessionId: id, verdict, judgedBy, note: detail.reason, ...detail }
  return { queue: "wrapup", tool: "session_wrapup_apply", args: { sessionIds: [id], verdict, judgedBy, ...detail }, item }
}

// ── act results ──────────────────────────────────────────────────────────

/** Items of a tolerant (`onError: collect`) map, split by outcome. */
export function settledOf(mapResult) {
  if (Array.isArray(mapResult)) return { ok: mapResult.map((value, index) => ({ index, value })), failed: [] }
  const results = Array.isArray(mapResult?.results) ? mapResult.results : []
  return {
    ok: results.filter(r => r?.status === "fulfilled").map(r => ({ index: r.index, value: r.value })),
    failed: results.filter(r => r && r.status !== "fulfilled"),
  }
}

/** Fold the dispatched maps back onto the plan: each planned row gets its
 *  result (`applied`, or `refused (<why>)`). `queues` is the plan's queues
 *  (index → session), `mapResults` the matching map outputs by queue name. */
export function foldActResults(plan, queues, mapResults, explain = x => x) {
  const result = new Map()
  const note = (id, ok, text) => id && result.set(id, { ok, text })
  for (const q of ["wrapup", "label", "archive", "restart", "fresh", "prompt"]) {
    const { ok, failed } = settledOf(mapResults?.[q])
    for (const { index, value } of ok) {
      const id = queues?.[q]?.[index]?.sessionId
      if (q === "wrapup") {
        for (const r of Array.isArray(value?.results) ? value.results : []) {
          note(r.sessionId, r.ok === true, r.ok === true ? r.action ?? "applied" : `refused (${explain(r.error)})`)
        }
      } else if (value?.ok === false || value?.isError === true || value?.error) {
        note(id, false, `refused (${explain(value.error ?? value.reason ?? "not ok")})`)
      } else {
        const to = value?.continuedTo ?? value?.descriptor?.id ?? value?.id
        note(id, true, { label: "labelled", archive: "archived", prompt: "continue prompt sent", restart: `restarted${to ? ` as ${to}` : ""}`, fresh: `relaunched${to ? ` as ${to}` : ""}` }[q])
      }
    }
    for (const f of failed) note(f.item?.sessionId ?? queues?.[q]?.[f.index]?.sessionId, false, `failed: ${f.error ?? f.status}`)
  }
  return plan.map(p => (result.has(p.sessionId) ? { ...p, result: result.get(p.sessionId) } : p))
}

// ── analyze ──────────────────────────────────────────────────────────────

export const ANALYZE_DEFAULT_MAX = 20

/** The rows an analysis pass reads: not `keep` — or `keep` but below the
 *  confidence threshold — or explicitly selected. Held rows are never
 *  analyzed unless named. Already-analyzed rows are skipped unless named. */
export function selectForAnalysis(snapshot, { only, sessions, maxSessions, minConfidence } = {}) {
  const sel = parseSelectors({ only, sessions })
  const min = minConfidence ?? snapshot?.settings?.minConfidence ?? 0.8
  const cap = Number.isFinite(maxSessions) && maxSessions > 0 ? Math.floor(maxSessions) : ANALYZE_DEFAULT_MAX
  const rows = snapshot?.sessions ?? []
  const chosen = []
  for (const r of rows) {
    const named = sel.sessions?.has(r.sessionId) === true
    if (sel.sessions && !named) continue
    if (sel.only && !sel.only.has(r.action) && !named) continue
    if (!named) {
      if (r.class === "held" || r.class === "archive") continue
      if (r.analysis) continue
      const lowConfidence = r.class === "judge" && (r.confidence === null || r.confidence < min)
      if (r.action === "keep" && !lowConfidence) continue
    }
    chosen.push(r)
  }
  const rank = r => (r.action === "keep" ? 1 : 0)
  chosen.sort((a, b) => rank(a) - rank(b))
  return { selected: chosen.slice(0, cap), overflow: Math.max(0, chosen.length - cap), errors: sel.errors }
}

export function buildAnalyzePrompt(row, evidence) {
  return (
    "You are the session steward's analyst. ONE AI coding-agent session was classified by a fast typed classifier; " +
    "read the evidence and explain WHY, in structured fields. Do NOT call any tool — answer from the evidence alone.\n\n" +
    `Classifier view: action=\`${row.action}\` verdict=\`${row.verdict}\` confidence=${row.confidence} ` +
    `(${row.evidence?.summary || "no summary"}).\n` +
    "Actions: keep | mark-complete (done, nothing pending) | mark-failed (non-transient failure) | relaunch " +
    "(TRANSIENT failure: quota/upstream/timeout/crash) | needs-input (waiting on a human — put the exact question in `question`) | " +
    "close-abandoned (never ran / orphaned / no value) | archive.\n" +
    "errorKind: quota | upstream | timeout | crash | logic | none.\n" +
    "Only change the action when the evidence clearly contradicts it; keep your own confidence honest.\n\n" +
    "Reply with ONLY one JSON object, no prose, no code fence:\n" +
    `{"sessionId": "${row.sessionId}", "action": "<one of the actions>", "confidence": <0..1>, "reason": "<one line: why complete / why failed / why waiting>", ` +
    '"question": "<the open question, or omit>", "errorKind": "<kind>", "nextStep": "<what should happen next, or omit>", ' +
    '"remainingWork": ["<item>"], "relaunchHint": {"mode": "continue"|"fresh"}, "evidenceRefs": ["<short pointers: PR #, tool call, turn>"]}\n\n' +
    `Evidence:\n${JSON.stringify(evidence)}`
  )
}

const str = (v, n) => (typeof v === "string" && v.trim() ? cut(v.trim().split("\n")[0], n) : undefined)

/** Strict parse of the analyst's reply; ANYTHING off ⇒ `{ malformed: true }`
 *  and the row keeps its classify-step action. */
export function parseAnalysis(text, sessionId) {
  const bad = why => ({ malformed: true, reason: `malformed analysis reply: ${why}` })
  if (typeof text !== "string" || !text.trim()) return bad("empty")
  let body = text.trim()
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fence) body = fence[1].trim()
  if (!body.startsWith("{") || !body.endsWith("}")) return bad("not a lone JSON object")
  let v
  try {
    v = JSON.parse(body)
  } catch {
    return bad("invalid JSON")
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("not an object")
  if (v.sessionId !== sessionId) return bad("sessionId mismatch")
  if (!ACTIONS.includes(v.action)) return bad("unknown action")
  if (typeof v.confidence !== "number" || !(v.confidence >= 0 && v.confidence <= 1)) return bad("confidence not in 0..1")
  const reason = str(v.reason, 400)
  if (!reason) return bad("no reason")
  const errorKind = ERROR_KINDS.includes(v.errorKind) ? v.errorKind : undefined
  const mode = v.relaunchHint?.mode
  return {
    action: v.action,
    confidence: v.confidence,
    reason,
    ...(str(v.question, 400) ? { question: str(v.question, 400) } : {}),
    ...(errorKind ? { errorKind } : {}),
    ...(str(v.nextStep, 400) ? { nextStep: str(v.nextStep, 400) } : {}),
    ...(Array.isArray(v.remainingWork) ? { remainingWork: v.remainingWork.filter(x => typeof x === "string").slice(0, 8).map(x => cut(x, 200)) } : {}),
    ...(mode === "continue" || mode === "fresh" ? { relaunchHint: { mode } } : {}),
    ...(Array.isArray(v.evidenceRefs) ? { evidenceRefs: v.evidenceRefs.filter(x => typeof x === "string").slice(0, 8).map(x => cut(x, 120)) } : {}),
  }
}

/** The no-LLM analysis (`--judge jev`): structured fields derived from the
 *  evidence and the classify-step verdict, no agent session spawned. */
export function heuristicAnalysis(row, evidence) {
  const err = classifyError(evidence?.lastTurnError ?? row.evidence?.error)
  const errorKind = row.errored ? (row.errorKind !== "none" ? row.errorKind : err.kind) : "none"
  const tail = evidence?.signals?.lastAssistantTail
  const question = row.action === "needs-input" && typeof tail === "string" ? cut(tail.split("\n").filter(l => l.includes("?")).pop() ?? tail.slice(-200), 300) : undefined
  const prs = evidence?.pullRequests
  const refs = []
  if (prs?.merged) refs.push(`${prs.merged} merged PR(s)`)
  else if (prs?.opened) refs.push(`${prs.opened} opened PR(s)`)
  if (row.errored) refs.push(`last turn error: ${cut(row.evidence?.error ?? evidence?.lastTurnError ?? "", 100)}`)
  const reasons = {
    "mark-complete": prs?.merged ? "work finished — its PR is merged" : "work finished — nothing pending",
    "mark-failed": row.errored ? `failed: ${errorKind} error` : "failed",
    relaunch: `failed on a transient ${errorKind} error`,
    "needs-input": question ? "waiting on an answer" : "waiting on a human",
    "close-abandoned": row.neverRan ? "never ran (0 tokens in/out)" : "abandoned — no PR, no completed turn",
    archive: "ended, outcome already recorded",
    keep: "still active or not enough evidence to act",
  }
  return {
    action: row.action,
    confidence: typeof row.confidence === "number" ? row.confidence : 1,
    reason: `${reasons[row.action] ?? row.actionReason} (${row.evidence?.summary || "no summary"})`,
    ...(question ? { question } : {}),
    ...(errorKind !== "none" ? { errorKind } : {}),
    ...(row.relaunchHint ? { relaunchHint: { mode: row.relaunchHint.mode, ...(row.relaunchHint.profileRef ? { profileRef: row.relaunchHint.profileRef } : {}) } } : {}),
    ...(refs.length ? { evidenceRefs: refs } : {}),
  }
}

/** Fold analyses (by session id) into the snapshot. An analysis may revise
 *  the recommended action when its own confidence reaches `minConfidence`;
 *  the classify-step action stays on the row (`classifiedAction`). Origin
 *  bounds apply to the revised action. */
export function applyAnalyses(snapshot, analyses, { minConfidence, customRules, by = "agent", nowMs } = {}) {
  const min = minConfidence ?? snapshot.settings?.minConfidence ?? 0.8
  let revised = 0
  let analyzed = 0
  const sessions = snapshot.sessions.map(row => {
    const a = analyses.get(row.sessionId)
    if (!a || a.malformed) return a?.malformed ? { ...row, analysisError: a.reason } : row
    analyzed++
    const analysis = { ...a, by: a.by ?? by, analyzedAt: new Date(nowMs ?? Date.now()).toISOString(), classifiedAction: row.action }
    let action = row.action
    let boundFrom
    if (a.action !== row.action && a.confidence >= min) {
      const b = boundByOrigin(a.action, { originClass: row.originClass, state: row.state })
      action = b.action
      boundFrom = b.bound ? b.boundFrom : undefined
      revised++
    }
    const hint = a.relaunchHint?.profileRef ? a.relaunchHint : a.relaunchHint && row.relaunchHint ? { ...row.relaunchHint, ...a.relaunchHint } : row.relaunchHint
    const next = { ...row, analysis: { ...analysis, verdict: row.verdict }, action }
    delete next.analysisError
    if (hint) next.relaunchHint = hint
    if (action !== row.action) {
      next.classifiedAction = row.action
      next.actionReason = `analysis: ${a.reason}${boundFrom ? ` — user origin: ${boundFrom} → ${action}` : ""}`
      next.ruleId = "analysis"
      next.ruleSource = "analysis"
    }
    return next
  })
  const counts = {}
  for (const s of sessions) counts[s.action] = (counts[s.action] ?? 0) + 1
  return {
    snapshot: { ...snapshot, sessions, counts, analyzedAt: new Date(nowMs ?? Date.now()).toISOString() },
    analyzed,
    revised,
  }
}

// ── rendering ────────────────────────────────────────────────────────────

const cellOf = s => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")

function probsOf(p) {
  return Object.entries(p ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
    .join(" ")
}

/** The classify table, grouped by recommended action. `keep` is a count
 *  unless `showKeep`. */
export function renderSnapshot(snapshot, { showKeep = false } = {}) {
  const lines = []
  lines.push(`# Session steward — snapshot \`${snapshot.id}\``)
  lines.push("")
  lines.push(
    `taken ${snapshot.createdAt} · ${snapshot.sessions.length} session(s) · idle ≥ ${snapshot.settings?.idleMinutes ?? "?"} min · ` +
      `minConfidence ${snapshot.settings?.minConfidence ?? "?"} · rules: ${snapshot.rules?.source ?? "none"} (${snapshot.rules?.count ?? 0})`,
  )
  lines.push(`recommended: ${ACTIONS.filter(a => snapshot.counts?.[a]).map(a => `${a}=${snapshot.counts[a]}`).join(" ") || "nothing"}`)
  for (const action of ACTIONS) {
    const rows = snapshot.sessions.filter(s => s.action === action)
    if (rows.length === 0) continue
    lines.push("")
    if (action === "keep" && !showKeep) {
      lines.push(`## keep (${rows.length}) — ${ACTION_INFO.keep}`, "", `_${rows.length} session(s) left alone; pass \`--all\` to list them._`)
      continue
    }
    lines.push(`## ${action} (${rows.length}) — ${ACTION_INFO[action]}`, "")
    lines.push("| session | origin | state | verdict | p | why |")
    lines.push("|---|---|---|---|---|---|")
    for (const s of rows) {
      const p = s.probabilities ? probsOf(s.probabilities) : s.confidence !== null && s.confidence !== undefined ? `conf=${Number(s.confidence).toFixed(2)}` : "—"
      const origin = `${s.origin ?? "(none)"}${s.originClass === "user" ? " (user)" : ""}`
      const why = [s.actionReason, s.evidence?.summary].filter(Boolean).join(" · ")
      const hint = s.relaunchHint ? ` · ${s.relaunchHint.mode}${s.relaunchHint.profileRef ? ` on ${s.relaunchHint.profileRef}` : ""}${s.relaunchHint.deferred ? " (deferred)" : ""}` : ""
      const analysis = s.analysis ? ` · analysis(${s.analysis.by}): ${s.analysis.reason}${s.analysis.question ? ` ? ${s.analysis.question}` : ""}` : ""
      lines.push(`| ${cellOf(s.label ?? s.sessionId)} | ${cellOf(origin)} | ${s.state} | ${cellOf(s.verdict ?? "—")} | ${cellOf(p)} | ${cellOf(why + hint + analysis)} |`)
    }
  }
  return lines.join("\n")
}

/** The act plan table (dry run or applied). */
export function renderPlan(snapshotId, plan, { apply, errors = [], rulesSource = "none" } = {}) {
  const lines = [`# Session steward — act \`${snapshotId}\` — ${apply ? "apply" : "dry run"}`, "", `rules: ${rulesSource}`]
  for (const e of errors) lines.push(`- ERROR: ${e}`)
  if (!apply) lines.push("", "_Dry run: nothing was changed. Re-run with `--apply` to act._")
  const interesting = plan.filter(p => p.status !== "kept")
  const kept = plan.length - interesting.length
  lines.push("")
  lines.push("| action | session | origin | status | result / why |")
  lines.push("|---|---|---|---|---|")
  for (const p of interesting) {
    const was = p.from ? ` (was ${p.from})` : ""
    const tail = p.result ? `${p.result.ok ? "ok" : "FAILED"}: ${p.result.text} — ${p.why}` : p.why
    lines.push(`| ${p.action}${was} | ${cellOf(p.label ?? p.sessionId)} | ${cellOf(p.origin ?? "(none)")} | ${p.status} | ${cellOf(tail)} |`)
  }
  lines.push("")
  const tally = {}
  for (const p of plan) tally[p.status] = (tally[p.status] ?? 0) + 1
  lines.push(`- ${plan.length} session(s): ${Object.entries(tally).map(([k, n]) => `${k}=${n}`).join(" ")}${kept ? ` (${kept} kept, not listed)` : ""}`)
  return lines.join("\n")
}

/** A dry-run diff of two plans (e.g. default rules vs a custom file). */
export function diffPlans(a, b) {
  const byId = new Map(a.map(p => [p.sessionId, p]))
  const out = []
  for (const p of b) {
    const q = byId.get(p.sessionId)
    if (!q) continue
    const same = q.action === p.action && q.status === p.status
    if (!same) out.push({ sessionId: p.sessionId, label: p.label, before: `${q.action}/${q.status}`, after: `${p.action}/${p.status}`, ruleId: p.ruleId })
  }
  return out
}
