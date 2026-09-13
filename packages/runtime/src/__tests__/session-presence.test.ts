/**
 * Unit tests for the shared dashboard presence classifier (`session-presence.ts`)
 * and its config resolution. Covers the full four-state matrix, the grace
 * window (including the boundary and the "a new event resets grace" contract),
 * and that both the default (60) and an overridden `sessions.attentionDelaySec`
 * flow through `resolveAttentionDelaySec`.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  ATTENTION_DELAY_ENV,
  DEFAULT_ATTENTION_DELAY_SEC,
  inAttentionGrace,
  presenceFor,
  resolveAttentionDelaySec,
} from "../session-presence.js"
import type { SessionPresenceInput } from "../session-presence.js"

/** A bare live session descriptor helper — everything off unless set. */
function session(over: Partial<SessionPresenceInput> = {}): SessionPresenceInput {
  return { status: "running", ...over }
}

const NOW = 1_000_000_000_000

/** A `lastActivityAt` that sits `sec` seconds before `NOW`. */
const at = (sec: number): string => new Date(NOW - sec * 1000).toISOString()

describe("presenceFor — grace window", () => {
  it("returns running while a turn is in flight, regardless of recency", () => {
    expect(presenceFor(session({ busy: true }), { now: NOW })).toBe("running")
    // Busy wins even when it went silent long ago and grace has long expired.
    expect(presenceFor(session({ busy: true, lastActivityAt: at(600) }), { now: NOW })).toBe("running")
  })

  it("returns running for a just-finished turn still inside the grace window", () => {
    expect(
      presenceFor(session({ busy: false, lastActivityAt: at(10) }), {
        now: NOW,
        attentionDelaySec: 60,
      }),
    ).toBe("running")
  })

  it("returns quiet once the grace window has elapsed with nothing pending", () => {
    expect(
      presenceFor(session({ busy: false, lastActivityAt: at(61) }), {
        now: NOW,
        attentionDelaySec: 60,
      }),
    ).toBe("quiet")
  })

  it("treats the grace boundary as still running (exactly at the delay)", () => {
    // 60s delay: at exactly 60s ago → now-at === 60000, which is NOT < 60000,
    // so it is past the window. Assert to pin the boundary we chose.
    expect(
      presenceFor(session({ busy: false, lastActivityAt: at(60) }), {
        now: NOW,
        attentionDelaySec: 60,
      }),
    ).toBe("quiet")
    expect(
      presenceFor(session({ busy: false, lastActivityAt: at(59) }), {
        now: NOW,
        attentionDelaySec: 60,
      }),
    ).toBe("running")
  })

  it("uses the configured (non-default) attention delay", () => {
    expect(
      presenceFor(session({ busy: false, lastActivityAt: at(90) }), {
        now: NOW,
        attentionDelaySec: 120,
      }),
    ).toBe("running")
    expect(
      presenceFor(session({ busy: false, lastActivityAt: at(121) }), {
        now: NOW,
        attentionDelaySec: 120,
      }),
    ).toBe("quiet")
  })

  it("a new event resets the grace timer — measured from the most recent lastActivityAt", () => {
    // Same minute of calendar time, but one descriptor has a FRESHER event:
    // a turn that just produced output is still running, an identical-looking
    // session whose last event was a further 50s back is already quiet. The
    // only difference is "how long ago" — which is exactly the anchor moving.
    const address = (busy: boolean, agoSec: number): SessionPresenceInput =>
      session({ busy, lastActivityAt: at(agoSec) })
    // Old anchor: 100s ago → past the 60s window → quiet.
    expect(presenceFor(address(false, 100), { now: NOW, attentionDelaySec: 60 })).toBe("quiet")
    // New anchor: 5s ago (an event just landed) → still running.
    expect(presenceFor(address(false, 5), { now: NOW, attentionDelaySec: 60 })).toBe("running")
  })

  it("falls back to lastOutputAt when lastActivityAt is absent", () => {
    expect(
      presenceFor(session({ busy: false, lastOutputAt: at(5) }), {
        now: NOW,
        attentionDelaySec: 60,
      }),
    ).toBe("running")
  })

  it("a session with no recency signal at all is not running-from-grace", () => {
    expect(presenceFor(session({ busy: false }), { now: NOW })).toBe("quiet")
  })

  it("a zero attention delay disables the grace window entirely", () => {
    expect(
      presenceFor(session({ busy: false, lastActivityAt: at(1) }), {
        now: NOW,
        attentionDelaySec: 0,
      }),
    ).toBe("quiet")
  })
})

