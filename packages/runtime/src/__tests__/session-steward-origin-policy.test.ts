/**
 * Pure unit tests for the session steward's origin policy — the decision of
 * whether a candidate may be CLOSED or only FLAGGED. Loads the REAL shipped
 * `origin-policy.mjs` from the app bundle (the same module `entry.mjs`
 * imports), so the policy the workflow runs is the one pinned here. No
 * daemon, no I/O.
 */

import { beforeAll, describe, expect, it } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "session-steward",
  ".agentproto",
  "workflows",
  "session-steward",
  "origin-policy.mjs",
)

interface SessionLike {
  origin?: string
  parentSessionId?: string
}

interface Policy {
  userOrigins?: unknown[]
  closableOrigins?: unknown[]
}

interface DecideArgs {
  session?: SessionLike
  planClass?: string
  verdict?: string
  confidence?: number
  apply?: boolean
  policy?: Policy
  minConfidence?: number
}

interface OriginPolicyModule {
  DEFAULT_USER_ORIGINS: string[]
  DEFAULT_CLOSABLE_ORIGINS: string[]
  USER_ORIGIN_REASON: string
  matchesOrigin: (origin: unknown, pattern: unknown) => boolean
  resolveOriginPolicy: (policy?: Policy) => { userOrigins: string[]; closableOrigins: string[] }
  classifyOrigin: (session?: SessionLike, policy?: Policy) => "user" | "closable"
  decideAction: (args?: DecideArgs) => { action: "close" | "flag" | "skip"; reason: string }
}

let mod: OriginPolicyModule

beforeAll(async () => {
  mod = (await import(MODULE_PATH)) as OriginPolicyModule
})

// ── the origin classes ───────────────────────────────────────────────────

const CRON = { origin: "cron:kill-idle-sessions" }
const GATE = { origin: "gate" }
/** An executor: a session with a parent, no origin of its own. */
const EXECUTOR = { parentSessionId: "sess_parent" }
/** An executor whose own origin is not in either list — still closable. */
const EXECUTOR_UNKNOWN_ORIGIN = { origin: "codex", parentSessionId: "sess_parent" }
const CHAT = { origin: "chat-starter" }
const VSCODE = { origin: "vscode" }
/** A root with no origin and no parent — human-launched. */
const HUMAN_ROOT: SessionLike = {}
/** A root with an origin in neither list — conservatively user-origin. */
const UNKNOWN_ROOT = { origin: "codex" }

/** `decideAction` with apply/minConfidence defaulted, the way entry.mjs calls it. */
const decide = (args: DecideArgs) => mod.decideAction({ apply: true, minConfidence: 0.8, ...args })

// ── origin matching ──────────────────────────────────────────────────────

describe("origin policy — matchesOrigin", () => {
  it("exact match", () => {
    expect(mod.matchesOrigin("gate", "gate")).toBe(true)
    expect(mod.matchesOrigin("cron:a", "gate")).toBe(false)
  })

  it("a trailing `*` is a prefix wildcard", () => {
    expect(mod.matchesOrigin("cron:kill-idle-sessions", "cron:*")).toBe(true)
    expect(mod.matchesOrigin("cron:", "cron:*")).toBe(true)
    expect(mod.matchesOrigin("cron", "cron:*")).toBe(false)
    expect(mod.matchesOrigin("gate", "cron:*")).toBe(false)
  })

  it("non-strings / empties never match", () => {
    expect(mod.matchesOrigin(undefined, "cron:*")).toBe(false)
    expect(mod.matchesOrigin("gate", undefined)).toBe(false)
    expect(mod.matchesOrigin("", "*")).toBe(false)
    expect(mod.matchesOrigin("gate", "  ")).toBe(false)
  })
})

describe("origin policy — resolveOriginPolicy", () => {
  it("defaults when the policy is absent or empty", () => {
    expect(mod.resolveOriginPolicy()).toEqual({
      userOrigins: mod.DEFAULT_USER_ORIGINS,
      closableOrigins: mod.DEFAULT_CLOSABLE_ORIGINS,
    })
    expect(mod.resolveOriginPolicy({ userOrigins: [], closableOrigins: [] })).toEqual({
      userOrigins: mod.DEFAULT_USER_ORIGINS,
      closableOrigins: mod.DEFAULT_CLOSABLE_ORIGINS,
    })
  })

  it("a non-empty list overrides the default, trimmed and filtered", () => {
    expect(mod.resolveOriginPolicy({ userOrigins: [" team ", 42, ""], closableOrigins: ["gate"] })).toEqual({
      userOrigins: ["team"],
      closableOrigins: ["gate"],
    })
  })
})

describe("origin policy — classifyOrigin", () => {
  it.each([
    ["cron:*", CRON, "closable"],
    ["gate", GATE, "closable"],
    ["workflow step session (root)", { origin: "workflow" }, "closable"],
    ["review lane (root)", { origin: "review" }, "closable"],
    ["model-bench harness (root)", { origin: "model-bench" }, "closable"],
    ["model-bench smoketest (root)", { origin: "model-bench-smoketest" }, "closable"],
    ["model-bench sweep variant (root)", { origin: "model-bench:sweep-7" }, "closable"],
    ["bare cron scheduler origin", { origin: "cron" }, "closable"],
    ["routine registrar fire", { origin: "routine:session-steward-hourly" }, "closable"],
    ["inbound webhook", { origin: "webhook" }, "closable"],
    ["cli stays a human at a keyboard", { origin: "cli" }, "user"],
    ["executor (parent, no origin)", EXECUTOR, "closable"],
    ["executor with an unknown origin", EXECUTOR_UNKNOWN_ORIGIN, "closable"],
    ["chat-starter", CHAT, "user"],
    ["vscode", VSCODE, "user"],
    ["human root (no origin, no parent)", HUMAN_ROOT, "user"],
    ["unknown root origin", UNKNOWN_ROOT, "user"],
    ["a vscode executor stays user", { origin: "vscode", parentSessionId: "p" }, "user"],
    ["a chat-starter executor stays user", { origin: "chat-starter", parentSessionId: "p" }, "user"],
  ])("%s → %s", (_label, session, expected) => {
    expect(mod.classifyOrigin(session)).toBe(expected)
  })

  it("a custom userOrigins list adds a user origin", () => {
    expect(mod.classifyOrigin({ origin: "cowork" }, { userOrigins: ["cowork"] })).toBe("user")
  })

  it("moving an origin out of userOrigins and into closableOrigins makes it closable", () => {
    expect(mod.classifyOrigin(CHAT, { userOrigins: ["nothing"], closableOrigins: ["chat-starter"] })).toBe("closable")
  })
})

