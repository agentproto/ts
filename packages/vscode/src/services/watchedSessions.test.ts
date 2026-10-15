import { describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import { WatchedSessions } from "./watchedSessions.js"
import type { SessionStore } from "./sessionStore.js"
import type { SessionDescriptor } from "../client/types.js"

/** In-memory Memento that records every write — the write-gate assertions. */
function mementoHarness(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial))
  const writes: Array<{ key: string; value: unknown }> = []
  const harness = {
    writes,
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      writes.push({ key, value })
      store.set(key, value)
      return Promise.resolve()
    },
    keys: () => [] as readonly string[],
  }
  return harness as unknown as vscode.Memento & { writes: typeof writes }
}

function session(id: string, over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id,
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude-code --print",
    pid: 123,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

/** Minimal stand-in for SessionStore: the service only reads `.sessions` and
 *  subscribes via `onDidChange`. Mutate `rows` to advance the store, then
 *  `fire()` to simulate the next poll. */
function fakeStore(initial: SessionDescriptor[]) {
  const rows = [...initial]
  let listener: (() => void) | undefined
  const fake = {
    get sessions() {
      return rows
    },
    onDidChange: (cb: () => void) => {
      listener = cb
      return {
        dispose: () => {
          listener = undefined
        },
      }
    },
    fire: () => listener?.(),
    setSessions: (...next: SessionDescriptor[]) => {
      rows.splice(0, rows.length, ...next)
    },
  }
  return { fake: fake as unknown as SessionStore, ...fake }
}

const ACTIVITY_KEY = "agentproto.watched.activity.v1"
const activityWrites = (writes: { key: string; value: unknown }[]) =>
  writes.filter(w => w.key === ACTIVITY_KEY)

describe("WatchedSessions — store wiring", () => {
  const warningSpy = vi
    .spyOn(vscode.window, "showWarningMessage")
    .mockResolvedValue(undefined)
  const infoSpy = vi
    .spyOn(vscode.window, "showInformationMessage")
    .mockResolvedValue(undefined)

  it("toasts an unwatched session entering needs-you on the first poll", () => {
    warningSpy.mockClear()
    const svc = new WatchedSessions(mementoHarness())
    const store = fakeStore([session("s1", { awaitingInput: true })])
    svc.attach(store.fake)

    store.fire()

    expect(warningSpy).toHaveBeenCalledTimes(1)
    expect(warningSpy.mock.calls[0]?.[0]).toContain("needs-you")
    svc.dispose()
  })

  it("persists the baseline once, then skips writes while nothing changes", () => {
    warningSpy.mockClear()
    const memento = mementoHarness()
    const svc = new WatchedSessions(memento)
    const store = fakeStore([session("s1")])
    svc.attach(store.fake)

    store.fire() // first sighting: {} → { s1: working } — a real change
    const afterFirstPoll = activityWrites(memento.writes).length
    store.fire() // same state — must not write
    store.fire()
    const afterNoopPolls = activityWrites(memento.writes).length

    expect(afterFirstPoll).toBe(1)
    expect(afterNoopPolls).toBe(afterFirstPoll)
    expect(warningSpy).not.toHaveBeenCalled()
    svc.dispose()
  })

  it("writes again exactly when an activity actually changes", () => {
    warningSpy.mockClear()
    const memento = mementoHarness()
    const svc = new WatchedSessions(memento)
    const store = fakeStore([session("s1")])
    svc.attach(store.fake)

    store.fire() // establish { s1: working }
    store.setSessions(session("s1", { awaitingInput: true }))
    store.fire() // working → needs-you

    expect(activityWrites(memento.writes).length).toBe(2)
    expect(warningSpy).toHaveBeenCalledTimes(1)
    svc.dispose()
  })

  it("prunes vanished sessions from the persisted baseline", () => {
    const memento = mementoHarness()
    const svc = new WatchedSessions(memento)
    const store = fakeStore([session("s1"), session("s2")])
    svc.attach(store.fake)

    store.fire() // both present
    store.setSessions(session("s1"))
    store.fire() // s2 left the store

    const last = activityWrites(memento.writes).at(-1)?.value as Record<string, unknown>
    expect(Object.keys(last)).toEqual(["s1"])
    const internal = svc as unknown as { lastActivity: Map<string, unknown> }
    expect(internal.lastActivity.size).toBe(1)
    svc.dispose()
  })

  it("keeps the full watched tier — stalled warning and done info still fire", () => {
    warningSpy.mockClear()
    infoSpy.mockClear()
    const svc = new WatchedSessions(mementoHarness())
    const store = fakeStore([])
    svc.attach(store.fake)
    svc.toggle("w1") // pin the eye before the session shows up

    store.setSessions(session("w1", { lastTurnErroredAt: "2026-01-01T00:05:00Z" }))
    store.fire() // first sighting of the watched stalled session → warning
    expect(warningSpy).toHaveBeenCalledTimes(1)
    expect(warningSpy.mock.calls[0]?.[0]).toContain("stalled")

    store.setSessions(session("w1", { status: "exited" }))
    store.fire() // stalled → done: info is watched-tier only
    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(infoSpy.mock.calls[0]?.[0]).toContain("done")
    svc.dispose()
  })
})