describe("presenceFor — tending (peers with running, not below it)", () => {
  it("returns tending for a non-busy session with active children, outside grace", () => {
    expect(
      presenceFor(session({ busy: false, childrenBusy: 2 }), { now: NOW }),
    ).toBe("tending")
  })

  it("a held permission is attention, never tending", () => {
    expect(
      presenceFor(session({ busy: false, awaitingPermission: true }), { now: NOW }),
    ).toBe("attention")
  })

  it("returns tending for a session parked with background tasks pending", () => {
    expect(
      presenceFor(session({ busy: false, pendingBgTasks: 1 }), { now: NOW }),
    ).toBe("tending")
  })

  it("childrenBusy does not outrank an in-flight turn or a just-finished one", () => {
    expect(presenceFor(session({ busy: true, childrenBusy: 3 }), { now: NOW })).toBe("running")
    expect(
      presenceFor(session({ busy: false, childrenBusy: 3, lastActivityAt: at(10) }), {
        now: NOW,
        attentionDelaySec: 60,
      }),
    ).toBe("running")
  })
})

describe("presenceFor — attention (needs the human)", () => {
  it("returns attention for awaitingInput, outside grace", () => {
    expect(presenceFor(session({ busy: false, awaitingInput: true }), { now: NOW })).toBe("attention")
  })

  it("returns attention for awaitingPermission, even mid-busy", () => {
    expect(presenceFor(session({ busy: true, awaitingPermission: true }), { now: NOW })).toBe("attention")
  })

  it("returns attention for the adapter's own last-turn in-band failure", () => {
    expect(
      presenceFor(session({ busy: false, lastTurnErroredAt: at(10) }), { now: NOW }),
    ).toBe("attention")
  })
})

describe("presenceFor — terminal sessions fold onto the axis", () => {
  it("a clean exit / stopped session reads quiet", () => {
    expect(presenceFor(session({ status: "exited" }), { now: NOW })).toBe("quiet")
    expect(presenceFor(session({ status: "killed", exitCode: 143 }), { now: NOW })).toBe("quiet")
  })

  it("an error / failed exit reads attention", () => {
    expect(presenceFor(session({ status: "error" }), { now: NOW })).toBe("attention")
    expect(presenceFor(session({ status: "exited", exitCode: 1 }), { now: NOW })).toBe("attention")
  })

  it("a killed session's non-zero SIGTERM exit code does not read as a failure", () => {
    expect(presenceFor(session({ status: "killed", exitCode: 143 }), { now: NOW })).toBe("quiet")
  })
})

describe("inAttentionGrace", () => {
  it("is true only while the last event is younger than the delay", () => {
    expect(inAttentionGrace({ lastActivityAt: at(30) }, { now: NOW, attentionDelaySec: 60 })).toBe(true)
    expect(inAttentionGrace({ lastActivityAt: at(61) }, { now: NOW, attentionDelaySec: 60 })).toBe(false)
  })

  it("is false when there is no recency signal", () => {
    expect(inAttentionGrace({}, { now: NOW })).toBe(false)
  })
})

describe("resolveAttentionDelaySec", () => {
  const originalEnv = process.env[ATTENTION_DELAY_ENV]

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ATTENTION_DELAY_ENV]
    else process.env[ATTENTION_DELAY_ENV] = originalEnv
  })

  it("defaults to 60 when nothing is configured", async () => {
    delete process.env[ATTENTION_DELAY_ENV]
    const cfg = vi.fn(async () => ({}))
    expect(await resolveAttentionDelaySec(cfg as never)).toBe(DEFAULT_ATTENTION_DELAY_SEC)
  })

  it("honours an overridden sessions.attentionDelaySec config value", async () => {
    delete process.env[ATTENTION_DELAY_ENV]
    const cfg = vi.fn(async () => ({ sessions: { attentionDelaySec: 120 } }))
    expect(await resolveAttentionDelaySec(cfg as never)).toBe(120)
  })

  it("env overrides the config field", async () => {
    process.env[ATTENTION_DELAY_ENV] = "30"
    const cfg = vi.fn(async () => ({ sessions: { attentionDelaySec: 120 } }))
    expect(await resolveAttentionDelaySec(cfg as never)).toBe(30)
  })

  it("a malformed config falls through to the default", async () => {
    delete process.env[ATTENTION_DELAY_ENV]
    const cfg = vi.fn(async () => {
      throw new Error("unreadable config")
    })
    expect(await resolveAttentionDelaySec(cfg as never)).toBe(DEFAULT_ATTENTION_DELAY_SEC)
  })
})