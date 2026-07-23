import { describe, it, expect } from "vitest"
import {
  summarizeLines,
  deriveSessionState,
  regenerateActivitySummary,
  ACTIVITY_MIN_INTERVAL_MS,
  type SessionActivitySummary,
} from "../session-activity.js"

// A minimal descriptor slice — regenerateActivitySummary takes a Pick, so a
// plain literal with just the fields it reads is enough.
type Desc = Parameters<typeof regenerateActivitySummary>[0]
function desc(over: Partial<Desc> = {}): Desc {
  return {
    status: "running",
    command: "claude",
    ...over,
  } as Desc
}

const T0 = Date.parse("2026-07-23T10:00:00.000Z")

describe("summarizeLines", () => {
  it("returns the last meaningful line, ANSI-stripped", () => {
    const lines = ["\x1b[36m[tool] read src/app.ts\x1b[0m", "\x1b[0mWrote the fix and re-ran the tests.\x1b[0m"]
    expect(summarizeLines(lines, { command: "claude" })).toBe("Wrote the fix and re-ran the tests.")
  })

  it("skips agentproto turn framing so it never lands on the turn-end rule", () => {
    // In a real turn the ring buffer ends on the dim `── turn-end ──` rule,
    // appended AFTER the assistant's last text — the summary must walk past it
    // (and past the prompt echo / [thought] trace) to the real content.
    const lines = [
      "\x1b[2m── ▶ fix the login bug ──\x1b[0m",
      "\x1b[2m[thought] I'll check the auth guard first\x1b[0m",
      "Patched the token refresh path.",
      "\x1b[2m── turn-end (completed) ──\x1b[0m",
    ]
    expect(summarizeLines(lines, { command: "claude" })).toBe("Patched the token refresh path.")
  })

  it("falls back to label/name/command when there is no usable output", () => {
    expect(summarizeLines([], { command: "claude", label: "my label" })).toBe("my label")
    expect(summarizeLines(["\x1b[2m── turn-end (completed) ──\x1b[0m"], { command: "claude" })).toBe(
      "claude",
    )
  })

  it("truncates a very long line", () => {
    const long = "x".repeat(300)
    const out = summarizeLines([long], { command: "claude" })
    expect(out.length).toBe(158) // 157 + ellipsis
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("deriveSessionState", () => {
  it("maps lifecycle + recency to the coarse state", () => {
    expect(deriveSessionState({ status: "exited" }, T0)).toBe("terminé")
    expect(deriveSessionState({ status: "running", awaitingInput: true }, T0)).toBe("à traiter")
    expect(
      deriveSessionState({ status: "running", lastOutputAt: new Date(T0 - 1_000).toISOString() }, T0),
    ).toBe("au travail")
    expect(
      deriveSessionState({ status: "running", lastOutputAt: new Date(T0 - 60_000).toISOString() }, T0),
    ).toBe("en attente")
  })
})

describe("regenerateActivitySummary — trigger", () => {
  it("generates on the first turn-end (no prior summary)", () => {
    const out = regenerateActivitySummary(
      desc({ lastOutputAt: new Date(T0).toISOString() }),
      ["Ran the migration and it passed."],
      T0,
    )
    expect(out).not.toBeNull()
    expect(out).toEqual<SessionActivitySummary>({
      text: "Ran the migration and it passed.",
      state: "au travail",
      at: new Date(T0).toISOString(),
    })
  })

  it("regenerates once the throttle window has elapsed", () => {
    const prev: SessionActivitySummary = {
      text: "old line",
      state: "au travail",
      at: new Date(T0).toISOString(),
    }
    const later = T0 + ACTIVITY_MIN_INTERVAL_MS + 1
    const out = regenerateActivitySummary(
      desc({ activitySummary: prev, lastOutputAt: new Date(later).toISOString() }),
      ["A newer line of output."],
      later,
    )
    expect(out?.text).toBe("A newer line of output.")
    expect(out?.at).toBe(new Date(later).toISOString())
  })

  it("is throttled inside the window — returns null, leaving the prior line", () => {
    const prev: SessionActivitySummary = {
      text: "kept line",
      state: "au travail",
      at: new Date(T0).toISOString(),
    }
    const out = regenerateActivitySummary(
      desc({ activitySummary: prev }),
      ["A newer line the throttle should suppress."],
      T0 + 5_000, // < ACTIVITY_MIN_INTERVAL_MS
    )
    expect(out).toBeNull()
  })
})

describe("regenerateActivitySummary — renamedByUser / title-preservation guard", () => {
  it("never regenerates for a human-renamed session, even with fresh output", () => {
    const out = regenerateActivitySummary(
      desc({ renamedByUser: true, lastOutputAt: new Date(T0).toISOString() }),
      ["The agent is doing brand-new work right now."],
      T0,
    )
    expect(out).toBeNull()
  })

  it("leaves an existing activity line frozen once the session is renamed", () => {
    const prev: SessionActivitySummary = {
      text: "frozen at rename time",
      state: "au travail",
      at: new Date(T0).toISOString(),
    }
    const out = regenerateActivitySummary(
      desc({ renamedByUser: true, activitySummary: prev }),
      ["Newer output that must NOT overwrite the frozen line."],
      T0 + ACTIVITY_MIN_INTERVAL_MS * 10, // well past the throttle window
    )
    // Guard beats throttle: no new summary, the caller keeps `prev` untouched.
    expect(out).toBeNull()
  })

  it("regenerates for a spawn-labelled (not human-renamed) session", () => {
    // A spawn `label` with renamedByUser:false must NOT freeze activity — only a
    // deliberate human rename does.
    const out = regenerateActivitySummary(
      desc({ renamedByUser: false, label: "spawn-slug", lastOutputAt: new Date(T0).toISOString() }),
      ["Working on the parser."],
      T0,
    )
    expect(out?.text).toBe("Working on the parser.")
  })
})
