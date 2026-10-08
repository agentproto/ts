import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, SessionNotAliveError, type AgentSessionLike, type SessionDescriptor } from "../sessions.js"
import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import type { SessionMessage } from "../session-message.js"
import { createSessionFollowStore, type SessionFollowInput } from "../session-follow-store.js"
import {
  excerptOf,
  followCoversSession,
  FOLLOW_EXCERPT_MAX,
  wireSessionFollow,
  type SessionFollowHandle,
} from "../session-follow.js"

const NOW = "2026-10-05T00:00:00.000Z"

type Desc = Partial<SessionDescriptor> & { id: string }

/** Minimal registry double: a descriptor map + a `sendMessage` spy. */
function stubRegistry(initial: Desc[]) {
  const sessions = new Map<string, Desc>(initial.map(d => [d.id, d]))
  const sent: SessionMessage[] = []
  const sendMessage = vi.fn(async (msg: SessionMessage, _opts?: { source?: string; origin?: string }) => {
    sent.push(msg)
    return {}
  })
  return {
    sessions,
    sent,
    sendMessage,
    registry: {
      get: (id: string) => sessions.get(id) as SessionDescriptor | undefined,
      sendMessage,
    },
  }
}

const running = (id: string, extra: Partial<SessionDescriptor> = {}): Desc => ({
  id,
  status: "running",
  cwd: "/work/proj",
  ...extra,
})

function emitTurnEnd(bus: SessionEventBus, sessionId: string, extra: Record<string, unknown> = {}): void {
  bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: NOW, ...extra } as never)
}

