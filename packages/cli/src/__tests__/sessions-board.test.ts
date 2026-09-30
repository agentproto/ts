/**
 * `agentproto sessions board`: the pure classifier matrix (one Badge per
 * session, frozen rules incl. keepAlive / interrupted / awaiting /
 * blocked / cost-on-off / command-kind), the sort order, the summary
 * header, the renderer, and the CLI verb wired to a fake daemon (same
 * `_daemon-helpers` mock as sessions-stats.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"
import {
  DEFAULT_STALE_AFTER_MS,
  badgeRank,
  boardSummaryLine,
  classifyOne,
  classifySessions,
  renderBoard,
  runBoard,
} from "../commands/sessions-board.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)

const NOW = Date.parse("2026-09-30T12:00:00.000Z")
const minutesAgo = (m: number): string =>
  new Date(NOW - m * 60_000).toISOString()

/** A minimal agent-cli row; every field the classifier reads is overridable. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sess_a",
    kind: "agent-cli",
    status: "running",
    busy: false,
    lastActivityAt: minutesAgo(1),
    startedAt: minutesAgo(30),
    ...overrides,
  }
}

const { printNoDaemonError } = helpers

describe("sessions board — classifyOne (frozen rules matrix)", () => {
  it("ACTIVE: running + busy", () => {
    const c = classifyOne(row({ busy: true }) as never, { nowMs: NOW })
    expect(c.badge).toBe("ACTIVE")
  })

  it("ACTIVE: starting + busy (spawn in flight)", () => {
    const c = classifyOne(
      row({ status: "starting", busy: true }) as never,
      { nowMs: NOW },
    )
    expect(c.badge).toBe("ACTIVE")
  })

  it("IDLE: running, not busy, young (< reap threshold)", () => {
    const c = classifyOne(row({ lastActivityAt: minutesAgo(5) }) as never, {
      nowMs: NOW,
    })
    expect(c.badge).toBe("IDLE")
  })

  it("IDLE: keepAlive overrides reap-risk age — NEVER STALE", () => {
    const c = classifyOne(
      row({ lastActivityAt: minutesAgo(90), keepAlive: true }) as never,
      { nowMs: NOW },
    )
    expect(c.badge).toBe("IDLE")
  })

  it("STALE: running, not busy, past the reap-risk threshold, no keepAlive", () => {
    const c = classifyOne(row({ lastActivityAt: minutesAgo(90) }) as never, {
      nowMs: NOW,
    })
    expect(c.badge).toBe("STALE")
    expect(c.idleMs).toBe(90 * 60_000)
  })

  it("STALE: interrupted flag forces reap-risk at ANY age", () => {
    const c = classifyOne(
      row({ interrupted: true, lastActivityAt: minutesAgo(1) }) as never,
      { nowMs: NOW },
    )
    expect(c.badge).toBe("STALE")
  })

  it("STALE: interrupted does not beat keepAlive (keepAlive still wins)", () => {
    const c = classifyOne(
      row({ interrupted: true, keepAlive: true }) as never,
      { nowMs: NOW },
    )
    expect(c.badge).toBe("IDLE")
  })

  it("AWAITING: awaitingInput", () => {
    const c = classifyOne(row({ awaitingInput: true }) as never, { nowMs: NOW })
    expect(c.badge).toBe("AWAITING")
  })

  it("AWAITING: awaitingPermission (parked permission decision)", () => {
    const c = classifyOne(row({ awaitingPermission: true }) as never, {
      nowMs: NOW,
    })
    expect(c.badge).toBe("AWAITING")
  })

  it("AWAITING beats ACTIVE: busy + awaitingInput reads AWAITING", () => {
    const c = classifyOne(
      row({ busy: true, awaitingInput: true }) as never,
      { nowMs: NOW },
    )
    expect(c.badge).toBe("AWAITING")
  })

  it("BLOCKED: blockedOn set (waiting on a subagent/command/inbox)", () => {
    const c = classifyOne(row({ blockedOn: "subagent" }) as never, {
      nowMs: NOW,
    })
    expect(c.badge).toBe("BLOCKED")
  })

  it("BLOCKED beats AWAITING: a wedged row is classified BLOCKED", () => {
    const c = classifyOne(
      row({ blockedOn: "inbox", awaitingInput: true }) as never,
      { nowMs: NOW },
    )
    expect(c.badge).toBe("BLOCKED")
  })

  it("ENDED: each terminal status, with endedReason kept as evidence", () => {
    for (const status of ["exited", "killed", "error"]) {
      const c = classifyOne(
        row({ status, endedReason: "idle-reaped" }) as never,
        { nowMs: NOW },
      )
      expect(c.badge).toBe("ENDED")
      expect(c.endedReason).toBe("idle-reaped")
    }
  })

  it("ENDED keeps no endedReason when the row never carried one", () => {
    const c = classifyOne(row({ status: "exited" }) as never, { nowMs: NOW })
    expect(c.endedReason).toBeUndefined()
  })

  it("COMMAND: kind 'command' wins over everything, even a terminal status", () => {
    const c = classifyOne(
      row({ kind: "command", status: "exited", endedReason: "completed" }) as never,
      { nowMs: NOW },
    )
    expect(c.badge).toBe("COMMAND")
  })

  it("un-ageable row (no timestamps) never goes STALE by age", () => {
    const c = classifyOne(
      row({ lastActivityAt: undefined, startedAt: undefined }) as never,
      { nowMs: NOW },
    )
    expect(c.badge).toBe("IDLE")
    expect(c.idleMs).toBeNull()
    expect(c.age).toBe("?")
  })

  it("staleAfterMs is caller-tunable (daemon knob could thread through)", () => {
    const stale = classifyOne(row({ lastActivityAt: minutesAgo(10) }) as never, {
      nowMs: NOW,
      staleAfterMs: 5 * 60_000,
    })
    const fresh = classifyOne(row({ lastActivityAt: minutesAgo(10) }) as never, {
      nowMs: NOW,
      staleAfterMs: 60 * 60_000,
    })
    expect(stale.badge).toBe("STALE")
    expect(fresh.badge).toBe("IDLE")
  })

  it("DEFAULT_STALE_AFTER_MS is the documented 15-minute reap-risk default", () => {
    expect(DEFAULT_STALE_AFTER_MS).toBe(15 * 60 * 1000)
  })
})

describe("sessions board — evidence + cost on/off", () => {
  it("costUsd present on the row → carried into the classification", () => {
    const c = classifyOne(row({ costUsd: 1.234 }) as never, { nowMs: NOW })
    expect(c.costUsd).toBe(1.234)
  })

  it("costUsd absent → omitted entirely (no usage source ≠ $0)", () => {
    const c = classifyOne(row() as never, { nowMs: NOW })
    expect("costUsd" in c).toBe(false)
    expect(c.costUsd).toBeUndefined()
  })

  it("evidence mirrors the inputs: model, depth, parent, handoff edge, flags", () => {
    const c = classifyOne(
      row({
        model: "glm-5.2",
        depth: 1,
        parentSessionId: "sess_parent",
        continuedFrom: "sess_old",
        keepAlive: true,
      }) as never,
      { nowMs: NOW },
    )
    expect(c.model).toBe("glm-5.2")
    expect(c.depth).toBe(1)
    expect(c.parentSessionId).toBe("sess_parent")
    expect(c.continuedFrom).toBe("sess_old")
    expect(c.keepAlive).toBe(true)
  })

  it("label prefers the human-given name, else the id", () => {
    const named = classifyOne(row({ name: "executor-a" }) as never, {
      nowMs: NOW,
    })
    const unnamed = classifyOne(row() as never, { nowMs: NOW })
    expect(named.label).toBe("executor-a")
    expect(unnamed.label).toBe("sess_a")
  })
})

describe("sessions board — classifySessions sort (attention order)", () => {
  it("sorts AWAITING > BLOCKED > STALE > ACTIVE > IDLE > COMMAND > ENDED", () => {
    const classified = classifySessions(
      [
        row({ id: "ended", status: "exited" }),
        row({ id: "idle", lastActivityAt: minutesAgo(1) }),
        row({ id: "active", busy: true }),
        row({ id: "stale", lastActivityAt: minutesAgo(90) }),
        row({ id: "awaiting", awaitingInput: true }),
        row({ id: "command", kind: "command", status: "exited" }),
        row({ id: "blocked", blockedOn: "command" }),
      ] as never,
      { nowMs: NOW },
    )
    expect(classified.map(c => `${c.badge}:${c.id}`)).toEqual([
      "AWAITING:awaiting",
      "BLOCKED:blocked",
      "STALE:stale",
      "ACTIVE:active",
      "IDLE:idle",
      "COMMAND:command",
      "ENDED:ended",
    ])
  })

  it("within a badge, most-idle first for live rows, most-recent first for ENDED", () => {
    const classified = classifySessions(
      [
        row({ id: "young", lastActivityAt: minutesAgo(2) }),
        row({ id: "old", lastActivityAt: minutesAgo(40) }),
        row({ id: "ended-new", status: "exited", lastActivityAt: minutesAgo(2) }),
        row({ id: "ended-old", status: "killed", lastActivityAt: minutesAgo(40) }),
      ] as never,
      { nowMs: NOW },
    )
    expect(classified.map(c => c.id)).toEqual([
      "old",
      "young",
      "ended-new",
      "ended-old",
    ])
  })

  it("badgeRank implements the frozen attention order", () => {
    expect(badgeRank("AWAITING")).toBeLessThan(badgeRank("BLOCKED"))
    expect(badgeRank("BLOCKED")).toBeLessThan(badgeRank("STALE"))
    expect(badgeRank("STALE")).toBeLessThan(badgeRank("ACTIVE"))
    expect(badgeRank("ACTIVE")).toBeLessThan(badgeRank("IDLE"))
    expect(badgeRank("IDLE")).toBeLessThan(badgeRank("COMMAND"))
    expect(badgeRank("COMMAND")).toBeLessThan(badgeRank("ENDED"))
  })
})

describe("sessions board — summary header", () => {
  it("renders the one-line summary with non-zero buckets in rank order", () => {
    const classified = classifySessions(
      [
        row({ id: "a1", busy: true }),
        row({ id: "a2", busy: true }),
        row({ id: "w", awaitingInput: true }),
        row({ id: "s", lastActivityAt: minutesAgo(90) }),
        row({ id: "e1", status: "exited" }),
        row({ id: "e2", status: "exited" }),
        row({ id: "e3", status: "error" }),
        row({ id: "e4", status: "killed" }),
      ] as never,
      { nowMs: NOW },
    )
    expect(boardSummaryLine(classified)).toBe(
      "8 sessions — 1 awaiting · 1 stale · 2 active · 4 ended",
    )
  })

  it("singular noun for a lone session, empty board header", () => {
    expect(boardSummaryLine(classifySessions([row()] as never, { nowMs: NOW }))).toBe(
      "1 session — 1 idle",
    )
    expect(boardSummaryLine([])).toBe("0 sessions")
  })
})

describe("sessions board — renderBoard", () => {
  it("colourless render: header line, column headers, classified rows", () => {
    const out = renderBoard(
      classifySessions(
        [
          row({ id: "a", name: "executor", busy: true, model: "glm-5.2", costUsd: 0.42, depth: 0 }),
          row({ id: "b", status: "exited", endedReason: "completed" }),
        ] as never,
        { nowMs: NOW },
      ),
    )
    expect(out).toContain("2 sessions — 1 active · 1 ended")
    expect(out).toContain("BADGE")
    expect(out).toContain("ACTIVE")
    expect(out).toContain("glm-5.2")
    expect(out).toContain("$0.42")
    expect(out).toContain("completed")
  })

  it("cost cell renders — when usage exists, — when not", () => {
    const out = renderBoard(
      classifySessions(
        [row({ id: "a", costUsd: 1.5 }), row({ id: "b" })] as never,
        { nowMs: NOW },
      ),
    )
    expect(out).toContain("$1.50")
    expect(out).toContain("—")
  })

  it("empty board renders just the zero header", () => {
    expect(renderBoard([])).toBe("0 sessions\n")
  })
})

describe("agentproto sessions board — CLI wiring (fake daemon)", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Pin the clock so the fixtures' ages (minutesAgo) classify exactly.
    vi.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("routes through `sessions board`, fetches the default view, prints the board", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:1", token: "t" },
    } as never)
    httpGetJson.mockResolvedValue({
      sessions: [
        row({ id: "live", busy: true }),
        row({ id: "cmd", kind: "command", status: "exited" }),
      ],
    } as never)
    const writes: string[] = []
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk))
        return true
      }) as typeof process.stdout.write)
    try {
      const code = await runSessions(["board"])
      expect(code).toBe(0)
    } finally {
      spy.mockRestore()
    }
    // Default view: the command log row is NOT fetched (no includeCommands).
    expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:1/sessions")
    const out = writes.join("")
    expect(out).toContain("2 sessions — 1 active · 1 command")
    expect(out).toContain("ACTIVE")
  })

  it("--all fetches the includeCommands union and classifies COMMAND rows", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:1", token: "t" },
    } as never)
    httpGetJson.mockResolvedValue({
      sessions: [
        row({ id: "live", busy: true }),
        row({ id: "cmd", kind: "command", status: "exited" }),
      ],
    } as never)
    const writes: string[] = []
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk))
        return true
      }) as typeof process.stdout.write)
    try {
      const code = await runSessions(["board", "--all"])
      expect(code).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(httpGetJson).toHaveBeenCalledWith(
      "http://127.0.0.1:1/sessions?includeCommands=true",
    )
    expect(writes.join("")).toContain("COMMAND")
  })

  it("--json emits the classified rows (classes + evidence) as JSON", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:1", token: "t" },
    } as never)
    httpGetJson.mockResolvedValue({
      sessions: [row({ id: "stale1", lastActivityAt: minutesAgo(90), costUsd: 0.1 })],
    } as never)
    const writes: string[] = []
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk))
        return true
      }) as typeof process.stdout.write)
    try {
      const code = await runBoard(["--json"])
      expect(code).toBe(0)
    } finally {
      spy.mockRestore()
    }
    const parsed = JSON.parse(writes.join("")) as Array<Record<string, unknown>>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.badge).toBe("STALE")
    expect(parsed[0]!.costUsd).toBe(0.1)
    expect(parsed[0]!.idleMs).toBe(90 * 60_000)
  })

  it("--json + --watch is rejected with exit 2", async () => {
    const code = await runBoard(["--json", "--watch"])
    expect(code).toBe(2)
  })

  it("no daemon → exit 2 via the shared no-daemon error", async () => {
    discoverDaemon.mockResolvedValue({ found: false } as never)
    const code = await runBoard([])
    expect(code).toBe(2)
    expect(printNoDaemonError).toHaveBeenCalled()
  })
})
