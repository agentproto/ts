import { describe, it, expect } from "vitest"
import {
  LIFECYCLE_EVENTS,
  LIFECYCLE_ALIASES,
  LIFECYCLE_TEMPLATED_EVENTS,
  resolveLifecycleEvent,
  isStandardLifecycleEvent,
  parseTemplatedLifecycleEvent,
  isNamespacedLifecycleEvent,
} from "../index.js"

describe("@agentproto/lifecycle (AIP-37)", () => {
  it("exports the standard event vocabulary", () => {
    expect(LIFECYCLE_EVENTS).toContain("workspace-open")
    expect(LIFECYCLE_EVENTS).toContain("turn-end")
    expect(LIFECYCLE_EVENTS).toContain("conversation-end")
    expect(LIFECYCLE_EVENTS).toContain("write")
    expect(LIFECYCLE_EVENTS).toContain("manual")
  })

  it("lists the templated event bases", () => {
    expect(LIFECYCLE_TEMPLATED_EVENTS).toContain("idle")
    expect(LIFECYCLE_TEMPLATED_EVENTS).toContain("conversation-idle")
  })

  it("resolves aliases to their canonical event", () => {
    expect(resolveLifecycleEvent("per-turn")).toBe("turn-end")
    expect(resolveLifecycleEvent("each-write")).toBe("write")
    expect(resolveLifecycleEvent("per-conversation")).toBe("conversation-end")
  })

  it("passes through non-alias names unchanged", () => {
    expect(resolveLifecycleEvent("turn-end")).toBe("turn-end")
    expect(resolveLifecycleEvent("idle-300")).toBe("idle-300")
    expect(resolveLifecycleEvent("agentik:scheduled-pull")).toBe(
      "agentik:scheduled-pull",
    )
  })

  it("recognises standard event names", () => {
    expect(isStandardLifecycleEvent("turn-end")).toBe(true)
    expect(isStandardLifecycleEvent("write")).toBe(true)
    expect(isStandardLifecycleEvent("idle-300")).toBe(false)
    expect(isStandardLifecycleEvent("custom-event")).toBe(false)
  })

  it("parses templated event names", () => {
    expect(parseTemplatedLifecycleEvent("idle-300")).toEqual({
      base: "idle",
      thresholdSeconds: 300,
    })
    expect(parseTemplatedLifecycleEvent("conversation-idle-600")).toEqual({
      base: "conversation-idle",
      thresholdSeconds: 600,
    })
    expect(parseTemplatedLifecycleEvent("idle-bad")).toBeNull()
    expect(parseTemplatedLifecycleEvent("idle-0")).toBeNull()
    expect(parseTemplatedLifecycleEvent("turn-end")).toBeNull()
  })

  it("detects namespaced (host-specific) event names", () => {
    expect(isNamespacedLifecycleEvent("agentik:scheduled-pull")).toBe(true)
    expect(isNamespacedLifecycleEvent("turn-end")).toBe(false)
  })

  it("alias values point at standard events", () => {
    for (const target of Object.values(LIFECYCLE_ALIASES)) {
      expect(LIFECYCLE_EVENTS).toContain(target)
    }
  })
})
