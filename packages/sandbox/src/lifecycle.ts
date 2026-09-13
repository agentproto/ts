/**
 * AIP-36 `lifecycle` policy resolution — maps a `SandboxHandle`'s
 * `lifecycle.pause_after_idle` / `lifecycle.destroy_on` (plus whether this
 * boot is a request to reconnect to an existing box) to a concrete
 * teardown decision. Pure and host-agnostic: the actual pause-vs-kill call
 * happens in `@agentproto/runtime`'s sandbox proxy, which just reads this
 * policy back off.
 */

import type { SandboxHandle } from "./types.js"

export interface SandboxLifecyclePolicy {
  /** What session close should do to the box: pause it (keeps it
   *  reconnectable via `SandboxProvider.connect`) or kill it (ephemeral).
   *  Pause is the default: absent any explicit lifecycle declaration the
   *  box is paused on close, and dies at its own `timeoutMs` anyway. */
  teardown: "kill" | "pause"
  /** Idle window in milliseconds, parsed from the AIP-37 `idle-<seconds>`
   *  event name. Undefined when the spec doesn't declare
   *  `lifecycle.pause_after_idle`. */
  pauseAfterIdleMs?: number
}

const IDLE_EVENT_PATTERN = /^idle-(\d+)$/

/**
 * Pause is the default teardown: absent `destroy_on`, `pause_after_idle`
 * AND `reuse`, a closed box is paused (`SandboxProvider.connect`-able)
 * rather than killed — it still dies at its own `timeoutMs`, so pausing
 * never accumulates boxes indefinitely. The explicit declarations stay
 * authoritative: an `destroy_on` always kills (the spec states outright
 * the box must not survive session close), and `pause_after_idle` /
 * `reuse` pause (which the default now agrees with).
 */
export function resolveLifecyclePolicy(spec: SandboxHandle, reuse: boolean): SandboxLifecyclePolicy {
  if (spec.lifecycle?.destroy_on) return { teardown: "kill" }

  const pauseAfterIdleMs = parseIdleAfterMs(spec.lifecycle?.pause_after_idle)
  const teardown: "kill" | "pause" = "pause"
  return { teardown, ...(pauseAfterIdleMs !== undefined ? { pauseAfterIdleMs } : {}) }
}

function parseIdleAfterMs(event: string | undefined): number | undefined {
  if (!event) return undefined
  const match = IDLE_EVENT_PATTERN.exec(event)
  if (!match) return undefined
  return Number(match[1]) * 1000
}
