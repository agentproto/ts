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
  /** What session close should do to the box: kill it (ephemeral, the
   *  default) or pause it (keeps it reconnectable via `SandboxProvider.
   *  connect`). */
  teardown: "kill" | "pause"
  /** Idle window in milliseconds, parsed from the AIP-37 `idle-<seconds>`
   *  event name. Undefined when the spec doesn't declare
   *  `lifecycle.pause_after_idle`. */
  pauseAfterIdleMs?: number
}

const IDLE_EVENT_PATTERN = /^idle-(\d+)$/

/**
 * `reuse` is true when this spawn asked to reconnect to an existing
 * sandbox id (`agent_start.sandbox.reuse`) — such a box defaults to
 * "pause" on close even absent an explicit `lifecycle` block, since
 * killing it would defeat the point of having reconnected. An explicit
 * `destroy_on` always wins over both `reuse` and `pause_after_idle`: the
 * spec is stating outright that this box must not survive session close.
 */
export function resolveLifecyclePolicy(spec: SandboxHandle, reuse: boolean): SandboxLifecyclePolicy {
  if (spec.lifecycle?.destroy_on) return { teardown: "kill" }

  const pauseAfterIdleMs = parseIdleAfterMs(spec.lifecycle?.pause_after_idle)
  const teardown: "kill" | "pause" = reuse || pauseAfterIdleMs !== undefined ? "pause" : "kill"
  return { teardown, ...(pauseAfterIdleMs !== undefined ? { pauseAfterIdleMs } : {}) }
}

function parseIdleAfterMs(event: string | undefined): number | undefined {
  if (!event) return undefined
  const match = IDLE_EVENT_PATTERN.exec(event)
  if (!match) return undefined
  return Number(match[1]) * 1000
}