describe("session-follow", () => {
  let bus: SessionEventBus
  let handle: SessionFollowHandle | undefined
  let tmp: string

  beforeEach(() => {
    bus = createSessionEventBus()
    tmp = mkdtempSync(join(tmpdir(), "session-follow-"))
  })
  afterEach(() => {
    handle?.dispose()
    handle = undefined
    vi.useRealTimers()
    rmSync(tmp, { recursive: true, force: true })
  })

  function setup(
    descs: Desc[],
    follow: Partial<SessionFollowInput> & Pick<SessionFollowInput, "selector"> & { follower?: string },
    extra: Partial<Parameters<typeof wireSessionFollow>[0]> = {},
  ) {
    const reg = stubRegistry(descs)
    const store = createSessionFollowStore({ persist: false })
    const { follower, ...rest } = follow
    store.upsert({ batchMs: 0, ...rest, follower: follower ?? "chief" })
    handle = wireSessionFollow({
      registry: reg.registry,
      sessionEvents: bus,
      store,
      readLastOutput: () => undefined,
      parkedPath: join(tmp, "parked.jsonl"),
      log: () => {},
      ...extra,
    })
    return { ...reg, store }
  }

  describe("selector matching", () => {
    it("explicit sessionIds match regardless of parentage", async () => {
      const { sent } = setup(
        [running("chief"), running("a"), running("b"), running("c", { parentSessionId: "a" })],
        { selector: { sessionIds: ["a", "c"] } },
      )
      emitTurnEnd(bus, "a")
      emitTurnEnd(bus, "b")
      emitTurnEnd(bus, "c")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toContain("(a)")
      expect(sent[0]!.text).toContain("(c)") // explicit id wins over rootOnly
      expect(sent[0]!.text).not.toContain("(b)")
    })

    it("all defaults to rootOnly (children of anyone are skipped); rootOnly:false covers them", async () => {
      const descs = [running("chief"), running("root1"), running("kid", { parentSessionId: "root1" })]
      const first = setup(descs, { selector: { all: true } })
      emitTurnEnd(bus, "root1")
      emitTurnEnd(bus, "kid")
      await handle!.flush()
      expect(first.sent[0]!.text).toContain("(root1)")
      expect(first.sent[0]!.text).not.toContain("(kid)")
      handle!.dispose()

      const second = setup(descs, { selector: { all: true, rootOnly: false } })
      emitTurnEnd(bus, "kid")
      await handle!.flush()
      expect(second.sent[0]!.text).toContain("(kid)")
    })

    it("cwdPrefix matches the path or below, on a path boundary", () => {
      const { store, registry } = setup([running("chief")], { selector: { cwdPrefix: "/work/proj" } })
      const follow = store.list()[0]!
      const cover = (cwd: string, extra: Partial<SessionDescriptor> = {}) =>
        followCoversSession(follow, "x", { id: "x", cwd, ...extra } as SessionDescriptor, registry)
      expect(cover("/work/proj")).toBe(true)
      expect(cover("/work/proj/sub")).toBe(true)
      expect(cover("/work/proj-other")).toBe(false)
      expect(cover("/elsewhere")).toBe(false)
      // cwdPrefix alone is not rootOnly by default.
      expect(cover("/work/proj", { parentSessionId: "p" })).toBe(true)
    })

    it("exclude by session id and by label", async () => {
      const { sent } = setup(
        [running("chief"), running("ok1"), running("noisy"), running("labelled", { label: "judge" })],
        { selector: { all: true }, exclude: { sessionIds: ["noisy"], labels: ["judge"] } },
      )
      emitTurnEnd(bus, "ok1")
      emitTurnEnd(bus, "noisy")
      emitTurnEnd(bus, "labelled")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toContain("(ok1)")
      expect(sent[0]!.text).not.toContain("noisy")
      expect(sent[0]!.text).not.toContain("judge")
    })

    it("the follower's own descendants are excluded by default (any depth), included when disabled", async () => {
      const descs = [
        running("chief"),
        running("kid", { parentSessionId: "chief" }),
        running("grandkid", { parentSessionId: "kid" }),
      ]
      const on = setup(descs, { selector: { all: true, rootOnly: false } })
      emitTurnEnd(bus, "kid")
      emitTurnEnd(bus, "grandkid")
      await handle!.flush()
      expect(on.sent).toHaveLength(0)
      handle!.dispose()

      const off = setup(descs, {
        selector: { all: true, rootOnly: false },
        excludeFollowerChildren: false,
      })
      emitTurnEnd(bus, "grandkid")
      await handle!.flush()
      expect(off.sent).toHaveLength(1)
    })

    it("excludeFollowerChildren:false delivers the follower's descendants even under rootOnly", async () => {
      const descs = [
        running("chief"),
        running("root1"),
        running("kid", { parentSessionId: "chief", cwd: "/elsewhere" }),
        running("grandkid", { parentSessionId: "kid" }),
        running("other-kid", { parentSessionId: "root1" }),
      ]
      const { sent } = setup(descs, { selector: { all: true }, excludeFollowerChildren: false })
      emitTurnEnd(bus, "root1")
      emitTurnEnd(bus, "kid")
      emitTurnEnd(bus, "grandkid")
      emitTurnEnd(bus, "other-kid")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toContain("(root1)")
      expect(sent[0]!.text).toContain("(kid)")
      expect(sent[0]!.text).toContain("(grandkid)")
      expect(sent[0]!.text).not.toContain("(other-kid)") // someone else's child: still rootOnly
    })

    it("the follower is never notified of its own events", async () => {
      const { sent } = setup([running("chief")], { selector: { all: true } })
      emitTurnEnd(bus, "chief")
      bus.emit({ type: "session:exited", sessionId: "chief", status: "exited", ts: NOW })
      await handle!.flush()
      expect(sent).toHaveLength(0)
      // ...even when it is named explicitly.
      const explicit = setup([running("chief")], { selector: { sessionIds: ["chief"] } })
      emitTurnEnd(bus, "chief")
      await handle!.flush()
      expect(explicit.sent).toHaveLength(0)
    })

    it("auto-covers a session spawned AFTER the follow was created", async () => {
      const { sent, sessions } = setup([running("chief")], { selector: { all: true } })
      sessions.set("late", running("late", { label: "latecomer" }))
      emitTurnEnd(bus, "late")
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toContain("latecomer (late)")
    })
  })

  describe("event kinds", () => {
    it("honours the events filter", async () => {
      const { sent } = setup([running("chief"), running("a")], {
        selector: { all: true },
        events: ["exited"],
      })
      emitTurnEnd(bus, "a")
      bus.emit({ type: "session:awaiting-input", sessionId: "a", ts: NOW })
      await handle!.flush()
      expect(sent).toHaveLength(0)
      bus.emit({ type: "session:exited", sessionId: "a", status: "exited", ts: NOW })
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toMatch(/\(a\) exited/)
    })

    it("maps status:error / reason:crashed to crashed, any other exit to exited", async () => {
      const { sent } = setup([running("chief"), running("a"), running("b"), running("c")], {
        selector: { all: true },
      })
      bus.emit({ type: "session:exited", sessionId: "a", status: "error", ts: NOW })
      bus.emit({ type: "session:exited", sessionId: "b", status: "killed", reason: "crashed", ts: NOW })
      bus.emit({ type: "session:exited", sessionId: "c", status: "killed", reason: "operator-stopped", ts: NOW })
      await handle!.flush()
      const text = sent[0]!.text
      expect(text).toMatch(/\(a\) crashed/)
      expect(text).toMatch(/\(b\) crashed/)
      expect(text).toMatch(/\(c\) exited/)
      expect(text).toContain("operator-stopped")
    })

    it("skips empty turns by default; delivers them when skipEmptyTurns is false", async () => {
      const skip = setup([running("chief"), running("a")], { selector: { all: true } })
      emitTurnEnd(bus, "a", { empty: true })
      await handle!.flush()
      expect(skip.sent).toHaveLength(0)
      handle!.dispose()

      const keep = setup([running("chief"), running("a")], { selector: { all: true }, skipEmptyTurns: false })
      emitTurnEnd(bus, "a", { empty: true })
      await handle!.flush()
      expect(keep.sent).toHaveLength(1)
    })

    it("a turn-end that left the session awaiting input reads as awaiting-input, once", async () => {
      const { sent } = setup([running("chief"), running("a")], { selector: { all: true } })
      emitTurnEnd(bus, "a", { awaitingInput: true, question: { text: "Deploy now?", source: "heuristic" } })
      bus.emit({
        type: "session:awaiting-input",
        sessionId: "a",
        ts: NOW,
        question: { text: "Deploy now?", source: "heuristic" },
      })
      await handle!.flush()
      const lines = sent[0]!.text.split("\n").filter(l => l.includes("(a)"))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("awaiting-input")
      expect(lines[0]).toContain("Deploy now?")
    })

    it("with only turn-end subscribed, an awaiting turn-end still reads as turn-end", async () => {
      const { sent } = setup([running("chief"), running("a")], {
        selector: { all: true },
        events: ["turn-end"],
      })
      emitTurnEnd(bus, "a", { awaitingInput: true })
      await handle!.flush()
      expect(sent[0]!.text).toMatch(/ \(a\) turn-end/)
    })

    it("PR activities: opened once, merged on done, cancelled ignored", async () => {
      const { sent } = setup([running("chief"), running("a", { cwd: "/work/repo" })], {
        selector: { all: true },
      })
      const pr = (state: string, title: string) =>
        bus.emit({
          type: "activity:changed",
          ts: NOW,
          activity: { id: "pr:a:12", kind: "pr", sessionId: "a", state, title, sourceRef: "u", source: "code-host", startedAt: NOW },
        } as never)
      pr("pending", "PR #12 open (https://github.com/o/r/pull/12)")
      pr("pending", "PR #12 open (https://github.com/o/r/pull/12)") // re-projection
      await handle!.flush()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toMatch(/ \(a\) pr-opened — repo — PR #12 open/)
      expect(sent[0]!.text.match(/pr-opened/g)).toHaveLength(1)

      pr("done", "PR #12 merged (https://github.com/o/r/pull/12)")
      await handle!.flush()
      expect(sent).toHaveLength(2)
      expect(sent[1]!.text).toMatch(/ \(a\) pr-merged — repo — PR #12 merged/)

      pr("cancelled", "PR #12 closed")
      bus.emit({ type: "activity:changed", ts: NOW, activity: { id: "turn:a:1", kind: "turn", sessionId: "a", state: "done" } } as never)
      bus.emit({ type: "activity:changed", ts: NOW, activity: undefined } as never)
      await handle!.flush()
      expect(sent).toHaveLength(2)
    })
  })

  describe("delivery", () => {
    it("coalesces events within batchMs into ONE system/notice next-turn message", async () => {
      vi.useFakeTimers()
      const { sent, sendMessage } = setup(
        [running("chief"), running("a", { label: "alpha" }), running("b")],
        { selector: { all: true }, batchMs: 15_000 },
      )
      emitTurnEnd(bus, "a")
      await vi.advanceTimersByTimeAsync(5_000)
      emitTurnEnd(bus, "b")
      bus.emit({ type: "session:exited", sessionId: "a", status: "exited", ts: NOW })
      await vi.advanceTimersByTimeAsync(9_000)
      expect(sendMessage).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_500)

      expect(sendMessage).toHaveBeenCalledTimes(1)
      const msg = sent[0]!
      expect(msg.to).toBe("chief")
      expect(msg.from).toEqual({ relation: "system" })
      expect(msg.kind).toBe("notice")
      expect(msg.urgency).toBe("next-turn")
      expect(sendMessage.mock.calls[0]![1]).toEqual({ source: "session-follow", origin: "follow:chief" })
      const [header, ...lines] = msg.text.split("\n")
      expect(header).toMatch(/^\[session-follow\] automatic digest — 3 events/)
      expect(header).toContain("needs the human's attention")
      expect(lines).toEqual([
        "[session-follow] alpha (a) turn-end — proj",
        "[session-follow] b (b) turn-end — proj",
        "[session-follow] alpha (a) exited — proj",
      ])
    })

    it("collapses consecutive same-session duplicates, keeping the latest", async () => {
      const { sent } = setup([running("chief"), running("a")], { selector: { all: true } })
      emitTurnEnd(bus, "a", { error: "first" })
      emitTurnEnd(bus, "a", { error: "second" })
      emitTurnEnd(bus, "a", { error: "third" })
      await handle!.flush()
      const lines = sent[0]!.text.split("\n").slice(1)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("third")
      expect(sent[0]!.text).toContain("1 event ")
    })

    it("excerpts the last assistant text / outcome summary, tail-trimmed to 300 chars", async () => {
      const long = "intro ".repeat(100) + "THE CONCLUSION"
      const { sent } = setup(
        [running("chief"), running("a"), running("b", { outcome: { summary: "shipped it" } as never })],
        { selector: { all: true } },
        { readLastOutput: d => (d.id === "a" ? long : undefined) },
      )
      emitTurnEnd(bus, "a")
      bus.emit({ type: "session:exited", sessionId: "b", status: "exited", ts: NOW })
      await handle!.flush()
      const [lineA, lineB] = sent[0]!.text.split("\n").slice(1)
      const excerpt = lineA!.split(" — ")[2]!
      expect(excerpt.length).toBeLessThanOrEqual(FOLLOW_EXCERPT_MAX)
      expect(excerpt.startsWith("…")).toBe(true)
      expect(excerpt.endsWith("THE CONCLUSION")).toBe(true)
      expect(lineB).toMatch(/ \(b\) exited — proj — shipped it$/)
      expect(excerptOf("  a \n b  ")).toBe("a b")
      expect(excerptOf("")).toBeUndefined()
    })

    it("separate followers get separate digests", async () => {
      const reg = stubRegistry([running("chief"), running("chief2"), running("a")])
      const store = createSessionFollowStore({ persist: false })
      store.upsert({ follower: "chief", selector: { all: true }, batchMs: 0 })
      store.upsert({ follower: "chief2", selector: { sessionIds: ["a"] }, batchMs: 0 })
      handle = wireSessionFollow({ registry: reg.registry, sessionEvents: bus, store, readLastOutput: () => undefined, log: () => {} })
      emitTurnEnd(bus, "a")
      await handle.flush()
      expect(reg.sent.map(m => m.to).sort()).toEqual(["chief", "chief2"])
    })

    it("one follower with two matching follows still gets the event once", async () => {
      const reg = stubRegistry([running("chief"), running("a")])
      const store = createSessionFollowStore({ persist: false })
      store.upsert({ follower: "chief", selector: { all: true }, batchMs: 0 })
      store.upsert({ follower: "chief", selector: { sessionIds: ["a"] }, batchMs: 0 })
      handle = wireSessionFollow({ registry: reg.registry, sessionEvents: bus, store, readLastOutput: () => undefined, log: () => {} })
      emitTurnEnd(bus, "a")
      await handle.flush()
      expect(reg.sent).toHaveLength(1)
      expect(reg.sent[0]!.text).toContain("1 event ")
    })

    it("flush with nothing pending is a no-op; dispose stops delivery", async () => {
      const { sent } = setup([running("chief"), running("a")], { selector: { all: true } })
      await handle!.flush()
      handle!.dispose()
      emitTurnEnd(bus, "a")
      await handle!.flush()
      expect(sent).toHaveLength(0)
    })
  })

  describe("dead follower", () => {
    it("follower missing from the registry: nothing sent, no throw, follow kept", async () => {
      const { sent, store } = setup([running("a")], { selector: { all: true } })
      emitTurnEnd(bus, "a")
      await expect(handle!.flush()).resolves.toBeUndefined()
      expect(sent).toHaveLength(0)
      expect(store.list()).toHaveLength(1)
    })

    it("a dead (resumable) follower is resumed via restartSession, then delivered to", async () => {
      const restartSession = vi.fn(async (id: string) => id)
      const { sent } = setup(
        [running("chief", { status: "killed", endedReason: "idle-reaped" }), running("a")],
        { selector: { all: true } },
        { restartSession },
      )
      emitTurnEnd(bus, "a")
      await handle!.flush()
      expect(restartSession).toHaveBeenCalledWith("chief")
      expect(sent).toHaveLength(1)
      expect(sent[0]!.to).toBe("chief")
    })

    it("a follower resumed under a NEW id re-points its follows", async () => {
      const { sent, store } = setup(
        [running("chief", { status: "exited" }), running("a")],
        { selector: { all: true } },
        { restartSession: async () => "chief-2" },
      )
      emitTurnEnd(bus, "a")
      await handle!.flush()
      expect(sent[0]!.to).toBe("chief-2")
      expect(store.list()[0]!.follower).toBe("chief-2")
    })

    it("sendMessage throwing SessionNotAliveError on a believed-alive follower triggers the restart path", async () => {
      const restartSession = vi.fn(async (id: string) => id)
      const reg = stubRegistry([running("chief"), running("a")])
      let first = true
      reg.sendMessage.mockImplementation(async (msg: SessionMessage, _opts?: { source?: string; origin?: string }) => {
        if (first) {
          first = false
          throw new SessionNotAliveError("chief", "killed", "test")
        }
        reg.sent.push(msg)
        return {}
      })
      const store = createSessionFollowStore({ persist: false })
      store.upsert({ follower: "chief", selector: { all: true }, batchMs: 0 })
      handle = wireSessionFollow({ registry: reg.registry, sessionEvents: bus, store, restartSession, log: () => {}, readLastOutput: () => undefined })
      emitTurnEnd(bus, "a")
      await handle.flush()
      expect(restartSession).toHaveBeenCalledTimes(1)
      expect(reg.sent).toHaveLength(1)
    })

    it("a deliberately-closed follower is NOT resumed; the digest is parked", async () => {
      const restartSession = vi.fn(async (id: string) => id)
      const parkedPath = join(tmp, "parked.jsonl")
      const { sent, store } = setup(
        [running("chief", { status: "killed", endedReason: "operator-stopped" }), running("a")],
        { selector: { all: true } },
        { restartSession, parkedPath },
      )
      emitTurnEnd(bus, "a")
      await handle!.flush()
      expect(restartSession).not.toHaveBeenCalled()
      expect(sent).toHaveLength(0)
      expect(store.list()).toHaveLength(1)
      const parked = JSON.parse(readFileSync(parkedPath, "utf8").trim()) as { follower: string; text: string }
      expect(parked.follower).toBe("chief")
      expect(parked.text).toContain("[session-follow]")
    })

    it("an ARCHIVED dead follower is never revived or re-minted; the digest is parked", async () => {
      const restartSession = vi.fn(async (id: string) => id)
      const parkedPath = join(tmp, "parked-archived.jsonl")
      const { sent } = setup(
        [running("chief", { status: "exited", archived: true }), running("a")],
        { selector: { all: true } },
        { restartSession, parkedPath },
      )
      emitTurnEnd(bus, "a")
      await handle!.flush()
      expect(restartSession).not.toHaveBeenCalled()
      expect(sent).toHaveLength(0)
      expect(readFileSync(parkedPath, "utf8")).toContain("archived")
    })

    it("a follower killed AFTER it already ended (retiredAt, no deliberate endedReason) is never revived", async () => {
      const restartSession = vi.fn(async (id: string) => id)
      const parkedPath = join(tmp, "parked-retiredat.jsonl")
      const { sent } = setup(
        [
          running("chief", { status: "killed", endedReason: "idle-reaped", retiredAt: NOW }),
          running("a"),
        ],
        { selector: { all: true } },
        { restartSession, parkedPath },
      )
      emitTurnEnd(bus, "a")
      await handle!.flush()
      expect(restartSession).not.toHaveBeenCalled()
      expect(sent).toHaveLength(0)
      expect(readFileSync(parkedPath, "utf8")).toContain("retired")
    })

    it("a superseded follower's digest goes to the END of its continuedTo chain (transitive) and re-points the follow", async () => {
      const restartSession = vi.fn(async (id: string) => id)
      const { sent, store } = setup(
        [
          running("chief", { status: "killed", endedReason: "restarted", continuedTo: "chief-2" }),
          running("chief-2", { status: "killed", endedReason: "restarted", continuedTo: "chief-3" }),
          running("chief-3"),
          running("a"),
        ],
        { selector: { all: true } },
        { restartSession },
      )
      emitTurnEnd(bus, "a")
      await handle!.flush()
      expect(restartSession).not.toHaveBeenCalled()
      expect(sent.map(m => m.to)).toEqual(["chief-3"])
      expect(store.list()[0]!.follower).toBe("chief-3")
    })

    it("a superseded follower whose successor is dead (not retired) revives the SUCCESSOR, never the retired row", async () => {
      const restartSession = vi.fn(async (id: string) => id)
      const { sent, store } = setup(
        [
          running("chief", { status: "killed", endedReason: "restarted", continuedTo: "chief-2" }),
          running("chief-2", { status: "exited", endedReason: "idle-reaped" }),
          running("a"),
        ],
        { selector: { all: true } },
        { restartSession },
      )
      emitTurnEnd(bus, "a")
      await handle!.flush()
      expect(restartSession).toHaveBeenCalledTimes(1)
      expect(restartSession).toHaveBeenCalledWith("chief-2")
      expect(sent.map(m => m.to)).toEqual(["chief-2"])
      expect(store.list()[0]!.follower).toBe("chief-2")
    })

    it("a superseded follower whose whole chain is retired parks the digest", async () => {
      const restartSession = vi.fn(async (id: string) => id)
      const parkedPath = join(tmp, "parked-chain.jsonl")
      const { sent } = setup(
        [
          running("chief", { status: "killed", endedReason: "restarted", continuedTo: "chief-2" }),
          running("chief-2", { status: "killed", endedReason: "operator-stopped" }),
          running("a"),
        ],
        { selector: { all: true } },
        { restartSession, parkedPath },
      )
      emitTurnEnd(bus, "a")
      await handle!.flush()
      expect(restartSession).not.toHaveBeenCalled()
      expect(sent).toHaveLength(0)
      expect(readFileSync(parkedPath, "utf8")).toContain("superseded")
    })

    it("no restart hook: the digest is parked, not lost silently", async () => {
      const parkedPath = join(tmp, "parked-2.jsonl")
      const { sent } = setup(
        [running("chief", { status: "exited" }), running("a")],
        { selector: { all: true } },
        { parkedPath },
      )
      emitTurnEnd(bus, "a")
      await handle!.flush()
      expect(sent).toHaveLength(0)
      expect(existsSync(parkedPath)).toBe(true)
    })

    it("a failing restart parks the digest instead of throwing", async () => {
      const parkedPath = join(tmp, "parked-3.jsonl")
      setup(
        [running("chief", { status: "exited" }), running("a")],
        { selector: { all: true } },
        { restartSession: async () => { throw new Error("no adapter") }, parkedPath },
      )
      emitTurnEnd(bus, "a")
      await expect(handle!.flush()).resolves.toBeUndefined()
      expect(readFileSync(parkedPath, "utf8")).toContain("no adapter")
    })

    it("a repoint between enqueue and flush delivers to the live replacement, not a second resurrection", async () => {
      // Mirrors the real incident: sess_17af1f3b repointed the follow (same
      // `key`, same mechanism as `store.setFollower`) while a batch already
      // queued for the dead sess_66a795f2 was still in flight.
      const restartSession = vi.fn(async (id: string) => id)
      const { sent, store } = setup(
        [running("chief", { status: "exited" }), running("chief-2"), running("a")],
        { selector: { all: true } },
        { restartSession },
      )
      emitTurnEnd(bus, "a")
      store.setFollower(store.list()[0]!.id, "chief-2")
      await handle!.flush()
      expect(restartSession).not.toHaveBeenCalled()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.to).toBe("chief-2")
    })

    it("the daemon's own continuedTo lineage counts as a live replacement too", async () => {
      const restartSession = vi.fn(async (id: string) => id)
      const { sent } = setup(
        [running("chief", { status: "exited", continuedTo: "chief-2" }), running("chief-2"), running("a")],
        { selector: { all: true } },
        { restartSession },
      )
      emitTurnEnd(bus, "a")
      await handle!.flush()
      expect(restartSession).not.toHaveBeenCalled()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.to).toBe("chief-2")
    })

    it("a failed delivery to a live replacement parks the digest instead of dropping it", async () => {
      const parkedPath = join(tmp, "parked-replacement.jsonl")
      const restartSession = vi.fn(async (id: string) => id)
      const { sent, store, sendMessage } = setup(
        [running("chief", { status: "exited" }), running("chief-2"), running("a")],
        { selector: { all: true } },
        { restartSession, parkedPath },
      )
      sendMessage.mockImplementation(async () => {
        throw new Error("replacement unreachable")
      })
      emitTurnEnd(bus, "a")
      store.setFollower(store.list()[0]!.id, "chief-2")
      await handle!.flush()
      expect(restartSession).not.toHaveBeenCalled()
      expect(sent).toHaveLength(0)
      expect(readFileSync(parkedPath, "utf8")).toContain("replacement unreachable")
    })

    it("two deliveries racing for the same dead follower collapse into one restart", async () => {
      let resolveRestart: (() => void) | undefined
      const restartSession = vi.fn(
        (id: string) =>
          new Promise<string>(resolve => {
            resolveRestart = () => resolve(id)
          }),
      )
      const { sent } = setup(
        [running("chief", { status: "exited" }), running("a"), running("b")],
        { selector: { all: true } },
        { restartSession },
      )
      emitTurnEnd(bus, "a")
      const firstFlush = handle!.flush("chief")
      await Promise.resolve()
      emitTurnEnd(bus, "b") // a second batch forms for the same (still dead) follower id
      const secondFlush = handle!.flush("chief")
      resolveRestart?.()
      await Promise.all([firstFlush, secondFlush])
      expect(restartSession).toHaveBeenCalledTimes(1)
      expect(sent).toHaveLength(2)
      expect(sent.every(m => m.to === "chief")).toBe(true)
    })
  })
})

