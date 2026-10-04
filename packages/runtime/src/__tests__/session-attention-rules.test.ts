/**
 * Pure unit tests for the `session-attention` workflow's decision module —
 * `attention.mjs` (verdict rules, judge parsing, urgency, digest) and
 * `entry.mjs` (settings, scan, judge queue, item building). Loads the REAL
 * shipped modules from the app bundle, the same ones the workflow runs.
 * No daemon, no I/O, no clock — every function takes nowMs/inputs explicitly
 * (except the two entry helpers that read Date.now() internally, which the
 * tests tolerate).
 */

import { beforeAll, describe, expect, it } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const MODULE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "session-steward",
  ".agentproto",
  "workflows",
  "session-attention",
)
const ATTENTION_PATH = join(MODULE_DIR, "attention.mjs")
const ENTRY_PATH = join(MODULE_DIR, "entry.mjs")

type AnyFn = (...args: any[]) => any

interface AttentionMod {
  ATTENTION_VERDICTS: string[]
  NEEDS_YOU: Set<string>
  DEFAULT_IDLE_MINUTES: number
  JUDGE_BELOW: number
  displayTitle: AnyFn
  detectRepetition: AnyFn
  endsWithAsk: AnyFn
  mentionsBlocker: AnyFn
  lastTurn: AnyFn
  lastAssistantText: AnyFn
  lastTurnErrored: AnyFn
  detectToolLoop: AnyFn
  normalizeTitle: AnyFn
  findNewerSiblings: AnyFn
  excerptOf: AnyFn
  classifyAttention: AnyFn
  buildAttentionPrompt: AnyFn
  parseAttentionVerdict: AnyFn
  mergeJudged: AnyFn
  urgencyOf: AnyFn
  fmtIdle: AnyFn
  sortByUrgency: AnyFn
  buildDigest: AnyFn
}

interface EntryMod {
  resolveSettings: AnyFn
  scanSessions: AnyFn
  foldEvidence: AnyFn
  judgeEvidenceOf: AnyFn
  buildJudgeQueue: AnyFn
  guardIdle: AnyFn
  buildItems: AnyFn
  parseJudgeItem: AnyFn
  buildAttentionDigest: AnyFn
  default: { id: string; steps: Array<{ id: string }> }
}

let att: AttentionMod
let entry: EntryMod
beforeAll(async () => {
  att = (await import(ATTENTION_PATH)) as AttentionMod
  entry = (await import(ENTRY_PATH)) as EntryMod
})

const NOW = Date.parse("2026-10-02T14:00:00Z")
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

const SENTENCE = "Je vérifie l'état du pipeline de déploiement."
const LOOP_TEXT = `${SENTENCE} `.repeat(12).trim()

const digestItem = (over: Record<string, unknown>) => ({
  sessionId: "sess_x",
  title: "A session",
  verdict: "parked",
  confidence: 0.4,
  reason: "stopped",
  flags: [],
  waitingOnYou: false,
  idleMinutes: 30,
  excerpt: "",
  ...over,
})

// ── constants ─────────────────────────────────────────────────────────────

describe("attention — constants", () => {
  it("pins the verdict set, needs-you set and thresholds", () => {
    expect(att.ATTENTION_VERDICTS).toEqual(["needs-reply", "blocked", "stuck", "done", "superseded", "active", "parked"])
    expect(att.NEEDS_YOU.has("stuck")).toBe(true)
    expect(att.NEEDS_YOU.has("needs-reply")).toBe(true)
    expect(att.NEEDS_YOU.has("parked")).toBe(true)
    expect(att.NEEDS_YOU.has("done")).toBe(false)
    expect(att.DEFAULT_IDLE_MINUTES).toBe(10)
    expect(att.JUDGE_BELOW).toBe(0.9)
  })
})

// ── classifyAttention ──────────────────────────────────────────────────────

