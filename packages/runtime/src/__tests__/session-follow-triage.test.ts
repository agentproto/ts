/**
 * follow-triage — the deterministic pre-wake triage of session-follow events.
 *
 * Covered here:
 *  - each rule in isolation (task-changed by the follower, operator exit,
 *    cron exit, reported turn-end, empty turn-end superseded by a new turn,
 *    PR opened by one of the follower's own live sessions),
 *  - the always-wake invariants (awaiting-input, crashed, a turn-end with a
 *    question),
 *  - the silent digest (every event fyi/drop ⇒ the inbox, never a wake),
 *  - the mixed digest (only the `wake` events + a count of the info ones),
 *  - the classifier hook: its verdict, and its timeout falling back to the
 *    rules,
 *  - triage being OFF by default (the legacy digest, unchanged).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import type { SessionMessage } from "../session-message.js"
import { createSessionFollowStore, type SessionFollowInput } from "../session-follow-store.js"
import { wireSessionFollow, type SessionFollowHandle } from "../session-follow.js"
import { upsertSessionFollow } from "../session-follow-tools.js"
import type { SessionDescriptor } from "../sessions.js"
import {
  classifyFollowEvent,
  defaultFollowTriageConfig,
  resolveFollowTriageConfig,
  DEFAULT_FOLLOW_TRIAGE_RULES,
  type TriageFacts,
} from "../follow-triage.js"

type Desc = Partial<SessionDescriptor> & { id: string }

const T0 = "2026-10-05T00:00:00.000Z"
const at = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString()

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

describe("follow-triage", () => {
  let bus: SessionEventBus
  let handle: SessionFollowHandle | undefined
  let tmp: string

  beforeEach(() => {
    bus = createSessionEventBus()
    tmp = mkdtempSync(join(tmpdir(), "follow-triage-"))
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

  const taskChanged = (sessionId: string, boardId: string, taskId: string): void => {
    bus.emit({
      type: "task:changed",
      taskId,
      boardId,
      change: "status",
      status: "in_progress",
      rev: 2,
      sessionId,
      ts: T0,
    } as never)
  }

  const prActivity = (sessionId: string, id: string, state: string): void => {
    bus.emit({
      type: "activity:changed",
      activity: {
        kind: "pr",
        id,
        sessionId,
        state,
        title: `PR ${id}`,
        sourceRef: `pr:${id}`,
        source: "session",
        startedAt: T0,
      },
      ts: T0,
    } as never)
  }

  // ── The pure rule engine ────────────────────────────────────────────

  describe("rules", () => {
    const base = { follower: "chief", sessionId: "w", ts: T0, event: "turn-end" } as const

    it("drops a task change the follower made itself", () => {
      const res = classifyFollowEvent(
        { ...base, event: "task-changed", sessionId: "chief" },
        DEFAULT_FOLLOW_TRIAGE_RULES,
      )
      expect(res).toEqual({ decision: "drop", rule: "own-task-changed" })
    })

    it("fyi's an exit the operator (or the follower) asked for", () => {
      for (const reason of ["operator-stopped", "operator-completed"]) {
        const res = classifyFollowEvent(
          { ...base, event: "exited", reason },
          DEFAULT_FOLLOW_TRIAGE_RULES,
        )
        expect(res).toEqual({ decision: "fyi", rule: "operator-exit" })
      }
    })

    it("drops a cron exit whose run finished OK", () => {
      const res = classifyFollowEvent({ ...base, event: "exited", sessionId: "cron-1" }, DEFAULT_FOLLOW_TRIAGE_RULES, {
        cronOk: id => (id === "cron-1" ? true : undefined),
      })
      expect(res).toEqual({ decision: "drop", rule: "cron-ok" })
    })

    it("drops the turn-end of a session that just reported up", () => {
      const res = classifyFollowEvent({ ...base, event: "turn-end" }, DEFAULT_FOLLOW_TRIAGE_RULES, {
        reportedRecently: () => true,
      })
      expect(res).toEqual({ decision: "drop", rule: "reported-turn-end" })
    })

    it("fyi's an empty/cancelled turn-end a new turn superseded", () => {
      for (const extra of [{ empty: true }, { reason: "cancelled" }]) {
        const res = classifyFollowEvent({ ...base, event: "turn-end", ...extra }, DEFAULT_FOLLOW_TRIAGE_RULES, {
          supersededByNewTurn: () => true,
        })
        expect(res).toEqual({ decision: "fyi", rule: "empty-turn-end" })
      }
    })

    it("fyi's a PR opened by one of the follower's own live sessions", () => {
      const res = classifyFollowEvent({ ...base, event: "pr-opened", sessionId: "worker" }, DEFAULT_FOLLOW_TRIAGE_RULES, {
        isFollowerSession: () => true,
      })
      expect(res).toEqual({ decision: "fyi", rule: "own-pr" })
    })

    it("always wakes on awaiting-input, a crash, and a turn-end with a question", () => {
      const facts: TriageFacts = {
        reportedRecently: () => true,
        isFollowerSession: () => true,
        supersededByNewTurn: () => true,
        cronOk: () => true,
      }
      const cases = [
        { ...base, event: "awaiting-input" as const },
        { ...base, event: "crashed" as const },
        { ...base, event: "turn-end" as const, awaitingInput: true },
      ]
      for (const ev of cases) {
        expect(classifyFollowEvent(ev, DEFAULT_FOLLOW_TRIAGE_RULES, facts)).toEqual({
          decision: "wake",
          rule: "always-wake",
        })
      }
    })

    it("wakes by default, and a disabled rule never fires", () => {
      expect(classifyFollowEvent({ ...base }, DEFAULT_FOLLOW_TRIAGE_RULES)).toEqual({
        decision: "wake",
        rule: "default",
      })
      const off = { ...DEFAULT_FOLLOW_TRIAGE_RULES, ownTaskChanges: false }
      expect(
        classifyFollowEvent({ ...base, event: "task-changed", sessionId: "chief" }, off),
      ).toEqual({ decision: "wake", rule: "default" })
    })
  })

  // ── The engine ──────────────────────────────────────────────────────

  describe("digests", () => {
    it("is OFF by default — the digest keeps every event and wakes", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
      })
      exited("w", { reason: "operator-stopped" })
      turnEnd("w")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
      expect(sent[0]!.text).toContain("(w)")
      // Two events, no triage: nothing was filtered.
      expect(sent[0]!.text).toContain("2 events")
    })

    it("routes a fully informational digest to the inbox instead of waking", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        triage: { enabled: true },
      })
      exited("w", { reason: "operator-stopped" })
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("fyi")
      expect(sent[0]!.text).toContain("for your information only")
    })

    it("keeps only the waking events and counts the informational ones", async () => {
      const { sent } = setup([running("chief"), running("a"), running("b")], {
        selector: { sessionIds: ["a", "b"] },
        triage: { enabled: true },
      })
      exited("b", { reason: "operator-stopped" }) // fyi
      turnEnd("a") // wake
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
      expect(sent[0]!.text).toContain("(a)")
      expect(sent[0]!.text).not.toContain("(b)")
      expect(sent[0]!.text).toContain("1 other event(s) in info")
    })

    it("delivers nothing when every event is dropped", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        triage: { enabled: true },
      })
      turnEnd("w")
      bus.emit({
        type: "session:message",
        sessionId: "chief",
        messageId: "msg_1",
        fromSessionId: "w",
        relation: "child",
        kind: "report",
        urgency: "next-turn",
        ts: at(-5_000),
      } as never)
      turnEnd("w")
      await handle!.flush()
      expect(sent).toHaveLength(0)
    })

    it("drops the turn-end of a session that reported up to the follower", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        triage: { enabled: true },
      })
      bus.emit({
        type: "session:message",
        sessionId: "chief",
        messageId: "msg_1",
        fromSessionId: "w",
        relation: "child",
        kind: "report",
        urgency: "next-turn",
        ts: at(-5_000),
      } as never)
      turnEnd("w", { ts: at(0) })
      await handle!.flush()
      expect(sent).toHaveLength(0)
    })

    it("fyi's the PR one of the follower's own live sessions opened", async () => {
      const { sent } = setup(
        [running("chief"), running("worker", { parentSessionId: "chief" })],
        {
          selector: { sessionIds: ["worker"] },
          excludeFollowerChildren: false,
          triage: { enabled: true },
        },
      )
      prActivity("worker", "pr-1", "pending")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("fyi")
    })

    it("still wakes on a session awaiting input", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        triage: { enabled: true },
      })
      bus.emit({
        type: "session:awaiting-input",
        sessionId: "w",
        ts: T0,
        question: { text: "which one?", source: "structured" },
      } as never)
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
    })

    it("drops the follower's own task change", async () => {
      const { sent } = setup([running("chief")], {
        selector: { boardId: "board-1" },
        triage: { enabled: true },
      })
      taskChanged("chief", "board-1", "t1")
      await handle!.flush()
      expect(sent).toHaveLength(0)
    })

    it("fails open and delivers the whole digest when triage throws", async () => {
      const logs: string[] = []
      const { sent } = setup(
        [running("chief"), running("w"), running("x")],
        { selector: { sessionIds: ["w", "x"] }, triage: { enabled: true } },
        {
          triageFacts: {
            reportedRecently: () => {
              throw new Error("boom")
            },
          },
          log: line => logs.push(line),
        },
      )
      bus.emit({
        type: "session:awaiting-input",
        sessionId: "w",
        ts: T0,
        question: { text: "which one?", source: "structured" },
      } as never)
      turnEnd("x")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toContain("(w) awaiting-input")
      expect(sent[0]!.text).toContain("(x) turn-end")
      expect(sent[0]!.urgency).toBe("next-turn")
      expect(logs.some(line => line.startsWith("[session-follow] triage failed for chief:"))).toBe(true)
      expect(logs.join("\n")).not.toContain("which one?")
    })

    it("identifies every ledger line with eventTs and a per-flush digestId", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        triage: { enabled: true },
      })
      exited("w", { ts: at(1_000), reason: "operator-stopped" })
      turnEnd("w", { ts: at(2_000) })
      await handle!.flush()
      const first = readFileSync(join(tmp, "triage.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(l => JSON.parse(l) as Record<string, unknown>)
      expect(first).toHaveLength(2)
      expect(first[0]).toMatchObject({ event: "exited", eventTs: at(1_000), digestId: expect.any(String) })
      expect(first[1]).toMatchObject({ event: "turn-end", eventTs: at(2_000), digestId: expect.any(String) })
      expect(new Set(first.map(line => line.digestId)).size).toBe(1)

      exited("w", { ts: at(3_000), reason: "operator-stopped" })
      await handle!.flush()
      const second = readFileSync(join(tmp, "triage.jsonl"), "utf8")
        .trim()
        .split("\n")
        .slice(first.length)
        .map(l => JSON.parse(l) as Record<string, unknown>)
      expect(second).toHaveLength(1)
      expect(second[0]).toMatchObject({ event: "exited", eventTs: at(3_000), digestId: expect.any(String) })
      expect(second[0]!.digestId).not.toBe(first[0]!.digestId)

      for (const line of [...first, ...second]) {
        expect(line).not.toHaveProperty("detail")
        expect(line).not.toHaveProperty("text")
      }
      expect(sent).toHaveLength(2)
    })

    it("records the event key and task id on a board line", async () => {
      const { sent } = setup([running("chief")], {
        selector: { boardId: "board-1" },
        triage: { enabled: true },
      })
      taskChanged("worker", "board-1", "t1")
      await handle!.flush()
      const line = JSON.parse(readFileSync(join(tmp, "triage.jsonl"), "utf8").trim()) as Record<string, unknown>
      expect(line).toMatchObject({
        event: "task-changed",
        eventTs: T0,
        key: "board-1:t1",
        taskId: "t1",
        digestId: expect.any(String),
      })
      expect(sent).toHaveLength(1)
    })

    it("writes one JSONL line per triaged event", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        triage: { enabled: true },
      })
      exited("w", { reason: "operator-stopped" })
      turnEnd("w")
      await handle!.flush()
      const lines = readFileSync(join(tmp, "triage.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(l => JSON.parse(l) as { event: string; decision: string; rule: string; follower: string })
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatchObject({ follower: "chief", event: "exited", decision: "fyi", rule: "operator-exit" })
      expect(lines[1]).toMatchObject({ event: "turn-end", decision: "wake", rule: "default" })
      expect(sent).toHaveLength(1)
    })

    it("records every rule verdict with applied:false while triage is off", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
      })
      bus.emit({
        type: "session:message",
        sessionId: "chief",
        messageId: "msg_1",
        fromSessionId: "w",
        relation: "child",
        kind: "report",
        urgency: "next-turn",
        ts: at(-5_000),
      } as never)
      turnEnd("w")
      exited("w", { reason: "operator-stopped" })
      await handle!.flush()
      const lines = readFileSync(join(tmp, "triage.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(l => JSON.parse(l) as Record<string, unknown>)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatchObject({
        source: "follow",
        applied: false,
        event: "turn-end",
        decision: "drop",
        rule: "reported-turn-end",
      })
      expect(lines[1]).toMatchObject({
        source: "follow",
        applied: false,
        event: "exited",
        decision: "fyi",
        rule: "operator-exit",
      })
      expect(lines[0]).toMatchObject({ eventTs: T0, digestId: expect.any(String) })
      expect(lines[1]).toMatchObject({ eventTs: T0, digestId: expect.any(String) })
      expect(new Set(lines.map(line => line.digestId)).size).toBe(1)
      for (const line of lines) {
        expect(line).not.toHaveProperty("detail")
        expect(line).not.toHaveProperty("text")
      }
      // Delivery is unchanged: the disabled ledger never filters the digest.
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toContain("2 events")
    })

    it("never runs a daemon classifier while triage is off", async () => {
      const marker = join(tmp, "ran")
      const { sent } = setup(
        [running("chief"), running("w")],
        { selector: { sessionIds: ["w"] } },
        {
          triage: {
            ...defaultFollowTriageConfig(),
            classifier: { command: `touch ${marker}` },
          },
        },
      )
      turnEnd("w")
      await handle!.flush()
      expect(existsSync(marker)).toBe(false)
      expect(sent).toHaveLength(1)
      const lines = readFileSync(join(tmp, "triage.jsonl"), "utf8").trim().split("\n")
      expect(JSON.parse(lines[0]!)).toMatchObject({
        source: "follow",
        applied: false,
        decision: "wake",
        rule: "default",
      })
    })

    it("keeps the legacy digest text and urgency while triage is off", async () => {
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
      })
      turnEnd("w")
      exited("w", { reason: "operator-stopped" })
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
      expect(sent[0]!.text).toBe(
        "[session-follow] automatic digest \u2014 2 events from sessions you follow. " +
          "Decide whether anything needs the human's attention; if not, no reply is needed.\n" +
          "[session-follow] w (w) turn-end \u2014 proj\n" +
          "[session-follow] w (w) exited \u2014 proj \u2014 operator-stopped",
      )
    })
  })

  // ── The tool surface ────────────────────────────────────────────────

  it("accepts a triage block on `session_follow` and stores it", () => {
    const store = createSessionFollowStore({ persist: false })
    const result = upsertSessionFollow(
      { store, hasSession: () => true, defaultFollower: "chief" },
      {
        selector: { all: true },
        triage: {
          enabled: true,
          rules: { operatorExit: false },
          reportWindowMs: 30_000,
        },
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.follow.triage).toEqual({
      enabled: true,
      rules: { operatorExit: false },
      reportWindowMs: 30_000,
    })
    // The daemon default fills the rules the follow did not name.
    const resolved = resolveFollowTriageConfig(defaultFollowTriageConfig(), result.follow.triage)
    expect(resolved.enabled).toBe(true)
    expect(resolved.rules.operatorExit).toBe(false)
    expect(resolved.rules.cronOk).toBe(true)
    expect(resolved.reportWindowMs).toBe(30_000)
  })

  // ── The classifier hook ─────────────────────────────────────────────
  describe("classifier hook", () => {
    it("lets the classifier downgrade a waking event", async () => {
      const { sent } = setup(
        [running("chief"), running("w")],
        { selector: { sessionIds: ["w"] } },
        { triage: { ...defaultFollowTriageConfig(), enabled: true, classifier: { command: "echo fyi" } } },
      )
      turnEnd("w")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("fyi")
    })

    it("falls back to the rules when the classifier times out", async () => {
      const { sent } = setup(
        [running("chief"), running("w")],
        { selector: { sessionIds: ["w"] } },
        { triage: { ...defaultFollowTriageConfig(), enabled: true, classifier: { command: "sleep 5", timeoutMs: 50 } } },
      )
      turnEnd("w")
      await handle!.flush()
      // The rules decide: a plain turn-end wakes.
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
      const lines = readFileSync(join(tmp, "triage.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(l => JSON.parse(l) as { decision: string; rule: string })
      expect(lines[0]).toMatchObject({ decision: "wake", rule: "default" })
    })

    it("never lets the classifier silence an always-wake event", async () => {
      const { sent } = setup(
        [running("chief"), running("w")],
        { selector: { sessionIds: ["w"] } },
        { triage: { ...defaultFollowTriageConfig(), enabled: true, classifier: { command: "echo drop" } } },
      )
      bus.emit({
        type: "session:awaiting-input",
        sessionId: "w",
        ts: T0,
        question: { text: "which one?", source: "structured" },
      } as never)
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
    })
    it("ignores a classifier smuggled onto a follow record (operator config only)", async () => {
      const marker = join(tmp, "ran")
      const { sent } = setup([running("chief"), running("w")], {
        selector: { sessionIds: ["w"] },
        triage: { enabled: true, classifier: { command: `touch ${marker}` } } as never,
      })
      turnEnd("w")
      await handle!.flush()
      expect(existsSync(marker)).toBe(false)
      expect(sent).toHaveLength(1)
      const lines = readFileSync(join(tmp, "triage.jsonl"), "utf8").trim().split("\n")
      expect(JSON.parse(lines[0]!)).toMatchObject({ decision: "wake", rule: "default" })
    })

    it("rejects a per-follow classifier on the `session_follow` tool", () => {
      const store = createSessionFollowStore({ persist: false })
      const result = upsertSessionFollow(
        { store, hasSession: () => true, defaultFollower: "chief" },
        { selector: { all: true }, triage: { enabled: true, classifier: { command: "id" } } },
      )
      expect(result.ok).toBe(false)
      expect(store.list()).toHaveLength(0)
    })
  })

  // ── Per-follow rule overrides ───────────────────────────────────────
  describe("per-follow rule overrides", () => {
    it("lets a follow switch a rule OFF against the all-rules-on daemon default", async () => {
      const { sent } = setup(
        [running("chief"), running("w")],
        { selector: { sessionIds: ["w"] }, triage: { enabled: true, rules: { operatorExit: false } } },
        { triage: defaultFollowTriageConfig() },
      )
      exited("w", { reason: "operator-stopped" })
      await handle!.flush()
      // operatorExit is off for this follow: the exit is NOT downgraded to fyi.
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("next-turn")
      const lines = readFileSync(join(tmp, "triage.jsonl"), "utf8").trim().split("\n")
      expect(JSON.parse(lines[0]!)).toMatchObject({ decision: "wake", rule: "default" })
    })

    it("keeps a rule ON for a follow that does not name it", async () => {
      const { sent } = setup(
        [running("chief"), running("w")],
        { selector: { sessionIds: ["w"] }, triage: { enabled: true, rules: { cronOk: false } } },
        { triage: defaultFollowTriageConfig() },
      )
      exited("w", { reason: "operator-stopped" })
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("fyi")
    })

    it("when co-batched follows disagree on a rule, ON wins", async () => {
      const { sent, store } = setup(
        [running("chief"), running("w1"), running("w2")],
        { selector: { sessionIds: ["w1"] }, triage: { enabled: true, rules: { operatorExit: false } } },
        { triage: defaultFollowTriageConfig() },
      )
      store.upsert({
        key: "second",
        batchMs: 0,
        follower: "chief",
        selector: { sessionIds: ["w2"] },
        triage: { rules: { operatorExit: true } },
      })
      exited("w1", { reason: "operator-stopped" })
      exited("w2", { reason: "operator-stopped" })
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.urgency).toBe("fyi")
    })
  })
})
