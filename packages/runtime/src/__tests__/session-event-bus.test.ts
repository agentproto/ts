import { describe, it, expect, vi } from "vitest"
import { createSessionEventBus } from "../session-event-bus.js"

describe("SessionEventBus", () => {
  it("on() receives only the subscribed type", () => {
    const bus = createSessionEventBus()
    const handler = vi.fn()
    bus.on("session:turn-end", handler)

    bus.emit({ type: "session:turn-end", sessionId: "s1", awaitingInput: false, ts: "t" })
    bus.emit({ type: "session:exited", sessionId: "s1", status: "exited", ts: "t" })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:turn-end", sessionId: "s1" }),
    )
  })

  it("onAny() receives all types", () => {
    const bus = createSessionEventBus()
    const handler = vi.fn()
    bus.onAny(handler)

    bus.emit({ type: "session:turn-end", sessionId: "s1", awaitingInput: false, ts: "t" })
    bus.emit({ type: "session:awaiting-input", sessionId: "s2", ts: "t" })
    bus.emit({ type: "session:exited", sessionId: "s3", status: "exited", ts: "t" })

    expect(handler).toHaveBeenCalledTimes(3)
  })

  it("delivers the permission-request / -resolved events by type", () => {
    const bus = createSessionEventBus()
    const onRequest = vi.fn()
    const onResolved = vi.fn()
    bus.on("session:permission-request", onRequest)
    bus.on("session:permission-resolved", onResolved)

    bus.emit({
      type: "session:permission-request",
      sessionId: "s1",
      permissionId: "perm-1",
      toolName: "Write",
      text: 'Allow "Write"?',
      ts: "t",
    })
    bus.emit({
      type: "session:permission-resolved",
      sessionId: "s1",
      permissionId: "perm-1",
      decision: "approve",
      optionId: "opt-once",
      ts: "t",
    })
    // A sibling type must not leak into either handler.
    bus.emit({ type: "session:turn-end", sessionId: "s1", awaitingInput: false, ts: "t" })

    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:permission-request", permissionId: "perm-1" }),
    )
    expect(onResolved).toHaveBeenCalledTimes(1)
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approve", optionId: "opt-once" }),
    )
  })

  it("unsubscribe stops receiving events", () => {
    const bus = createSessionEventBus()
    const handler = vi.fn()
    const unsub = bus.on("session:turn-end", handler)

    bus.emit({ type: "session:turn-end", sessionId: "s1", awaitingInput: false, ts: "t" })
    unsub()
    bus.emit({ type: "session:turn-end", sessionId: "s1", awaitingInput: false, ts: "t" })

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("carries a config-changed event for any single SessionConfig axis", () => {
    const bus = createSessionEventBus()
    const onConfig = vi.fn()
    bus.on("session:config-changed", onConfig)

    // The axis-generic event (SPEC step 4) must carry each orthogonal axis
    // with its own value shape — the model axis a string, effort an
    // EffortLevel, route a RouteSpec, posture a Posture — so live-effort/
    // posture (step 5) and restart-override (step 6) can all reuse it.
    bus.emit({ type: "session:config-changed", sessionId: "s1", axis: "model", value: "claude-opus-4-8", ts: "t" })
    bus.emit({ type: "session:config-changed", sessionId: "s1", axis: "effort", value: "ultracode", ts: "t" })
    bus.emit({
      type: "session:config-changed",
      sessionId: "s1",
      axis: "route",
      value: { gateway: "moonshot" },
      ts: "t",
    })
    bus.emit({ type: "session:config-changed", sessionId: "s1", axis: "posture", value: "plan", ts: "t" })
    // A sibling type must not leak into the config-changed handler.
    bus.emit({ type: "session:turn-end", sessionId: "s1", awaitingInput: false, ts: "t" })

    expect(onConfig).toHaveBeenCalledTimes(4)
    expect(onConfig).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ axis: "model", value: "claude-opus-4-8" }),
    )
    expect(onConfig).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ axis: "route", value: { gateway: "moonshot" } }),
    )
  })

  it("multiple subscribers on same type all fire", () => {
    const bus = createSessionEventBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    bus.on("session:exited", h1)
    bus.on("session:exited", h2)

    bus.emit({ type: "session:exited", sessionId: "s1", status: "exited", ts: "t" })

    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)
  })
})
