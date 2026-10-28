/**
 * Derived interception level per harness: whether the daemon can block an
 * action before it runs or can only observe it. Pure, computed from what a
 * session already knows (arm, `permissionHold`, declared native hooks); there
 * is no manifest field behind it and nothing here installs anything.
 */

import type { HookCapabilityView } from "@agentproto/provider-kit"
import type { SessionArm } from "../session-capabilities.js"
import type { ActionInterception } from "./types.js"

/**
 * Public vocabulary. `intercept` is part of the type but is never produced
 * yet: no tool proxy exists that would let the daemon sit in front of a
 * harness's own tool calls.
 */
export type InterceptionLevel = "intercept" | "permission-gate" | "observe" | "unavailable"

export interface InterceptionInput {
  arm: SessionArm
  permissionHold: boolean
  hooks?: readonly Pick<HookCapabilityView, "event" | "can_block">[]
}

export interface DerivedInterception {
  /** What the model runs inside the harness (its own tool and command calls). */
  nativeToolCalls: InterceptionLevel
  /** Per portable AIP-37 event named by a declared native hook. An event that is not listed is `unavailable`. */
  nativeHooks: Record<string, InterceptionLevel>
}

function nativeToolCallsFor(arm: SessionArm, permissionHold: boolean): InterceptionLevel {
  switch (arm) {
    // With the hold the permission request is parked for the daemon; without
    // it the request is seen but auto-answered, so nothing can be blocked.
    case "acp":
      return permissionHold ? "permission-gate" : "observe"
    case "print":
      return "observe"
    default:
      return "unavailable"
  }
}

export function deriveInterception(input: InterceptionInput): DerivedInterception {
  const nativeHooks: Record<string, InterceptionLevel> = Object.create(null) as Record<string, InterceptionLevel>
  // An entry with `can_block: true` AND `async: true` declares that the harness
  // CAN block, but a host binding must be projected in the synchronous form to
  // actually block (docs/design/action-hooks-capability-matrix.md). This
  // reports the declared capability; it does not install anything.
  for (const entry of input.hooks ?? []) {
    const level: InterceptionLevel = entry.can_block === true ? "permission-gate" : "observe"
    if (nativeHooks[entry.event] !== "permission-gate") nativeHooks[entry.event] = level
  }
  return {
    nativeToolCalls: nativeToolCallsFor(input.arm, input.permissionHold),
    nativeHooks: { ...nativeHooks },
  }
}

export function interceptionFor(d: DerivedInterception, event: string): InterceptionLevel {
  return Object.prototype.hasOwnProperty.call(d.nativeHooks, event) ? d.nativeHooks[event]! : "unavailable"
}

export function toActionInterception(level: InterceptionLevel): ActionInterception {
  switch (level) {
    case "intercept":
      return "full"
    case "permission-gate":
      return "permission-only"
    case "observe":
      return "observe-only"
    case "unavailable":
      return "unavailable"
  }
}