describe("attention — classifyAttention", () => {
  it("watchdog: idle + 12x repeated sentence + errored turn -> stuck, >= 0.9, looping+errored", () => {
    const r = att.classifyAttention(
      {
        sessionId: "sess_watch",
        idleMinutes: 45,
        busy: false,
        tokensIn: 1200,
        tokensOut: 800,
        turns: [
          { role: "user", text: "Surveille le déploiement" },
          { role: "assistant", text: LOOP_TEXT },
        ],
        lastTurnErroredAt: at(5),
        lastTurnError: "tool timeout",
        minutesSinceUserMessage: 30,
      },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r.verdict).toBe("stuck")
    expect(r.confidence).toBeGreaterThanOrEqual(0.9)
    expect(r.flags).toContain("looping")
    expect(r.flags).toContain("errored")
  })

  it("never ran (0 tokens in and out) -> stuck, even when busy", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 0, tokensOut: 0, idleMinutes: 30, busy: true, turns: [] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "stuck", confidence: 0.95, flags: ["never-ran"] })
  })

  it("needs-reply at 0.95 when awaiting input and its last message asks", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 30, busy: false, awaitingInput: true, turns: [{ role: "assistant", text: "Veux-tu que je continue ?" }] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "needs-reply", confidence: 0.95, flags: ["awaiting-input"] })
  })

  it("needs-reply at 0.85 when awaiting input without an ask (judge reviews)", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 30, busy: false, awaitingInput: true, turns: [{ role: "assistant", text: "working on it" }] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "needs-reply", confidence: 0.85, flags: ["awaiting-input"] })
  })

  it("active when idle is under the threshold", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 3, busy: false, turns: [{ role: "assistant", text: "still working" }] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "active", confidence: 0.8 })
  })

  it("needs-reply when the last assistant message ends with a question", () => {
    const r = att.classifyAttention(
      {
        sessionId: "s",
        tokensIn: 10,
        tokensOut: 5,
        idleMinutes: 30,
        busy: false,
        turns: [
          { role: "user", text: "continue ?" },
          { role: "assistant", text: "Veux-tu que je continue ?" },
        ],
      },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "needs-reply", confidence: 0.8, flags: ["asks"] })
  })

  it("superseded when continuedTo is set", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 30, busy: false, continuedTo: "sess_new", turns: [{ role: "assistant", text: "Je passe la main." }] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "superseded", confidence: 0.9, flags: ["continued"] })
  })

  it("done when the PR is merged and it asked nothing", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 30, busy: false, worktree: { pr: { state: "merged" } }, turns: [{ role: "assistant", text: "Tout est livré." }] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "done", confidence: 0.8, flags: ["pr-merged"] })
  })

  it("parked (ambiguous) when idle with no ask, error or conclusion", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 30, busy: false, turns: [{ role: "assistant", text: "Le travail est terminé." }] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "parked", confidence: 0.4 })
    expect(r.ambiguous).toBe(true)
  })

  it("stuck (tool loop) when busy with a high repeated-tool ratio", () => {
    const r = att.classifyAttention(
      {
        sessionId: "s",
        tokensIn: 10,
        tokensOut: 5,
        idleMinutes: 12,
        busy: true,
        toolStats: { total: 10, ratio: 0.1, topCommandCount: 6, topCommand: "make build" },
        turns: [],
      },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "stuck", confidence: 0.75, flags: ["looping"] })
  })

  it("stuck (stalled) when busy past the stall window", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 30, busy: true, turns: [] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "stuck", confidence: 0.8, flags: ["stalled"] })
  })

  it("active when busy and working normally", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 5, busy: true, turns: [] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "active", confidence: 0.9 })
  })

  it("stuck (unanswered) when the last turn is the user's message", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 30, busy: false, turns: [{ role: "user", text: "Tu es encore là ?" }] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "stuck", confidence: 0.7, flags: ["unanswered"] })
  })

  it("stuck (errored) when the last turn errored after the user's message and nothing resumed", () => {
    const r = att.classifyAttention(
      {
        sessionId: "s",
        tokensIn: 10,
        tokensOut: 5,
        idleMinutes: 30,
        busy: false,
        lastTurnErroredAt: at(5),
        lastTurnError: "boom",
        minutesSinceUserMessage: 60,
        turns: [{ role: "assistant", text: "working" }],
      },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "stuck", confidence: 0.9, flags: ["errored"] })
  })

  it("done when an outcome of done is recorded", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 30, busy: false, outcome: { verdict: "done" }, turns: [{ role: "assistant", text: "Rapport final." }] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "done", confidence: 0.85 })
  })

  it("done when the last act was message_parent(kind:done)", () => {
    const r = att.classifyAttention(
      {
        sessionId: "s",
        tokensIn: 10,
        tokensOut: 5,
        idleMinutes: 30,
        busy: false,
        lastToolCall: { command: 'message_parent {"kind":"done"}' },
        turns: [{ role: "assistant", text: "Terminé." }],
      },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "done", confidence: 0.8 })
  })

  it("blocked when the last message mentions a blocker", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 30, busy: false, turns: [{ role: "assistant", text: "I am still blocked on the CI pipeline." }] },
      { nowMs: NOW, idleMinutes: 10 },
    )
    expect(r).toMatchObject({ verdict: "blocked", confidence: 0.6, flags: ["blocker-mentioned"] })
  })

  it("superseded when a newer sibling covers the same title", () => {
    const r = att.classifyAttention(
      { sessionId: "s", tokensIn: 10, tokensOut: 5, idleMinutes: 30, busy: false, turns: [{ role: "assistant", text: "Fix applied." }] },
      { nowMs: NOW, idleMinutes: 10, title: "Fix the login bug", siblings: [{ id: "sess_new", title: "Fix the login bug", idleMinutes: 5 }] },
    )
    expect(r).toMatchObject({ verdict: "superseded", confidence: 0.65, flags: ["sibling"] })
  })

  it("never returns active for an idle (>= threshold), not-busy session with a finished turn", () => {
    const base = { tokensIn: 100, tokensOut: 50, idleMinutes: 30, busy: false }
    const shapes: Array<[string, Record<string, unknown>]> = [
      ["plain finished", { turns: [{ role: "assistant", text: "All done here." }] }],
      ["asks", { turns: [{ role: "assistant", text: "Veux-tu que je continue ?" }] }],
      ["merged", { turns: [{ role: "assistant", text: "Shipped." }], worktree: { pr: { state: "merged" } } }],
      ["blocked", { turns: [{ role: "assistant", text: "Still blocked on the CI." }] }],
      ["unanswered user", { turns: [{ role: "user", text: "hello?" }] }],
      ["continued", { turns: [{ role: "assistant", text: "Moving on." }], continuedTo: "sess_new" }],
      ["outcome done", { turns: [{ role: "assistant", text: "Done." }], outcome: { verdict: "done" } }],
      ["errored", { turns: [{ role: "assistant", text: "working" }], lastTurnErroredAt: at(5), minutesSinceUserMessage: 60 }],
    ]
    const verdicts = shapes.map(([, over]) => att.classifyAttention({ sessionId: "s", ...base, ...over }, { nowMs: NOW, idleMinutes: 10 }).verdict)
    expect(verdicts).not.toContain("active")
  })
})

// ── text signals ──────────────────────────────────────────────────────────

