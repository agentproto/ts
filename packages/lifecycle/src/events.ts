/** AIP-37 lifecycle event vocabulary and helpers. */

export const SPEC_NAME = "agentlifecycle/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export const LIFECYCLE_EVENTS = [
  "workspace-open",
  "workspace-close",
  "conversation-start",
  "conversation-end",
  "turn-start",
  "turn-end",
  "turn-error",
  "tool-call",
  "tool-result",
  "tool-error",
  "write",
  "delete",
  "manual",
] as const

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number]

export const LIFECYCLE_TEMPLATED_EVENTS = ["idle", "conversation-idle"] as const

export type LifecycleTemplatedEvent =
  (typeof LIFECYCLE_TEMPLATED_EVENTS)[number]

export const LIFECYCLE_ALIASES = {
  "each-write": "write",
  "per-turn": "turn-end",
  "per-conversation": "conversation-end",
} as const

export type LifecycleAlias = keyof typeof LIFECYCLE_ALIASES

export function resolveLifecycleEvent(name: string): string {
  return name in LIFECYCLE_ALIASES
    ? LIFECYCLE_ALIASES[name as LifecycleAlias]
    : name
}

export function isStandardLifecycleEvent(
  name: string,
): name is LifecycleEvent {
  return (LIFECYCLE_EVENTS as readonly string[]).includes(name)
}

export function parseTemplatedLifecycleEvent(
  name: string,
): { base: LifecycleTemplatedEvent; thresholdSeconds: number } | null {
  for (const base of LIFECYCLE_TEMPLATED_EVENTS) {
    if (name.startsWith(`${base}-`)) {
      const tail = name.slice(base.length + 1)
      const n = Number(tail)
      if (Number.isInteger(n) && n > 0) {
        return { base, thresholdSeconds: n }
      }
    }
  }
  return null
}

export function isNamespacedLifecycleEvent(name: string): boolean {
  return name.includes(":")
}
