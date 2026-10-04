// Pure attention rules for the `session-attention` workflow — no I/O, no clock
// read (every function takes `nowMs`), so a unit test pins each decision.
//
// The question this answers is NOT "can this session be closed?" but "does
// this session need Jeremy?". An idle session whose last turn finished is
// never "truly active": it either asked something, is blocked, is broken,
// is finished, was superseded, or stopped mid-flight (`parked`).
//
// Rules speak first (deterministic, high-confidence). Only what stays
// ambiguous goes to the attention judge (an agent), whose reply is parsed
// strictly and can never turn an idle session into `active`.

import { isUsefulLoopCommand, detectStall } from "../session-steward/cron-rules.mjs"

export const ATTENTION_VERDICTS = ["needs-reply", "blocked", "stuck", "done", "superseded", "active", "parked"]

/** Verdicts that are reported as "needs you" (vs. cleanup / no action). */
export const NEEDS_YOU = new Set(["needs-reply", "stuck", "blocked", "parked"])

export const DEFAULT_IDLE_MINUTES = 10
/** Rule confidence below this goes to the judge (when a judge is available). */
export const JUDGE_BELOW = 0.9

const AUTO_CHAT_LABEL = /^chat \d\d:\d\d:\d\d$/

const oneLine = s => String(s ?? "").replace(/\s+/g, " ").trim()

function cut(text, max) {
  const t = oneLine(text)
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

function tailCut(text, max) {
  const t = oneLine(text)
  return t.length <= max ? t : `…${t.slice(t.length - (max - 1))}`
}

// ── title ────────────────────────────────────────────────────────────────

/** The title a human recognises. The daemon's auto label (`chat 04:14:05`)
 *  and a title that merely echoes it say nothing, so fall back to the first
 *  user message; an explicit label/title always wins over that. */
export function displayTitle(row, evidence) {
  const label = oneLine(row?.label ?? row?.name ?? evidence?.label)
  const title = oneLine(row?.title)
  const auto = s => !s || AUTO_CHAT_LABEL.test(s)
  // "[background task x completed] …" is a harness notification, not a title.
  const clean = s => s.replace(/^\[[^\]]{0,80}\]\s*/, "")
  if (!auto(label)) return cut(clean(label) || label, 70)
  if (!auto(title)) return cut(clean(title) || title, 70)
  const userTurns = (Array.isArray(evidence?.turns) ? evidence.turns : []).filter(t => t?.role === "user")
  const first = userTurns.map(t => clean(oneLine(t.text))).find(Boolean)
  if (first) return cut(first, 70)
  return label || row?.id || evidence?.sessionId || "(untitled)"
}

// ── text signals ─────────────────────────────────────────────────────────

/** The same sentence repeated, or the same trailing run repeated. Returns
 *  `{ sentence, count }` or `null`. */
export function detectRepetition(text, { minRepeats = 3, minSentence = 12 } = {}) {
  if (typeof text !== "string" || text.length < 80) return null
  const norm = s => s.replace(/\s+/g, " ").trim().toLowerCase()
  const counts = new Map()
  for (const part of text.split(/(?<=[.!?…])\s*/).map(norm)) {
    if (part.length >= minSentence) counts.set(part, (counts.get(part) ?? 0) + 1)
  }
  let best = null
  for (const [sentence, count] of counts) {
    if (count >= minRepeats && (count * sentence.length) / text.length >= 0.3 && (!best || count * sentence.length > best.count * best.sentence.length)) {
      best = { sentence, count }
    }
  }
  if (best) return best
  const flat = norm(text)
  if (flat.length >= 150) {
    const probe = flat.slice(-40)
    const n = flat.split(probe).length - 1
    if (n >= minRepeats) return { sentence: probe, count: n }
  }
  return null
}

const ASK_PHRASES =
  /(waiting (for|on) (your|you)\b|your go\b|let me know|tell me\b|want me to|should i\b|shall i\b|do you want|can you (send|provide|give|confirm)|je t['’]attends|j['’]attends (ton|ta|tes|ta réponse)|dis[- ]moi|tu veux|veux-tu|ton go\b|ton feu vert|ton accord|besoin de (ton|toi)|à toi de|préviens-moi|ok pour)/i

/** The agent's last message asks the human something (a question mark in
 *  the closing sentences, or an explicit "waiting for your go" phrase). */