// ── Against a REAL registry: busy vs idle follower ───────────────────

function liveAgentSession(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    pid: process.pid,
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

function controllableAgentSession(sessionId: string) {
  const messages: unknown[] = []
  let resolveTurn: (() => void) | null = null
  const cancel = vi.fn(async () => {})
  const session: AgentSessionLike = {
    sessionId,
    pid: process.pid,
    async *send(message) {
      messages.push(message)
      await new Promise<void>(resolve => {
        resolveTurn = resolve
      })
      yield { kind: "turn-end", reason: "completed" }
    },
    cancel,
    async close() {},
  }
  return {
    session,
    messages,
    cancel,
    finishTurn: () => {
      const r = resolveTurn
      resolveTurn = null
      r?.()
    },
  }
}

describe("session-follow against a real registry", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-follow-real-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("idle follower: the digest is delivered as its own next-turn system/notice (no interrupt)", async () => {
    const bus = createSessionEventBus()
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const store = createSessionFollowStore({ persist: false })
    const handle = wireSessionFollow({ registry: reg, sessionEvents: bus, store, parkedPath: join(tmp, "parked.jsonl"), log: () => {} })

    const chief = reg.spawnAgent({ workspaceSlug: "default", cwd: "/tmp", agentSession: liveAgentSession("acp-chief"), adapterSlug: "claude-code" })
    const other = reg.spawnAgent({ workspaceSlug: "default", cwd: "/tmp/other", agentSession: liveAgentSession("acp-other"), adapterSlug: "claude-code", label: "other-1" })
    store.upsert({ follower: chief.id, selector: { all: true }, batchMs: 0 })

    const enqueueSpy = vi.spyOn(reg, "enqueuePrompt").mockResolvedValue({ queued: false })
    bus.emit({ type: "session:exited", sessionId: other.id, status: "error", reason: "crashed", ts: NOW })
    await handle.flush()

    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    const [calledId, calledMessage, calledOpts] = enqueueSpy.mock.calls[0]!
    expect(calledId).toBe(chief.id)
    expect(calledMessage).toContain("[session-follow]")
    expect(calledMessage).toContain(`other-1 (${other.id}) crashed`)
    expect(calledOpts).toEqual(
      expect.objectContaining({
        queue: true,
        source: "session-follow",
        envelope: expect.objectContaining({ from: { relation: "system" }, kind: "notice", urgency: "next-turn" }),
      }),
    )
    handle.dispose()
    reg.shutdown()
  })

  it("busy follower: NOT interrupted; the digest parks in its prompt queue as a separate turn", async () => {
    const bus = createSessionEventBus()
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const store = createSessionFollowStore({ persist: false })
    const handle = wireSessionFollow({ registry: reg, sessionEvents: bus, store, parkedPath: join(tmp, "parked.jsonl"), log: () => {} })

    const chiefSession = controllableAgentSession("acp-chief")
    const chief = reg.spawnAgent({ workspaceSlug: "default", cwd: "/tmp", agentSession: chiefSession.session, adapterSlug: "claude-code" })
    const other = reg.spawnAgent({ workspaceSlug: "default", cwd: "/tmp/other", agentSession: liveAgentSession("acp-other"), adapterSlug: "claude-code" })
    store.upsert({ follower: chief.id, selector: { all: true }, batchMs: 0 })

    await reg.enqueuePrompt(chief.id, "start", {})
    expect(reg.get(chief.id)?.busy).toBe(true)

    bus.emit({ type: "session:exited", sessionId: other.id, status: "exited", ts: NOW })
    await handle.flush()

    expect(chiefSession.cancel).not.toHaveBeenCalled()
    expect(reg.get(chief.id)?.busy).toBe(true)
    expect(reg.get(chief.id)?.promptQueue).toEqual([
      expect.objectContaining({ message: expect.stringContaining("[session-follow]"), source: "session-follow" }),
    ])

    // Releasing the turn drains the queued digest as its own turn.
    chiefSession.finishTurn()
    const deadline = Date.now() + 2000
    while (chiefSession.messages.length < 2 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10))
    }
    const second = (chiefSession.messages[1] as { text: string }).text
    expect(second).toContain('from="system" kind="notice">')
    expect(second).toContain("[session-follow] automatic digest")
    chiefSession.finishTurn()
    handle.dispose()
    reg.shutdown()
  })
})
