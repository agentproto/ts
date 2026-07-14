import { describe, expect, it } from "vitest"

import {
  applyLifecycleEvent,
  applyPermissionsSnapshot,
  applySessionsSnapshot,
  createStoreState,
  snapshot,
} from "./sessionStore.logic.js"
import type { SessionDescriptor } from "../client/types.js"

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "cmd",
    pid: 1,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

describe("applySessionsSnapshot", () => {
  it("inserts new sessions and reports changed=true", () => {
    const state = createStoreState()
    const changed = applySessionsSnapshot(state, [session()])
    expect(changed).toBe(true)
    expect(state.sessions.size).toBe(1)
  })

  it("reports changed=false on an identical snapshot", () => {
    const state = createStoreState()
    applySessionsSnapshot(state, [session()])
    const changed = applySessionsSnapshot(state, [session()])
    expect(changed).toBe(false)
  })

  it("reports changed=true when a field differs", () => {
    const state = createStoreState()
    applySessionsSnapshot(state, [session({ status: "running" })])
    const changed = applySessionsSnapshot(state, [session({ status: "exited", endedAt: "t2" })])
    expect(changed).toBe(true)
    expect(state.sessions.get("s1")?.status).toBe("exited")
  })

  it("drops sessions no longer present in the snapshot", () => {
    const state = createStoreState()
    applySessionsSnapshot(state, [session({ id: "a" }), session({ id: "b" })])
    const changed = applySessionsSnapshot(state, [session({ id: "a" })])
    expect(changed).toBe(true)
    expect(state.sessions.has("b")).toBe(false)
    expect(state.sessions.size).toBe(1)
  })

  it("skips entries without an id", () => {
    const state = createStoreState()
    const changed = applySessionsSnapshot(state, [{ ...session(), id: "" } as SessionDescriptor])
    expect(changed).toBe(false)
    expect(state.sessions.size).toBe(0)
  })
})

describe("applyPermissionsSnapshot", () => {
  it("inserts new permissions and dedupes on id", () => {
    const state = createStoreState()
    const changed = applyPermissionsSnapshot(state, [
      { id: "p1", sessionId: "s1", toolCallId: "p1", text: "Allow X?", options: [], requestedAt: "t" },
    ])
    expect(changed).toBe(true)
    expect(state.permissions.size).toBe(1)
  })

  it("drops resolved permissions absent from the next snapshot", () => {
    const state = createStoreState()
    applyPermissionsSnapshot(state, [
      { id: "p1", sessionId: "s1", toolCallId: "p1", text: "Allow X?", options: [], requestedAt: "t" },
    ])
    const changed = applyPermissionsSnapshot(state, [])
    expect(changed).toBe(true)
    expect(state.permissions.size).toBe(0)
  })
})

describe("applyLifecycleEvent", () => {
  it("session:turn-end clears busy + awaitingInput", () => {
    const state = createStoreState()
    applySessionsSnapshot(state, [session({ id: "s1", busy: true, awaitingInput: true })])
    const changed = applyLifecycleEvent(state, { type: "session:turn-end", sessionId: "s1", ts: "t" })
    expect(changed).toBe(true)
    expect(state.sessions.get("s1")?.busy).toBe(false)
    expect(state.sessions.get("s1")?.awaitingInput).toBe(false)
  })

  it("session:awaiting-input sets awaitingInput=true", () => {
    const state = createStoreState()
    applySessionsSnapshot(state, [session({ id: "s1", awaitingInput: false, busy: true })])
    const changed = applyLifecycleEvent(state, { type: "session:awaiting-input", sessionId: "s1", ts: "t" })
    expect(changed).toBe(true)
    expect(state.sessions.get("s1")?.awaitingInput).toBe(true)
    expect(state.sessions.get("s1")?.busy).toBe(false)
  })

  it("session:exited flips status + sets endedAt + processAlive=false", () => {
    const state = createStoreState()
    applySessionsSnapshot(state, [session({ id: "s1", status: "running", processAlive: true })])
    const changed = applyLifecycleEvent(state, {
      type: "session:exited",
      sessionId: "s1",
      status: "exited",
      exitCode: 0,
      ts: "2026-01-02T00:00:00Z",
    })
    expect(changed).toBe(true)
    const s = state.sessions.get("s1")!
    expect(s.status).toBe("exited")
    expect(s.endedAt).toBe("2026-01-02T00:00:00Z")
    expect(s.processAlive).toBe(false)
    expect(s.exitCode).toBe(0)
  })

  it("session:exited preserves a killed/error status from the event", () => {
    const state = createStoreState()
    applySessionsSnapshot(state, [session({ id: "s1", status: "running" })])
    applyLifecycleEvent(state, { type: "session:exited", sessionId: "s1", status: "killed", ts: "t" })
    expect(state.sessions.get("s1")?.status).toBe("killed")
  })

  it("session:permission-request inserts a placeholder permission", () => {
    const state = createStoreState()
    const changed = applyLifecycleEvent(state, {
      type: "session:permission-request",
      sessionId: "s1",
      permissionId: "p9",
      toolName: "Bash",
      text: "Allow bash?",
      ts: "t",
    })
    expect(changed).toBe(true)
    expect(state.permissions.get("p9")?.text).toBe("Allow bash?")
    expect(state.permissions.get("p9")?.sessionId).toBe("s1")
  })

  it("session:permission-resolved removes the permission", () => {
    const state = createStoreState()
    applyLifecycleEvent(state, {
      type: "session:permission-request",
      sessionId: "s1",
      permissionId: "p9",
      text: "x",
      ts: "t",
    })
    expect(state.permissions.has("p9")).toBe(true)
    const changed = applyLifecycleEvent(state, {
      type: "session:permission-resolved",
      sessionId: "s1",
      permissionId: "p9",
      decision: "approve",
      ts: "t",
    })
    expect(changed).toBe(true)
    expect(state.permissions.has("p9")).toBe(false)
  })

  it("unknown event types (policy:*, cron:*) are ignored without a change", () => {
    const state = createStoreState()
    const changed = applyLifecycleEvent(state, { type: "policy:passed", policyId: "pol1", sessionId: "s1", ts: "t" })
    expect(changed).toBe(false)
  })

  it("returns false for an event whose session isn't tracked", () => {
    const state = createStoreState()
    const changed = applyLifecycleEvent(state, { type: "session:turn-end", sessionId: "ghost", ts: "t" })
    expect(changed).toBe(false)
  })
})

describe("snapshot", () => {
  it("returns sessions + permissions as arrays in insertion order", () => {
    const state = createStoreState()
    applySessionsSnapshot(state, [session({ id: "a" }), session({ id: "b" })])
    applyPermissionsSnapshot(state, [
      { id: "p1", sessionId: "a", toolCallId: "p1", text: "x", options: [], requestedAt: "t" },
      { id: "p2", sessionId: "b", toolCallId: "p2", text: "y", options: [], requestedAt: "t" },
    ])
    const snap = snapshot(state)
    expect(snap.sessions.map(s => s.id)).toEqual(["a", "b"])
    expect(snap.permissions.map(p => p.id)).toEqual(["p1", "p2"])
  })
})