export function endsWithAsk(text) {
  if (typeof text !== "string") return false
  const t = oneLine(text)
  if (!t) return false
  const tail = t.slice(-320)
  if (ASK_PHRASES.test(tail)) return true
  const sentences = tail.split(/(?<=[.!?…])\s+/).filter(Boolean)
  return sentences.slice(-2).some(s => /[?？]["'”’)\]*_`]*$/.test(s.trim()))
}

const BLOCKED_PHRASES =
  /(blocked (on|by)|bloqu[ée]e?\b|still blocked|waiting for (ci|the review|a review|the token|a token|the deploy)|need(s)? the [\w -]{0,40}token|besoin du token|il manque|missing (the )?(token|key|credential|secret))/i

export function mentionsBlocker(text) {
  return typeof text === "string" && BLOCKED_PHRASES.test(oneLine(text).slice(-600))
}

// ── evidence accessors ───────────────────────────────────────────────────

function turnsOf(evidence) {
  return Array.isArray(evidence?.turns) ? evidence.turns.filter(t => t && typeof t.text === "string") : []
}

export function lastTurn(evidence) {
  const t = turnsOf(evidence)
  return t.length ? t[t.length - 1] : null
}

export function lastAssistantText(evidence) {
  const t = turnsOf(evidence)
  for (let i = t.length - 1; i >= 0; i--) if (t[i].role === "assistant") return t[i].text
  return ""
}

/** True when the newest event is a failed turn: an error on record that
 *  happened after the user's latest message, and the process is not busy. */
export function lastTurnErrored(evidence, nowMs) {
  if (!evidence?.lastTurnErroredAt || evidence.busy === true) return false
  const ts = Date.parse(evidence.lastTurnErroredAt)
  if (!Number.isFinite(ts)) return false
  const ageMin = (nowMs - ts) / 60_000
  const sinceUser = evidence.minutesSinceUserMessage
  return typeof sinceUser !== "number" || ageMin <= sinceUser + 1
}

/** Heavy verbatim command repetition over the session (useful loops such as
 *  watch / tests / `gh pr` polling excluded). */
export function detectToolLoop(toolStats) {
  const s = toolStats
  if (!s || typeof s.total !== "number" || s.total < 8) return null
  if (typeof s.ratio !== "number" || s.ratio > 0.2) return null
  if (typeof s.topCommandCount !== "number" || s.topCommandCount < 5) return null
  if (isUsefulLoopCommand(s.topCommand)) return null
  return { count: s.topCommandCount, total: s.total }
}

export function normalizeTitle(title) {
  return oneLine(title).toLowerCase().replace(/\d+/g, "#").slice(0, 48)
}

/** Newer live sessions in the same cwd — hands the judge a "superseded by"
 *  hint, and drives the same-title rule. */
export function findNewerSiblings(rows, row, nowMs, limit = 3) {
  const idleOf = r => {
    const ms = Date.parse(r?.lastActivityAt ?? r?.startedAt ?? "")
    return Number.isFinite(ms) ? Math.max(0, (nowMs - ms) / 60_000) : Number.POSITIVE_INFINITY
  }
  const mine = idleOf(row)
  return (rows ?? [])
    .filter(r => r?.id && r.id !== row?.id && r.cwd && r.cwd === row?.cwd && idleOf(r) < mine)
    .slice(0, limit)
    .map(r => ({ id: r.id, title: displayTitle(r), idleMinutes: Math.round(idleOf(r)) }))
}

// ── excerpt ──────────────────────────────────────────────────────────────

export function excerptOf(evidence, max = 220) {
  const text = lastAssistantText(evidence)
  if (!text) {
    const last = lastTurn(evidence)
    return last ? `(${last.role}) ${tailCut(last.text, max)}` : ""
  }
  const rep = detectRepetition(text)
  if (rep) return `${cut(rep.sentence, max - 8)} (x${rep.count})`
  return tailCut(text, max)
}

// ── rules ────────────────────────────────────────────────────────────────

function result(verdict, confidence, reason, extra = {}) {
  return { verdict, confidence, reason: oneLine(reason), flags: [], waitingOnYou: NEEDS_YOU.has(verdict) && verdict !== "parked", ambiguous: confidence < JUDGE_BELOW && verdict !== "active", source: "rules", ...extra }
}

/**
 * One session's evidence → a verdict. `ctx`: `{ nowMs, idleMinutes (threshold),
 * siblings }`. Order matters: breakage first (an errored or looping session
 * is never "active", whatever else it says), then the human-facing asks,
 * then closure signals; the unexplained remainder is `parked`, never `active`.
 */
export function classifyAttention(evidence, ctx = {}) {
  const nowMs = ctx.nowMs ?? 0
  const threshold = ctx.idleMinutes ?? DEFAULT_IDLE_MINUTES
  const idle = typeof evidence?.idleMinutes === "number" ? evidence.idleMinutes : 0
  const busy = evidence?.busy === true
  const text = lastAssistantText(evidence)
  const last = lastTurn(evidence)

  if (evidence?.tokensIn === 0 && evidence?.tokensOut === 0) {
    return result("stuck", 0.95, "never ran: 0 tokens in and out", { flags: ["never-ran"] })
  }

  const rep = busy ? null : detectRepetition(text)
  if (rep) {
    return result("stuck", 0.95, `repeating the same sentence ${rep.count} times: "${cut(rep.sentence, 80)}"`, {
      flags: ["looping", ...(lastTurnErrored(evidence, nowMs) ? ["errored"] : [])],
    })
  }

  const toolLoop = detectToolLoop(evidence?.toolStats)
  if (busy) {
    if (toolLoop) return result("stuck", 0.75, `busy and re-running the same command ${toolLoop.count}x of ${toolLoop.total} calls`, { flags: ["looping"] })
    const stall = detectStall({ busy: true, idleMinutes: idle, nowMs })
    if (stall.stalled) return result("stuck", 0.8, stall.reason, { flags: ["stalled"] })
    return result("active", 0.9, "working right now")
  }

  if (idle >= threshold && lastTurnErrored(evidence, nowMs)) {
    const err = cut(evidence.lastTurnError ?? "turn failed", 120)
    return result("stuck", 0.9, `last turn errored (${err}) and nothing resumed it`, { flags: ["errored", ...(toolLoop ? ["tool-loop"] : [])] })
  }

  if (evidence?.awaitingInput === true) {
    // A flagged session that asked nothing may be waiting on its own child, not on you — let the judge look.
    return result("needs-reply", endsWithAsk(text) ? 0.95 : 0.85, "the session is explicitly awaiting your input", { flags: ["awaiting-input"] })
  }

  if (idle < threshold) return result("active", 0.8, `turn ended ${Math.round(idle)}m ago`)

  if (evidence?.continuedTo) {
    return result("superseded", 0.9, `continued in ${evidence.continuedTo}`, { flags: ["continued"] })
  }

  const asks = endsWithAsk(text)
  const merged = (evidence?.pullRequests?.merged ?? 0) > 0 || evidence?.worktree?.pr?.state === "merged"
  if (merged && !asks) return result("done", 0.8, "its PR is merged and it asked nothing", { flags: ["pr-merged"] })

  if (last?.role === "user") {
    return result("stuck", 0.7, "your last message got no answer", { flags: ["unanswered"] })
  }

  if (asks) return result("needs-reply", 0.8, "its last message asks you something", { flags: ["asks"] })

  const outcome = evidence?.outcome?.verdict
  if (outcome === "done") return result("done", 0.85, "an outcome of done is recorded")
  const lc = evidence?.lastToolCall?.command ?? evidence?.lastToolCall?.tool
  if (typeof lc === "string" && /message_parent/.test(lc) && /"?kind"?\s*[:=]\s*"?done/.test(lc)) {
    return result("done", 0.8, "its last act was reporting done to its parent")
  }

  if (mentionsBlocker(text)) return result("blocked", 0.6, "its last message mentions a blocker", { flags: ["blocker-mentioned"] })

  const same = (ctx.siblings ?? []).find(s => normalizeTitle(s.title) === normalizeTitle(ctx.title ?? ""))
  if (same) return result("superseded", 0.65, `${same.id} (newer, same title and cwd) covers the same work`, { flags: ["sibling"] })

  return result("parked", 0.4, "stopped without a question, an error or a conclusion")
}

// ── judge ────────────────────────────────────────────────────────────────

export function buildAttentionPrompt(evidence, rule) {
  return (
    "You triage ONE idle AI coding-agent session for its human owner (Jeremy), who cannot track tens of " +
    "sessions. Decide what the session needs from him, from the evidence below. Do NOT call any tool.\n\n" +
    "Verdicts:\n" +
    "- `needs-reply`: it asked a question or needs a decision/input/action only the human can give — even if the " +
    "ask is implicit in an earlier assistant turn and still unresolved.\n" +
    "- `blocked`: waiting on an EXTERNAL thing (a token, CI, a review, another session) — not a question to the human.\n" +
    "- `stuck`: broken — repeating itself, last turn errored, or a human message went unanswered.\n" +
    "- `done`: it delivered a final report and nothing is required to proceed. If it is only waiting for the human " +
    "to act on that report (merge, deploy), still `done` but set waitingOnYou true.\n" +
    "- `superseded`: a newer session/PR covers the same work (see `newerSiblings`, `continuedTo`).\n" +
    "- `parked`: idle, last turn finished, no question, no error, no conclusion — it just stopped. Use when unsure.\n" +
    "Never answer `active` — this session is idle, its last turn finished. A session that stopped is not working.\n" +
    "Read ALL assistant turns, not just the last: an ask or a blocker from an earlier turn still counts if nothing " +
    "later resolved it. Judge only what the text supports; quote nothing.\n\n" +
    "Reply with ONLY one JSON object, no prose, no code fence:\n" +
    `{"sessionId": "${evidence.sessionId}", "verdict": "needs-reply"|"blocked"|"stuck"|"done"|"superseded"|"parked", ` +
    '"confidence": <number 0..1>, "waitingOnYou": <true|false>, "reason": "<one line, max 160 chars, what it needs from Jeremy>"}\n\n' +
    `Rule-based first guess (may be wrong): ${rule.verdict} — ${rule.reason}\n` +
    `Evidence:\n${JSON.stringify(evidence)}`
  )
}

/** Strict parse of the judge's reply; anything off is `null` (the rules'
 *  verdict stands). `active` is not an accepted answer. */
export function parseAttentionVerdict(text, sessionId) {
  if (typeof text !== "string" || !text.trim()) return null
  let body = text.trim()
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fence) body = fence[1].trim()
  if (!body.startsWith("{") || !body.endsWith("}")) return null
  let v
  try {
    v = JSON.parse(body)
  } catch {
    return null
  }
  if (!v || typeof v !== "object" || Array.isArray(v) || v.sessionId !== sessionId) return null
  if (!ATTENTION_VERDICTS.includes(v.verdict) || v.verdict === "active") return null
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) return null
  if (typeof v.reason !== "string" || !v.reason.trim()) return null
  return {
    verdict: v.verdict,
    confidence: v.confidence,
    waitingOnYou: v.waitingOnYou === true,
    reason: cut(v.reason, 200),
  }
}

