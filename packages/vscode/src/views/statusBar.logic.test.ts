import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import { STALL_AFTER_MS } from "./sessionsTree.logic.js"
import {
  buildStatusCounts,
  buildStatusText,
  dominantActivity,
  statusBarIcon,
  summarizeLive,
} from "./statusBar.logic.js"

const NOW = Date.parse("2026-07-16T12:00:00.000Z")

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "cmd",
    pid: 1,
    status: "running",
    startedAt: "2026-07-16T11:00:00.000Z",
    ...over,
  }
}

/** Alive, mid-turn, and emitting — the honest "working" shape. */
function working(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return session({
    busy: true,
    lastActivityAt: new Date(NOW - 1_000).toISOString(),
    ...over,
  })
}

describe("summarizeLive", () => {
  it("counts what sessions are DOING, not whether their process is up", () => {
    // The bug this replaces: nine alive sessions, none doing anything, and a
    // status bar reading "9 running" — which every reader takes as "9 agents
    // are working". They were all parked.
    const summary = summarizeLive(
      [
        session(),
        session({ id: "s2" }),
        session({ id: "s3" }),
        working({ id: "s4" }),
        session({ id: "s5", awaitingInput: true }),
        working({ id: "s6", lastActivityAt: new Date(NOW - STALL_AFTER_MS - 1_000).toISOString() }),
        // Finished sessions are history — never counted in a LIVE summary.
        session({ id: "s7", status: "exited" }),
        session({ id: "s8", status: "killed" }),
      ],
      NOW,
    )
    expect(summary.live).toHaveLength(6)
    expect(summary.idle).toBe(3)
    expect(summary.working).toBe(1)
    expect(summary.needsYou).toBe(1)
    expect(summary.stalled).toBe(1)
  })

  it("sums cost across live sessions only", () => {
    const summary = summarizeLive(
      [
        session({ costUsd: 1.5 }),
        session({ id: "s2", costUsd: 0.25 }),
        session({ id: "s3", status: "exited", costUsd: 99 }),
      ],
      NOW,
    )
    expect(summary.costUsd).toBeCloseTo(1.75)
  })

  it("treats a starting session as live, and as working rather than idle", () => {
    const summary = summarizeLive([session({ status: "starting" })], NOW)
    expect(summary.live).toHaveLength(1)
    // Booting is motion. It isn't `busy` — there's no turn in flight yet,
    // because there's no agent yet to run one — so this used to land in `idle`
    // and the status bar called a session that was coming up "parked". Same
    // lie as counting nine parked agents as "9 running", one axis over.
    expect(summary.working).toBe(1)
    expect(summary.idle).toBe(0)
  })
})

describe("buildStatusText", () => {
  it("says idle when nothing is happening — the whole point", () => {
    const summary = summarizeLive([session(), session({ id: "s2" })], NOW)
    expect(buildStatusText(summary)).toBe("agentproto: 2 idle · $0.00")
  })

  it("leads with work when there is any", () => {
    const summary = summarizeLive([working(), session({ id: "s2", costUsd: 25.18 })], NOW)
    expect(buildStatusText(summary)).toBe("agentproto: 1 working · 1 idle · $25.18")
  })

  it("puts what needs a human first, ahead of everything else", () => {
    const summary = summarizeLive(
      [
        session({ awaitingInput: true }),
        working({ id: "s2" }),
        session({ id: "s3" }),
        working({ id: "s4", lastActivityAt: new Date(NOW - STALL_AFTER_MS - 1).toISOString() }),
      ],
      NOW,
    )
    // Urgency order, zeroes omitted: a glance answers "am I needed?" first.
    expect(buildStatusCounts(summary)).toBe("1 needs you · 1 stuck · 1 working · 1 idle")
  })

  it("agrees with itself on plurals", () => {
    const one = summarizeLive([session({ awaitingInput: true })], NOW)
    expect(buildStatusCounts(one)).toBe("1 needs you")
    const two = summarizeLive(
      [session({ awaitingInput: true }), session({ id: "s2", awaitingInput: true })],
      NOW,
    )
    expect(buildStatusCounts(two)).toBe("2 need you")
  })

  it("says so plainly when the daemon has nothing live, and drops the $0.00", () => {
    const summary = summarizeLive([session({ status: "exited" })], NOW)
    expect(buildStatusText(summary)).toBe("agentproto: no sessions")
  })
})

describe("statusBarIcon", () => {
  it("shows the most demanding state, so the glyph is a claim and not decoration", () => {
    // The old `$(pulse)` throbbed identically whether nine agents were
    // mid-turn or fast asleep.
    expect(statusBarIcon(summarizeLive([session()], NOW))).toBe("circle-filled")
    expect(statusBarIcon(summarizeLive([working()], NOW))).toBe("loading~spin")
    expect(
      statusBarIcon(
        summarizeLive([working({ lastActivityAt: new Date(NOW - STALL_AFTER_MS - 1).toISOString() })], NOW),
      ),
    ).toBe("warning")
    expect(statusBarIcon(summarizeLive([session({ awaitingInput: true })], NOW))).toBe("question")
  })

  it("ranks needs-you over stuck over working over idle", () => {
    const all = summarizeLive(
      [
        session(),
        working({ id: "s2" }),
        working({ id: "s3", lastActivityAt: new Date(NOW - STALL_AFTER_MS - 1).toISOString() }),
        session({ id: "s4", awaitingInput: true }),
      ],
      NOW,
    )
    expect(dominantActivity(all)).toBe("needs-you")
  })
})
