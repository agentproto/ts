/**
 * Kill is the DEFAULT teardown. A closed box with no lifecycle declaration
 * and no `reuse` is destroyed, not left paused (and billed) with nothing
 * pointed at it. Pause is an explicit opt-in: `lifecycle.pause_after_idle`
 * declares an idle-out schedule, and `reuse` means this boot is itself a
 * reconnect to an existing box. `destroy_on` stays authoritative over both.
 */

import { describe, it, expect } from "vitest"
import { resolveLifecyclePolicy } from "../lifecycle.js"
import type { SandboxHandle } from "../types.js"

function handle(lifecycle?: SandboxHandle["lifecycle"]): SandboxHandle {
  return { provider: "e2b", config: {}, lifecycle } as unknown as SandboxHandle
}

describe("resolveLifecyclePolicy — kill is the default teardown", () => {
  it("a plain spawn (no lifecycle, no reuse) KILLS on close", () => {
    expect(resolveLifecyclePolicy(handle(), false)).toEqual({ teardown: "kill" })
  })

  it("reuse (reconnecting to an existing box) PAUSES on close, even with no lifecycle declared", () => {
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

  it("a malformed pause_after_idle event is ignored (falls back to the kill default, no window)", () => {
    expect(resolveLifecyclePolicy(handle({ pause_after_idle: "bogus" }), false)).toEqual({
      teardown: "kill",
    })
  })

  it("a malformed pause_after_idle event still pauses when reuse is set (reuse alone opts in)", () => {
    expect(resolveLifecyclePolicy(handle({ pause_after_idle: "bogus" }), true)).toEqual({
      teardown: "pause",
    })
  })
})