describe("attention — detectRepetition", () => {
  it("detects the same sentence repeated 12 times", () => {
    const rep = att.detectRepetition(LOOP_TEXT)
    expect(rep).not.toBeNull()
    expect(rep.count).toBe(12)
  })

  it("returns null for ordinary prose", () => {
    const prose = "The committee reviewed the quarterly results and approved the new budget. Everyone agreed the plan was sound and ready to present to the board next week."
    expect(att.detectRepetition(prose)).toBeNull()
  })

  it("returns null for short strings and empty input", () => {
    expect(att.detectRepetition("short string")).toBeNull()
    expect(att.detectRepetition("")).toBeNull()
  })

  it("detects a repeated trailing run", () => {
    const tailRun = `Some intro text here that is a bit longer. ${"x".repeat(40)} ${"x".repeat(40)} ${"x".repeat(40)}`
    const rep = att.detectRepetition(tailRun)
    expect(rep).not.toBeNull()
    expect(rep.count).toBeGreaterThanOrEqual(3)
  })
})

describe("attention — endsWithAsk", () => {
  it("true for EN questions and ask phrases", () => {
    expect(att.endsWithAsk("The tests pass. Should I deploy?")).toBe(true)
    expect(att.endsWithAsk("The build finished. Shall we merge the branch now?")).toBe(true)
    expect(att.endsWithAsk("I have pushed the branch. Waiting for your go.")).toBe(true)
  })

  it("true for FR asks", () => {
    expect(att.endsWithAsk("Veux-tu que je continue ?")).toBe(true)
    expect(att.endsWithAsk("J'attends ton feu vert pour déployer.")).toBe(true)
  })

  it("false for statements without an ask", () => {
    expect(att.endsWithAsk("I have finished the work and pushed everything to the branch.")).toBe(false)
    expect(att.endsWithAsk("J'ai terminé le travail et poussé les modifications.")).toBe(false)
  })

  it("false for empty or non-string input", () => {
    expect(att.endsWithAsk("")).toBe(false)
    expect(att.endsWithAsk(undefined)).toBe(false)
  })
})

describe("attention — mentionsBlocker", () => {
  it("true for blocker mentions", () => {
    expect(att.mentionsBlocker("Still blocked on the CI pipeline.")).toBe(true)
    expect(att.mentionsBlocker("Il manque le token pour continuer.")).toBe(true)
  })

  it("false otherwise", () => {
    expect(att.mentionsBlocker("Everything is done and merged.")).toBe(false)
  })
})

// ── evidence accessors ────────────────────────────────────────────────────

describe("attention — evidence accessors", () => {
  it("lastTurn skips turns without string text", () => {
    const turns = [{ role: "user" }, { role: "assistant", text: "first" }, { role: "user", text: 42 }, { role: "assistant", text: "last" }]
    expect(att.lastTurn({ turns })).toMatchObject({ role: "assistant", text: "last" })
    expect(att.lastTurn({})).toBeNull()
  })

  it("lastAssistantText returns the last assistant text or empty", () => {
    const turns = [{ role: "user" }, { role: "assistant", text: "first" }, { role: "user", text: "u" }, { role: "assistant", text: "last" }]
    expect(att.lastAssistantText({ turns })).toBe("last")
    expect(att.lastAssistantText({ turns: [{ role: "user", text: "u" }] })).toBe("")
  })

  it("lastTurnErrored: error before the last user message is false", () => {
    expect(att.lastTurnErrored({ lastTurnErroredAt: at(60), minutesSinceUserMessage: 30 }, NOW)).toBe(false)
  })

  it("lastTurnErrored: error after the last user message, not busy, is true", () => {
    expect(att.lastTurnErrored({ lastTurnErroredAt: at(5), minutesSinceUserMessage: 30 }, NOW)).toBe(true)
    expect(att.lastTurnErrored({ lastTurnErroredAt: at(5) }, NOW)).toBe(true)
  })

  it("lastTurnErrored: false when busy, absent, or unparseable", () => {
    expect(att.lastTurnErrored({ lastTurnErroredAt: at(5), busy: true }, NOW)).toBe(false)
    expect(att.lastTurnErrored({ busy: false }, NOW)).toBe(false)
    expect(att.lastTurnErrored({ lastTurnErroredAt: "not-a-date" }, NOW)).toBe(false)
  })

  it("detectToolLoop: high repeated ratio over enough calls", () => {
    expect(att.detectToolLoop({ total: 10, ratio: 0.1, topCommandCount: 6, topCommand: "make build" })).toEqual({ count: 6, total: 10 })
  })

  it("detectToolLoop: null below thresholds, above ratio, or for useful loops", () => {
    expect(att.detectToolLoop({ total: 5, ratio: 0.1, topCommandCount: 6, topCommand: "make build" })).toBeNull()
    expect(att.detectToolLoop({ total: 10, ratio: 0.5, topCommandCount: 6, topCommand: "make build" })).toBeNull()
    expect(att.detectToolLoop({ total: 10, ratio: 0.1, topCommandCount: 3, topCommand: "make build" })).toBeNull()
    expect(att.detectToolLoop({ total: 10, ratio: 0.1, topCommandCount: 6, topCommand: "watch -n 5 gh pr view 1" })).toBeNull()
    expect(att.detectToolLoop(undefined)).toBeNull()
  })
})

// ── titles ────────────────────────────────────────────────────────────────