/** Merge a judge answer over the rules' verdict. The judge never overrides a
 *  rule-certain verdict (those are not sent to it) and never yields `active`. */
export function mergeJudged(rule, judged) {
  if (!judged) return rule
  return {
    ...rule,
    verdict: judged.verdict,
    confidence: judged.confidence,
    reason: judged.reason,
    waitingOnYou: judged.waitingOnYou || (NEEDS_YOU.has(judged.verdict) && judged.verdict !== "parked"),
    ambiguous: false,
    source: "judge",
    rule: { verdict: rule.verdict, confidence: rule.confidence, reason: rule.reason },
  }
}

// ── urgency + digest ─────────────────────────────────────────────────────

export function urgencyOf(item) {
  const flags = item.flags ?? []
  switch (item.verdict) {
    case "needs-reply":
      return 90
    case "stuck":
      return flags.includes("errored") || flags.includes("looping") || flags.includes("stalled") ? 85 : 75
    case "blocked":
      return 70
    case "done":
      return item.waitingOnYou ? 60 : 30
    case "parked":
      return 45
    case "superseded":
      return 25
    default:
      return 0
  }
}

export function fmtIdle(min) {
  if (typeof min !== "number" || !Number.isFinite(min)) return "?"
  const m = Math.round(min)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`
}

export function sortByUrgency(items) {
  return [...items].sort((a, b) => urgencyOf(b) - urgencyOf(a) || (b.idleMinutes ?? 0) - (a.idleMinutes ?? 0))
}

const SECTION_TITLES = {
  you: "Needs you",
  close: "Can be closed",
}

function sectionOf(item) {
  if (item.verdict === "active") return "active"
  if (item.verdict === "superseded" || (item.verdict === "done" && !item.waitingOnYou)) return "close"
  return "you"
}

function summaryLine(items) {
  const n = v => items.filter(i => i.verdict === v).length
  const you = items.filter(i => sectionOf(i) === "you").length
  const parts = [`${you} need you`]
  if (n("needs-reply")) parts.push(`${n("needs-reply")} to reply`)
  if (n("stuck")) parts.push(`${n("stuck")} stuck`)
  if (n("blocked")) parts.push(`${n("blocked")} blocked`)
  if (n("parked")) parts.push(`${n("parked")} parked`)
  const closable = items.filter(i => sectionOf(i) === "close").length
  if (closable) parts.push(`${closable} can close`)
  parts.push(`${n("active")} active`)
  return `${items.length} live · ${parts.join(" · ")}`
}

function verdictLabel(item) {
  const flags = item.flags ?? []
  const sub = flags.includes("looping") ? "looping" : flags.includes("errored") ? "errored" : flags.includes("unanswered") ? "unanswered" : flags.includes("never-ran") ? "never ran" : flags.includes("stalled") ? "stalled" : ""
  const base = item.verdict === "done" && item.waitingOnYou ? "done, waiting on you" : item.verdict
  return sub && item.verdict === "stuck" ? `stuck (${sub})` : base
}

/**
 * Items → `{ markdown, text, counts, ordered }`. `text` is plain (no
 * markdown) and capped at `maxChars` for chat delivery: excerpts are dropped
 * first, then the least urgent entries ("+N more"). Active sessions are only
 * counted — they need no attention.
 */
export function buildDigest(items, { maxChars = 3500, now = null } = {}) {
  const ordered = sortByUrgency((items ?? []).filter(Boolean))
  const attention = ordered.filter(i => i.verdict !== "active")
  const counts = {}
  for (const i of ordered) counts[i.verdict] = (counts[i.verdict] ?? 0) + 1
  const summary = summaryLine(ordered)

  const md = ["# Steward — what needs you", "", summary + (now ? ` · ${now}` : ""), ""]
  for (const key of ["you", "close"]) {
    const group = attention.filter(i => sectionOf(i) === key)
    if (group.length === 0) continue
    md.push(`## ${SECTION_TITLES[key]} (${group.length})`, "")
    group.forEach((i, n) => {
      md.push(`${n + 1}. **${i.title}** \`${i.sessionId}\` — ${verdictLabel(i)} · idle ${fmtIdle(i.idleMinutes)}`)
      md.push(`   ${i.reason}`)
      if (i.excerpt) md.push(`   > ${i.excerpt}`)
    })
    md.push("")
  }
  const activeCount = counts.active ?? 0
  if (attention.length === 0) md.push("Nothing needs you right now.", "")
  if (activeCount > 0) md.push(`${activeCount} session(s) actively working — no action.`)

  const render = (withExcerpt, limit) => {
    const lines = [`STEWARD — ${summary}`]
    let shown = 0
    for (const key of ["you", "close"]) {
      const group = attention.filter(i => sectionOf(i) === key)
      if (group.length === 0) continue
      const part = []
      for (const i of group) {
        if (shown >= limit) break
        const block = [`${shown + 1}. ${i.title} (${i.sessionId}) — ${verdictLabel(i)}, idle ${fmtIdle(i.idleMinutes)}`, `   ${i.reason}`]
        if (withExcerpt && i.excerpt) block.push(`   > ${cut(i.excerpt, 140)}`)
        part.push(...block)
        shown++
      }
      if (part.length) lines.push("", SECTION_TITLES[key].toUpperCase(), ...part)
    }
    if (attention.length === 0) lines.push("", "Nothing needs you right now.")
    const more = attention.length - shown
    if (more > 0) lines.push("", `+${more} more (lower priority)`)
    return lines.join("\n")
  }
  let text = render(true, attention.length)
  if (text.length > maxChars) text = render(false, attention.length)
  for (let limit = attention.length - 1; text.length > maxChars && limit > 0; limit--) text = render(false, limit)

  return { markdown: md.join("\n").trimEnd(), text, counts, ordered }
}