// ── decideAction: every plan class × verdict, apply vs dry run ───────────

describe("decideAction — harness origins (B2)", () => {
  it("a model-bench session with a certain close is closed, not flagged", () => {
    const d = decide({ session: { origin: "model-bench" }, planClass: "stuck" })
    expect(d.action).toBe("close")
  })

  it("a user-origin bench-like name is still bounded when listed as user", () => {
    const d = decide({ session: { origin: "model-bench" }, planClass: "close", policy: { userOrigins: ["model-bench"] } })
    expect(d.action).toBe("flag")
  })
})

describe("decideAction — rule-certain classes (apply)", () => {
  it.each([
    ["close", CRON, "close"],
    ["close", EXECUTOR, "close"],
    ["close", GATE, "close"],
    ["stuck", CRON, "close"],
    ["stuck", EXECUTOR, "close"],
  ])("%s + %o → %s", (planClass, session, action) => {
    expect(decide({ session, planClass }).action).toBe(action)
  })

  it.each([
    ["close", CHAT],
    ["close", VSCODE],
    ["close", HUMAN_ROOT],
    ["stuck", CHAT],
    ["stuck", HUMAN_ROOT],
    ["close", UNKNOWN_ROOT],
  ])("%s + user-origin %o → flag (origine utilisateur), never close", (planClass, session) => {
    const d = decide({ session, planClass })
    expect(d.action).toBe("flag")
    expect(d.reason).toBe(mod.USER_ORIGIN_REASON)
  })
})

describe("decideAction — judge verdicts at/above threshold (apply)", () => {
  it.each([
    ["done", CRON, "close"],
    ["abandoned", EXECUTOR, "close"],
    ["blocked", CRON, "flag"],
    ["needs-input", CRON, "flag"],
    ["blocked", CHAT, "flag"],
    ["needs-input", VSCODE, "flag"],
  ])("judge %s + %o → %s", (verdict, session, action) => {
    expect(decide({ session, planClass: "judge", verdict, confidence: 0.9 }).action).toBe(action)
  })

  it.each([
    ["done", CHAT],
    ["done", VSCODE],
    ["done", HUMAN_ROOT],
    ["abandoned", CHAT],
    ["done", UNKNOWN_ROOT],
  ])("judge %s + user-origin %o → flag (origine utilisateur), even confident", (verdict, session) => {
    const d = decide({ session, planClass: "judge", verdict, confidence: 0.99 })
    expect(d.action).toBe("flag")
    expect(d.reason).toBe(mod.USER_ORIGIN_REASON)
  })
})

describe("decideAction — skips", () => {
  it("judge `active` is never acted on", () => {
    expect(decide({ session: CRON, planClass: "judge", verdict: "active", confidence: 0.99 }).action).toBe("skip")
  })

  it("a verdict below minConfidence is skipped", () => {
    const d = decide({ session: CRON, planClass: "judge", verdict: "done", confidence: 0.5 })
    expect(d.action).toBe("skip")
    expect(d.reason).toContain("confiance")
  })

  it("a malformed reply (active / confidence 0) is skipped", () => {
    expect(decide({ session: CRON, planClass: "judge", verdict: "active", confidence: 0 }).action).toBe("skip")
  })

  it("keep class is skipped", () => {
    expect(decide({ session: CRON, planClass: "keep" }).action).toBe("skip")
  })

  it("an unknown plan class is skipped", () => {
    expect(decide({ session: CRON, planClass: "wat" }).action).toBe("skip")
  })
})

describe("decideAction — dry run vs apply", () => {
  it("keeps the retained action, only marking the reason (dry run)", () => {
    const applied = decide({ session: CRON, planClass: "close", apply: true })
    const dry = decide({ session: CRON, planClass: "close", apply: false })
    expect(applied.action).toBe("close")
    expect(dry.action).toBe("close")
    expect(dry.reason).toBe(`${applied.reason} (dry run)`)
  })

  it("a user-origin close is flagged in dry run too, with the origin reason", () => {
    const dry = decide({ session: CHAT, planClass: "close", apply: false })
    expect(dry.action).toBe("flag")
    expect(dry.reason).toBe(`${mod.USER_ORIGIN_REASON} (dry run)`)
  })

  it("a skipped verdict stays skipped in both modes", () => {
    const args = { session: CRON, planClass: "judge", verdict: "active", confidence: 0.9 } as const
    expect(decide({ ...args, apply: true }).action).toBe("skip")
    expect(decide({ ...args, apply: false }).action).toBe("skip")
  })

  it("apply defaults to false (dry run) when omitted", () => {
    expect(mod.decideAction({ session: CRON, planClass: "close" }).reason).toContain("(dry run)")
  })
})