describe("attention — displayTitle / normalizeTitle / findNewerSiblings", () => {
  it("a real label wins", () => {
    expect(att.displayTitle({ label: "My work", title: "ignored" }, {})).toBe("My work")
  })

  it("an auto label falls back to the title", () => {
    expect(att.displayTitle({ label: "chat 04:14:05", title: "Real title" }, {})).toBe("Real title")
  })

  it("an auto label and auto title fall back to the first user turn", () => {
    expect(att.displayTitle({ label: "chat 04:14:05", title: "chat 04:14:05" }, { turns: [{ role: "user", text: "First question" }, { role: "assistant", text: "answer" }] })).toBe("First question")
  })

  it("falls back to the row id, evidence sessionId, then (untitled)", () => {
    expect(att.displayTitle({ id: "sess_9" }, {})).toBe("sess_9")
    expect(att.displayTitle({}, { sessionId: "sess_ev" })).toBe("sess_ev")
    expect(att.displayTitle({}, {})).toBe("(untitled)")
  })

  it("strips a leading [...] harness-notification prefix", () => {
    expect(att.displayTitle({ label: "[background task x completed] Deploy foo" }, {})).toBe("Deploy foo")
    expect(att.displayTitle({ label: "chat 04:14:05", title: "[background task x completed] Deploy foo" }, {})).toBe("Deploy foo")
    expect(att.displayTitle({ label: "chat 04:14:05" }, { turns: [{ role: "user", text: "[background task x completed] Deploy foo" }] })).toBe("Deploy foo")
  })

  it("a label that is only a notification falls back to the raw label", () => {
    expect(att.displayTitle({ label: "[background task x completed]" }, {})).toBe("[background task x completed]")
  })

  it("truncates to 70 chars with an ellipsis", () => {
    const t = att.displayTitle({ label: "y".repeat(100) }, {})
    expect(t).toHaveLength(70)
    expect(t).toContain("…")
  })

  it("normalizeTitle lowercases, masks digits and slices to 48", () => {
    expect(att.normalizeTitle("Fix the Login Bug 04")).toBe("fix the login bug #")
    expect(att.normalizeTitle("Chat 04:14:05")).toBe("chat #:#:#")
    expect(att.normalizeTitle("x".repeat(100))).toHaveLength(48)
  })

  it("findNewerSiblings: newer live sessions in the same cwd only", () => {
    const me = { id: "sess_me", cwd: "/repo", lastActivityAt: at(30) }
    const rows = [
      me,
      { id: "sess_newer", cwd: "/repo", lastActivityAt: at(5) },
      { id: "sess_older", cwd: "/repo", lastActivityAt: at(60) },
      { id: "sess_other", cwd: "/elsewhere", lastActivityAt: at(1) },
    ]
    expect(att.findNewerSiblings(rows, me, NOW)).toEqual([{ id: "sess_newer", title: "sess_newer", idleMinutes: 5 }])
  })

  it("findNewerSiblings honours the limit", () => {
    const me = { id: "sess_me", cwd: "/repo", lastActivityAt: at(30) }
    const rows = [me, { id: "sess_n1", cwd: "/repo", lastActivityAt: at(5) }, { id: "sess_n2", cwd: "/repo", lastActivityAt: at(8) }]
    expect(att.findNewerSiblings(rows, me, NOW, 1)).toHaveLength(1)
  })
})

// ── excerpt ───────────────────────────────────────────────────────────────

describe("attention — excerptOf", () => {
  it("tails the last assistant text to 220 chars", () => {
    const long = Array.from({ length: 75 }, (_, i) => `step${i} `).join("")
    const ex = att.excerptOf({ turns: [{ role: "user", text: "hi" }, { role: "assistant", text: long }] })
    expect(ex).toHaveLength(220)
    expect(ex[0]).toBe("…")
  })

  it("marks a repeated sentence with its count", () => {
    expect(att.excerptOf({ turns: [{ role: "assistant", text: LOOP_TEXT }] })).toContain("(x12)")
  })

  it("falls back to the last turn role when there is no assistant text", () => {
    expect(att.excerptOf({ turns: [{ role: "user", text: "hello" }] })).toBe("(user) hello")
    expect(att.excerptOf({})).toBe("")
  })
})

// ── judge parsing ─────────────────────────────────────────────────────────

