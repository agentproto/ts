/**
 * PLAN-D2 — pause is the DEFAULT teardown. A closed box with no lifecycle
 * declaration at all is paused (still reattachable via `reuse` /
 * `agentproto sandbox attach`), not killed. Explicit declarations remain
 * authoritative: `destroy_on` always kills; `pause_after_idle` pauses (with
 * its idle window parsed) and now merely agrees with the default.
 */

import { describe, it, expect } from "vitest"
import { resolveLifecyclePolicy } from "../lifecycle.js"
import type { SandboxHandle } from "../types.js"

function handle(lifecycle?: SandboxHandle["lifecycle"]): SandboxHandle {
  return { provider: "e2b", config: {}, lifecycle } as unknown as SandboxHandle
}

describe("resolveLifecyclePolicy — pause is the default teardown", () => {
  it("a plain spawn (no lifecycle, no reuse) PAUSES on close", () => {
    expect(resolveLifecyclePolicy(handle(), false)).toEqual({ teardown: "pause" })
    expect(resolveLifecyclePolicy(handle(), true)).toEqual({ teardown: "pause" })
  })

  it("lifecycle.destroy_on always KILLS — even over reuse or pause_after_idle", () => {
    expect(resolveLifecyclePolicy(handle({ destroy_on: "workspace-close" }), false)).toEqual({
      teardown: "kill",
    })
    expect(resolveLifecyclePolicy(handle({ destroy_on: "workspace-close" }), true)).toEqual({
      teardown: "kill",
    })
    expect(
      resolveLifecyclePolicy(handle({ destroy_on: "workspace-close", pause_after_idle: "idle-600" }), true),
    ).toEqual({ teardown: "kill" })
  })

  it("lifecycle.pause_after_idle pauses and parses the idle window", () => {
    expect(resolveLifecyclePolicy(handle({ pause_after_idle: "idle-600" }), false)).toEqual({
      teardown: "pause",
      pauseAfterIdleMs: 600_000,
    })
  })

  it("a malformed pause_after_idle event is ignored (still the pause default, no window)", () => {
    expect(resolveLifecyclePolicy(handle({ pause_after_idle: "bogus" }), false)).toEqual({
      teardown: "pause",
    })
  })
})
