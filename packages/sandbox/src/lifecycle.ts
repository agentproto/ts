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
   *  Kill is the default: absent any explicit lifecycle declaration (or a
   *  reconnect target), the box is destroyed on close rather than left
   *  paused-and-billed. Pause is an explicit opt-in — see
   *  `resolveLifecyclePolicy`'s doc. */
  teardown: "kill" | "pause"
  /** Idle window in milliseconds, parsed from the AIP-37 `idle-<seconds>`
   *  event name. Undefined when the spec doesn't declare
   *  `lifecycle.pause_after_idle`. */
  pauseAfterIdleMs?: number
}

const IDLE_EVENT_PATTERN = /^idle-(\d+)$/

/**
 * Kill is the default teardown: absent `destroy_on`, `pause_after_idle`,
 * AND `reuse`, a closed box is destroyed rather than left paused (and
 * billed) with nothing pointed at it — a fleet of daemons defaulting to
 * "leave it running" is exactly how a provider account accumulates
 * dozens of forgotten paused boxes (see the 2026-09 sandbox-ledger
 * reconcile finding). Pause is the explicit opt-in: `pause_after_idle`
 * declares the box should idle out on its own schedule rather than die
 * immediately, and `reuse` means THIS boot is itself a reconnect to an
 * existing box — killing it on close would undo the very reason it was
 * reused. `destroy_on` stays authoritative over both (the spec states
 * outright the box must not survive session close).
 */
export function resolveLifecyclePolicy(spec: SandboxHandle, reuse: boolean): SandboxLifecyclePolicy {
  if (spec.lifecycle?.destroy_on) return { teardown: "kill" }

  const pauseAfterIdleMs = parseIdleAfterMs(spec.lifecycle?.pause_after_idle)
  const teardown: "kill" | "pause" = pauseAfterIdleMs !== undefined || reuse ? "pause" : "kill"
  return { teardown, ...(pauseAfterIdleMs !== undefined ? { pauseAfterIdleMs } : {}) }
}

function parseIdleAfterMs(event: string | undefined): number | undefined {
  if (!event) return undefined
  const match = IDLE_EVENT_PATTERN.exec(event)
  if (!match) return undefined
  return Number(match[1]) * 1000
}