describe("attention — parseAttentionVerdict / mergeJudged", () => {
  const verdict = (over: Record<string, unknown>) =>
    JSON.stringify({ sessionId: "sess_1", verdict: "needs-reply", confidence: 0.9, waitingOnYou: true, reason: "it asked something", ...over })

  it("accepts a valid JSON verdict", () => {
    expect(att.parseAttentionVerdict(verdict({}), "sess_1")).toEqual({ verdict: "needs-reply", confidence: 0.9, waitingOnYou: true, reason: "it asked something" })
  })

  it("accepts a ```json fence (with or without the json tag)", () => {
    expect(att.parseAttentionVerdict(`\`\`\`json\n${verdict({})}\n\`\`\``, "sess_1")).not.toBeNull()
    expect(att.parseAttentionVerdict(`\`\`\`\n${verdict({})}\n\`\`\``, "sess_1")).not.toBeNull()
  })

  it("rejects prose-wrapped JSON (not supported)", () => {
    expect(att.parseAttentionVerdict(`Here is my answer: ${verdict({})}`, "sess_1")).toBeNull()
  })

  it("rejects verdict active", () => {
    expect(att.parseAttentionVerdict(verdict({ verdict: "active" }), "sess_1")).toBeNull()
  })

  it("rejects out-of-range or non-numeric confidence", () => {
    expect(att.parseAttentionVerdict(verdict({ confidence: 1.5 }), "sess_1")).toBeNull()
    expect(att.parseAttentionVerdict(verdict({ confidence: -0.1 }), "sess_1")).toBeNull()
    expect(att.parseAttentionVerdict(verdict({ confidence: "high" }), "sess_1")).toBeNull()
  })

  it("rejects a missing or blank reason", () => {
    expect(att.parseAttentionVerdict(verdict({ reason: "  " }), "sess_1")).toBeNull()
    expect(att.parseAttentionVerdict(verdict({ reason: undefined }), "sess_1")).toBeNull()
  })

  it("rejects an unknown verdict or wrong sessionId", () => {
    expect(att.parseAttentionVerdict(verdict({ verdict: "bogus" }), "sess_1")).toBeNull()
    expect(att.parseAttentionVerdict(verdict({}), "sess_2")).toBeNull()
  })

  it("rejects empty, non-string and non-JSON input", () => {
    expect(att.parseAttentionVerdict("", "sess_1")).toBeNull()
    expect(att.parseAttentionVerdict(undefined, "sess_1")).toBeNull()
    expect(att.parseAttentionVerdict("not json", "sess_1")).toBeNull()
  })

  it("waitingOnYou defaults to false and reason is cut to 200 chars", () => {
    const parsed = att.parseAttentionVerdict(verdict({ waitingOnYou: false }), "sess_1")
    expect(parsed.waitingOnYou).toBe(false)
    expect(att.parseAttentionVerdict(verdict({ reason: "r".repeat(300) }), "sess_1").reason).toHaveLength(200)
  })

  it("mergeJudged keeps the rule verdict when the judge is null or invalid", () => {
    const rule = { verdict: "parked", confidence: 0.4, reason: "stopped", flags: [], waitingOnYou: false, ambiguous: true, source: "rules" }
    expect(att.mergeJudged(rule, null)).toBe(rule)
    expect(att.mergeJudged(rule, undefined)).toBe(rule)
  })

  it("mergeJudged folds a judge answer over the rules verdict", () => {
    const rule = { verdict: "parked", confidence: 0.4, reason: "stopped", flags: [], waitingOnYou: false, ambiguous: true, source: "rules" }
    const merged = att.mergeJudged(rule, { verdict: "needs-reply", confidence: 0.85, waitingOnYou: true, reason: "it asked" })
    expect(merged).toMatchObject({ verdict: "needs-reply", confidence: 0.85, waitingOnYou: true, source: "judge", ambiguous: false })
    expect(merged.rule).toMatchObject({ verdict: "parked", confidence: 0.4 })
  })

  it("mergeJudged never yields waitingOnYou for parked or done", () => {
    const rule = { verdict: "parked", confidence: 0.4, reason: "stopped", flags: [], waitingOnYou: false, ambiguous: true, source: "rules" }
    expect(att.mergeJudged(rule, { verdict: "parked", confidence: 0.6, waitingOnYou: false, reason: "still parked" }).waitingOnYou).toBe(false)
    expect(att.mergeJudged(rule, { verdict: "done", confidence: 0.9, waitingOnYou: false, reason: "delivered" }).waitingOnYou).toBe(false)
  })
})

// ── urgency + digest ──────────────────────────────────────────────────────

describe("attention — urgencyOf / fmtIdle / sortByUrgency", () => {
  it("orders needs-reply > stuck > blocked > done+waiting > parked > done > superseded > active", () => {
    expect(att.urgencyOf({ verdict: "needs-reply" })).toBe(90)
    expect(att.urgencyOf({ verdict: "stuck", flags: ["errored"] })).toBe(85)
    expect(att.urgencyOf({ verdict: "stuck", flags: ["looping"] })).toBe(85)
    expect(att.urgencyOf({ verdict: "stuck", flags: ["stalled"] })).toBe(85)
    expect(att.urgencyOf({ verdict: "stuck", flags: [] })).toBe(75)
    expect(att.urgencyOf({ verdict: "blocked" })).toBe(70)
    expect(att.urgencyOf({ verdict: "done", waitingOnYou: true })).toBe(60)
    expect(att.urgencyOf({ verdict: "parked" })).toBe(45)
    expect(att.urgencyOf({ verdict: "done", waitingOnYou: false })).toBe(30)
    expect(att.urgencyOf({ verdict: "superseded" })).toBe(25)
    expect(att.urgencyOf({ verdict: "active" })).toBe(0)
  })

  it("fmtIdle formats minutes for humans", () => {
    expect(att.fmtIdle(0)).toBe("0m")
    expect(att.fmtIdle(5)).toBe("5m")
    expect(att.fmtIdle(30)).toBe("30m")
    expect(att.fmtIdle(60)).toBe("1h")
    expect(att.fmtIdle(90)).toBe("1h 30m")
    expect(att.fmtIdle(1500)).toBe("1d 1h")
    expect(att.fmtIdle(Number.NaN)).toBe("?")
    expect(att.fmtIdle(undefined)).toBe("?")
  })

  it("sortByUrgency orders most urgent first", () => {
    const items = [
      digestItem({ sessionId: "s_active", verdict: "active", idleMinutes: 1 }),
      digestItem({ sessionId: "s_superseded", verdict: "superseded", idleMinutes: 2 }),
      digestItem({ sessionId: "s_done", verdict: "done", waitingOnYou: false, idleMinutes: 3 }),
      digestItem({ sessionId: "s_parked", verdict: "parked", idleMinutes: 4 }),
      digestItem({ sessionId: "s_done_wait", verdict: "done", waitingOnYou: true, idleMinutes: 5 }),
      digestItem({ sessionId: "s_blocked", verdict: "blocked", idleMinutes: 6 }),
      digestItem({ sessionId: "s_stuck", verdict: "stuck", flags: ["looping"], idleMinutes: 7 }),
      digestItem({ sessionId: "s_reply", verdict: "needs-reply", idleMinutes: 8 }),
    ]
    const sorted = att.sortByUrgency(items)
    expect(sorted.map((i: any) => i.sessionId)).toEqual(["s_reply", "s_stuck", "s_blocked", "s_done_wait", "s_parked", "s_done", "s_superseded", "s_active"])
  })

  it("sortByUrgency breaks ties by longer idle first and does not mutate the input", () => {
    const items = [digestItem({ sessionId: "s_young", verdict: "needs-reply", idleMinutes: 10 }), digestItem({ sessionId: "s_old", verdict: "needs-reply", idleMinutes: 50 })]
    const sorted = att.sortByUrgency(items)
    expect(sorted[0].sessionId).toBe("s_old")
    expect(items[0]!.sessionId).toBe("s_young")
    expect(sorted).not.toBe(items)
  })
})

