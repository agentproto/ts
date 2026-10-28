/**
 * must-wake floor — a `fyi` follow still delivers the always-wake set
 * (`awaiting-input`, `crashed`, a `turn-end` carrying a question) at
 * `next-turn`, never silenced down to the inbox.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import type { SessionMessage } from "../session-message.js"
import { createSessionFollowStore, type SessionFollowInput } from "../session-follow-store.js"
import { wireSessionFollow, type SessionFollowHandle } from "../session-follow.js"
import type { SessionDescriptor } from "../sessions.js"

type Desc = Partial<SessionDescriptor> & { id: string }

const T0 = "2026-10-05T00:00:00.000Z"

function stubRegistry(initial: Desc[]) {
  const sessions = new Map<string, Desc>(initial.map(d => [d.id, d]))
  const sent: SessionMessage[] = []
  const sendMessage = vi.fn(async (msg: SessionMessage) => {
    sent.push(msg)
    return {}
  })
  return {
    sessions,
    sent,
    registry: {
      get: (id: string) => sessions.get(id) as SessionDescriptor | undefined,
      sendMessage: sendMessage as unknown as (
        msg: SessionMessage,
        opts?: { source?: string; origin?: string },
      ) => Promise<unknown>,
    },
  }
}

const running = (id: string, extra: Partial<SessionDescriptor> = {}): Desc => ({
  id,
  status: "running",
  cwd: "/work/proj",
  ...extra,
})

describe("must-wake floor on a fyi follow", () => {
  let bus: SessionEventBus
  let handle: SessionFollowHandle | undefined
  let tmp: string

  beforeEach(() => {
    bus = createSessionEventBus()
    tmp = mkdtempSync(join(tmpdir(), "must-wake-floor-"))
  })
  afterEach(() => {
    handle?.dispose()
    handle = undefined
    rmSync(tmp, { recursive: true, force: true })
  })

  function setup(
    descs: Desc[],
    follow: Partial<SessionFollowInput> & Pick<SessionFollowInput, "selector">,
    extra: Partial<Parameters<typeof wireSessionFollow>[0]> = {},
  ) {
    const reg = stubRegistry(descs)
    const store = createSessionFollowStore({ persist: false })
    store.upsert({ batchMs: 0, follower: "chief", ...follow })
    handle = wireSessionFollow({
      registry: reg.registry,
      sessionEvents: bus,
      store,
      readLastOutput: () => undefined,
      parkedPath: join(tmp, "parked.jsonl"),
      triagePath: join(tmp, "triage.jsonl"),
      log: () => {},
      ...extra,
    })
    return { ...reg, store }
  }

  const turnEnd = (sessionId: string, extra: Record<string, unknown> = {}): void => {
    bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: T0, ...extra } as never)
  }

  const exited = (sessionId: string, extra: Record<string, unknown> = {}): void => {
    bus.emit({ type: "session:exited", sessionId, status: "exited", ts: T0, ...extra } as never)
  }

  const crashed = (sessionId: string): void => {
    exited(sessionId, { status: "error" })
  }

  const awaitingInput = (sessionId: string): void => {
    bus.emit({
      type: "session:awaiting-input",
      sessionId,
      ts: T0,
      question: { text: "which one?", source: "structured" },
    } as never)
  }

  const prMerged = (sessionId: string, id: string): void => {
    bus.emit({
      type: "activity:changed",
      activity: {
        kind: "pr",
        id,
        sessionId,
        state: "done",
        title: `PR ${id}`,
        sourceRef: `pr:${id}`,
        source: "session",
        startedAt: T0,
      },
      ts: T0,
    } as never)
  }

  describe("triage off (default)", () => {
    it("wakes a fyi follow on a crashed session", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        urgency: "fyi",
      })
      crashed("w")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
    })

    it("wakes a fyi follow on awaiting-input", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        urgency: "fyi",
      })
      awaitingInput("w")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
    })

    it("wakes a fyi follow on a turn-end carrying a question", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        urgency: "fyi",
      })
      turnEnd("w", { awaitingInput: true })
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
    })

    it("keeps a fyi follow at fyi when nothing must-wake is in the digest", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        urgency: "fyi",
      })
      exited("w", { reason: "operator-stopped" })
      prMerged("w", "pr-1")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("fyi")
    })

    it("wakes a fyi follow on a mixed digest and keeps every line", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        urgency: "fyi",
      })
      crashed("w")
      prMerged("w", "pr-1")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
      expect(sent[0]!.text).toContain("crashed")
      expect(sent[0]!.text).toContain("pr-1")
    })
  })

  describe("triage on", () => {
    it("wakes a fyi follow on a crashed session even once triage picks it as the wake entry", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        urgency: "fyi",
        triage: { enabled: true },
      })
      crashed("w")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
    })
  })

  describe("fail-open (triage throws)", () => {
    it("still wakes a fyi follow on awaiting-input when triage fails", async () => {
      // `awaiting-input` itself hits the always-wake rule before any fact is
      // consulted, so it cannot force the throw on its own. A plain
      // `turn-end` on a second followed session reaches the
      // `reportedTurnEnd` rule (on by default), which does call
      // `reportedRecently` and throws — aborting classification for the
      // whole batch and exercising the fail-open path alongside the
      // must-wake entry.
      const logs: string[] = []
      const { sent } = setup(
        [running("chief"), running("w"), running("w2")],
        { selector: { sessionIds: ["w", "w2"] }, urgency: "fyi", triage: { enabled: true } },
        {
          triageFacts: {
            reportedRecently: () => {
              throw new Error("boom")
            },
          },
          log: line => logs.push(line),
        },
      )
      turnEnd("w2")
      awaitingInput("w")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
      expect(logs.some(line => line.startsWith("[session-follow] triage failed for chief:"))).toBe(true)
    })
  })

  it("leaves a next-turn follow unchanged", async () => {
    const { sent } = setup([running("chief"), running("w")], {
      selector: { sessionIds: ["w"] },
    })
    crashed("w")
    await handle!.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.urgency).toBe("next-turn")
  })
})