describe("attention — buildDigest", () => {
  it("mixed verdicts: Needs you before Can be closed, counts correct, active only counted", () => {
    const d = att.buildDigest(
      [
        digestItem({ sessionId: "s1", title: "Asked a question", verdict: "needs-reply", confidence: 0.8, reason: "its last message asks you something", flags: ["asks"], waitingOnYou: true, idleMinutes: 30 }),
        digestItem({ sessionId: "s2", title: "Merged work", verdict: "done", confidence: 0.8, reason: "its PR is merged and it asked nothing", flags: ["pr-merged"], waitingOnYou: false, idleMinutes: 20 }),
        digestItem({ sessionId: "s3", title: "Superseded old", verdict: "superseded", confidence: 0.9, reason: "continued in sess_new", flags: ["continued"], waitingOnYou: false, idleMinutes: 40 }),
        digestItem({ sessionId: "s4", title: "Working now", verdict: "active", confidence: 0.9, reason: "working right now", flags: [], waitingOnYou: false, idleMinutes: 2 }),
      ],
      { now: "2026-10-02 14:00Z" },
    )
    expect(d.markdown).toContain("Needs you")
    expect(d.markdown.indexOf("Needs you")).toBeLessThan(d.markdown.indexOf("Can be closed"))
    expect(d.counts).toEqual({ "needs-reply": 1, done: 1, superseded: 1, active: 1 })
    expect(d.markdown).not.toContain("Working now")
    expect(d.ordered[0].verdict).toBe("needs-reply")
    expect(d.markdown).toContain("2026-10-02 14:00Z")
  })

  it("plain text never exceeds maxChars and ends with a +N more tail", () => {
    const many = Array.from({ length: 40 }, (_, i) => digestItem({ sessionId: `sess_${i}`, title: `t${i}`, idleMinutes: i + 1 }))
    const d = att.buildDigest(many, { maxChars: 400 })
    expect(d.text.length).toBeLessThanOrEqual(400)
    expect(d.text).toMatch(/\+\d+ more/)
    expect(d.counts).toEqual({ parked: 40 })
  })
})

describe("attention — buildAttentionPrompt", () => {
  it("embeds the session id, the rule verdict and the never-active instruction", () => {
    const prompt = att.buildAttentionPrompt({ sessionId: "sess_1", turns: [{ role: "assistant", text: "working" }] }, { verdict: "parked", confidence: 0.4, reason: "stopped" })
    expect(prompt).toContain("sess_1")
    expect(prompt).toContain("parked")
    expect(prompt).toContain("Never answer `active`")
  })
})

// ── entry.mjs — settings ──────────────────────────────────────────────────

describe("entry — resolveSettings", () => {
  it("defaults: idleMinutes 10, judge agent, maxJudged 20, maxChars 3500", () => {
    const d = entry.resolveSettings(undefined, undefined)
    expect(d.idleMinutes).toBe(10)
    expect(d.judge).toBe("agent")
    expect(d.judgeModel).toBeUndefined()
    expect(d.maxJudged).toBe(20)
    expect(d.maxSessions).toBe(80)
    expect(d.maxChars).toBe(3500)
    expect(d.includeChildren).toBe(false)
    expect(d.callerSessionId).toBeNull()
    expect(d.callerOrigin).toBeNull()
  })

  it("explicit overrides win", () => {
    const s = entry.resolveSettings(
      { idleMinutes: 5, judge: "rules", maxJudged: 3, maxSessions: 10, maxChars: 1000, includeChildren: true, callerSessionId: "s1", callerOrigin: "cron:job1" },
      undefined,
    )
    expect(s).toMatchObject({ idleMinutes: 5, judge: "rules", maxJudged: 3, maxSessions: 10, maxChars: 1000, includeChildren: true, callerSessionId: "s1", callerOrigin: "cron:job1" })
  })

  it("an unknown judge falls back to agent; judgeModel comes from the role or the explicit input", () => {
    expect(entry.resolveSettings({ judge: "llm" }, undefined).judge).toBe("agent")
    expect(entry.resolveSettings({}, { models: { "judge.session": "claude-x" } }).judgeModel).toBe("claude-x")
    expect(entry.resolveSettings({ judgeModel: "gpt-x" }, { models: { "judge.session": "claude-x" } }).judgeModel).toBe("gpt-x")
  })

  it("numeric bounds reject sub-minimum values (fall back to the default, not a clamp)", () => {
    expect(entry.resolveSettings({ maxChars: 100 }).maxChars).toBe(3500)
    expect(entry.resolveSettings({ maxSessions: 0 }).maxSessions).toBe(80)
    expect(entry.resolveSettings({ idleMinutes: -5 }).idleMinutes).toBe(10)
    expect(entry.resolveSettings({ maxJudged: 2.7 }).maxJudged).toBe(2)
  })
})

// ── entry.mjs — scan ──────────────────────────────────────────────────────

describe("entry — scanSessions", () => {
  const row = (over: Record<string, unknown>) => ({ id: "sess_x", status: "running", cwd: "/repo", lastActivityAt: at(10), ...over })

  it("drops the caller, its cron lineage, archived, pty, not-running and children of a live parent", () => {
    const live = {
      items: [
        row({ id: "sess_caller" }),
        row({ id: "sess_cron", origin: "cron:job1" }),
        row({ id: "sess_arch", archived: true }),
        row({ id: "sess_pty", pty: true }),
        row({ id: "sess_dead", status: "killed" }),
        row({ id: "sess_parent" }),
        row({ id: "sess_child", parentSessionId: "sess_parent" }),
        row({ id: "sess_child2", parentSessionId: "sess_parent", awaitingInput: true }),
        row({ id: "sess_orphan", parentSessionId: "sess_gone" }),
        row({ id: "sess_plain" }),
      ],
    }
    const settings = entry.resolveSettings({ callerSessionId: "sess_caller", callerOrigin: "cron:job1" }, undefined)
    const r = entry.scanSessions(live, settings, NOW)
    expect(r.candidates.map((c: any) => c.sessionId)).toEqual(["sess_parent", "sess_child2", "sess_orphan", "sess_plain"])
    expect(r.counts).toMatchObject({ live: 9, scanned: 4, overflow: 0, caller: 2, archived: 1, pty: 1, notRunning: 1, childOfLive: 1 })
  })

  it("includeChildren keeps children of a live parent", () => {
    const live = { items: [row({ id: "sess_parent" }), row({ id: "sess_child", parentSessionId: "sess_parent" })] }
    const settings = entry.resolveSettings({ includeChildren: true }, undefined)
    const r = entry.scanSessions(live, settings, NOW)
    expect(r.candidates.map((c: any) => c.sessionId)).toEqual(["sess_parent", "sess_child"])
    expect(r.counts.childOfLive).toBe(0)
  })

  it("caps at maxSessions and reports overflow", () => {
    const live = { items: [row({ id: "sess_parent" }), row({ id: "sess_child2", awaitingInput: true }), row({ id: "sess_orphan" }), row({ id: "sess_plain" })] }
    const settings = entry.resolveSettings({ maxSessions: 2 }, undefined)
    const r = entry.scanSessions(live, settings, NOW)
    expect(r.candidates).toHaveLength(2)
    expect(r.counts).toMatchObject({ scanned: 2, overflow: 2 })
  })

  it("sorts candidates by idle ascending (most recently active first)", () => {
    const live = { items: [row({ id: "sess_idle", lastActivityAt: at(40) }), row({ id: "sess_recent", lastActivityAt: at(2) }), row({ id: "sess_mid", lastActivityAt: at(20) })] }
    const r = entry.scanSessions(live, entry.resolveSettings(undefined, undefined), NOW)
    expect(r.candidates.map((c: any) => c.sessionId)).toEqual(["sess_recent", "sess_mid", "sess_idle"])
  })
})

// ── entry.mjs — guard / judge items ───────────────────────────────────────

describe("entry — guardIdle", () => {
  const active = { verdict: "active", confidence: 0.9, reason: "working right now", waitingOnYou: false }

  it("rewrites an active+idle (not busy) item to parked", () => {
    const g = entry.guardIdle(active, { busy: false, idleMinutes: 30 }, 10)
    expect(g).toMatchObject({ verdict: "parked", waitingOnYou: false, guarded: true })
    expect(g.reason).toContain("idle 30m")
  })

  it("leaves a busy item, a fresh item and a non-active item alone", () => {
    expect(entry.guardIdle(active, { busy: true, idleMinutes: 30 }, 10)).toBe(active)
    expect(entry.guardIdle(active, { busy: false, idleMinutes: 5 }, 10)).toBe(active)
    const parked = { verdict: "parked", confidence: 0.4, reason: "stopped", waitingOnYou: false }
    expect(entry.guardIdle(parked, { busy: false, idleMinutes: 30 }, 10)).toBe(parked)
  })
})

describe("entry — parseJudgeItem", () => {
  it("garbage leaves no verdict (the rules verdict stands)", () => {
    const r = entry.parseJudgeItem({ item: { sessionId: "s1" }, steps: { judgeOne: { text: "total garbage" } } })
    expect(r.sessionId).toBe("s1")
    expect(r.verdict).toBeUndefined()
  })

  it("a valid judge answer is parsed", () => {
    const r = entry.parseJudgeItem({
      item: { sessionId: "s1" },
      steps: { judgeOne: { text: JSON.stringify({ sessionId: "s1", verdict: "blocked", confidence: 0.7, reason: "waiting on CI" }) } },
    })
    expect(r).toMatchObject({ sessionId: "s1", verdict: "blocked", confidence: 0.7, waitingOnYou: false, reason: "waiting on CI" })
  })
})

// ── entry.mjs — evidence folding / judge queue / items ────────────────────

describe("entry — foldEvidence", () => {
  const b = {
    item: { sessionId: "s1", row: { id: "s1", label: "My session", lastActivityAt: at(30) } },
    steps: {
      evidenceOne: { sessionId: "s1", idleMinutes: 45, busy: false, tokensIn: 10, tokensOut: 5, turns: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello there" }] },
      liveSessions: { items: [{ id: "s1", cwd: "/repo", lastActivityAt: at(30) }] },
      settings: { idleMinutes: 10 },
    },
  }

  it("folds evidence, row and rule into an entry", () => {
    const e = entry.foldEvidence(b)
    expect(e.sessionId).toBe("s1")
    expect(e.title).toBe("My session")
    expect(e.evidence.idleMinutes).toBe(45)
    expect(e.rule.verdict).toBe("parked")
  })

  it("throws when the evidence answers for another session", () => {
    const bad = { ...b, steps: { ...b.steps, evidenceOne: { ...b.steps.evidenceOne, sessionId: "s2" } } }
    expect(() => entry.foldEvidence(bad)).toThrow(/expected 's1'/)
  })
})

describe("entry — buildJudgeQueue", () => {
  const entries = [
    { sessionId: "s1", title: "a", rule: { verdict: "parked", confidence: 0.4, reason: "stopped", ambiguous: true }, evidence: { sessionId: "s1", idleMinutes: 30, turns: [] } },
    { sessionId: "s2", title: "b", rule: { verdict: "active", confidence: 0.9, reason: "working", ambiguous: false }, evidence: { sessionId: "s2", idleMinutes: 5, turns: [] } },
    { sessionId: "s3", title: "c", rule: { verdict: "parked", confidence: 0.4, reason: "stopped", ambiguous: true }, evidence: { sessionId: "s3", idleMinutes: 10, turns: [] } },
  ]

  it("queues ambiguous entries, most recently active first, with prompts", () => {
    const q = entry.buildJudgeQueue(entries, { judge: "agent", maxJudged: 20 })
    expect(q.map((x: any) => x.sessionId)).toEqual(["s3", "s1"])
    expect(q[0].prompt).toContain("s3")
  })

  it("rules-only backend queues nothing; maxJudged caps the queue", () => {
    expect(entry.buildJudgeQueue(entries, { judge: "rules" })).toEqual([])
    expect(entry.buildJudgeQueue(entries, { judge: "agent", maxJudged: 1 }).map((x: any) => x.sessionId)).toEqual(["s3"])
  })
})

describe("entry — buildItems", () => {
  const entries = [
    {
      sessionId: "s1",
      title: "Asked",
      rule: { verdict: "parked", confidence: 0.4, reason: "stopped", flags: [], waitingOnYou: false, ambiguous: true, source: "rules" },
      evidence: { idleMinutes: 30, busy: false, turns: [{ role: "assistant", text: "done work" }] },
      row: {},
    },
    {
      sessionId: "s2",
      title: "Working",
      rule: { verdict: "active", confidence: 0.9, reason: "working right now", flags: [], waitingOnYou: false, ambiguous: false, source: "rules" },
      evidence: { idleMinutes: 45, busy: false, turns: [{ role: "assistant", text: "still going" }] },
      row: {},
    },
  ]
  const judgeQueue = [{ sessionId: "s1", prompt: "..." }]
  const judgeResult = [{ sessionId: "s1", verdict: "needs-reply", confidence: 0.85, waitingOnYou: true, reason: "it asked something" }]

  it("merges the judge verdict and guards idle actives", () => {
    const items = entry.buildItems(entries, judgeQueue, judgeResult, [], { idleMinutes: 10 })
    expect(items[0]).toMatchObject({ sessionId: "s1", verdict: "needs-reply", source: "judge", waitingOnYou: true })
    expect(items[0].rule.verdict).toBe("parked")
    expect(items[1]).toMatchObject({ sessionId: "s2", verdict: "parked", guarded: true })
  })

  it("evidence failures become parked no-evidence items", () => {
    const items = entry.buildItems(entries, [], [], [{ item: { sessionId: "s9", row: { id: "s9" } }, error: "timeout" }], { idleMinutes: 10 })
    const failed = items.find((i: any) => i.sessionId === "s9")
    expect(failed).toMatchObject({ verdict: "parked", confidence: 0, flags: ["no-evidence"], source: "none" })
  })
})

describe("entry — judgeEvidenceOf / buildAttentionDigest / manifest", () => {
  it("judgeEvidenceOf compacts evidence under the size cap", () => {
    const longTurns = Array.from({ length: 20 }, () => ({ role: "assistant", text: "x".repeat(500) }))
    const ev = entry.judgeEvidenceOf({ sessionId: "s1", title: "T", evidence: { turns: longTurns, busy: false }, siblings: [{ id: "s2" }] })
    expect(JSON.stringify(ev).length).toBeLessThanOrEqual(6000)
    expect(ev.title).toBe("T")
    expect(ev.newerSiblings).toHaveLength(1)
  })

  it("buildAttentionDigest builds the digest from items and settings", () => {
    const b = {
      steps: {
        settings: entry.resolveSettings({ maxChars: 1000 }, undefined),
        items: [digestItem({ sessionId: "s1", title: "Asked", verdict: "needs-reply" }), digestItem({ sessionId: "s2", title: "Merged", verdict: "done", waitingOnYou: false })],
      },
    }
    const d = entry.buildAttentionDigest(b)
    expect(d.markdown).toContain("Needs you")
    expect(d.ordered[0].verdict).toBe("needs-reply")
    expect(d.counts).toEqual({ "needs-reply": 1, done: 1 })
  })

  it("the workflow manifest is the session-attention graph", () => {
    expect(entry.default.id).toBe("session-attention")
    expect(entry.default.steps.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(["scan", "judgeQueue", "items", "digest"]))
  })
})
