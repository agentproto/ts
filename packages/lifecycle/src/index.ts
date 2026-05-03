/**
 * @agentproto/lifecycle — AIP-37 event-name vocabulary.
 *
 * Type: Meta. There is no `defineLifecycle` doctype — AIP-37 specifies a
 * shared vocabulary of event names that other AIPs reference (e.g.
 * `STORAGE.md.sync.commit.on: turn-end`). This package exports the
 * constants + alias resolution so consumers get type-safe event names.
 *
 * Spec: https://agentproto.sh/docs/aip-37
 */

export const SPEC_NAME = "agentlifecycle/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

/**
 * Standard lifecycle event names. Kebab-case, no colons (colons reserved
 * for host namespaces like `agentik:custom-trigger`).
 *
 * Hosts MAY fire additional events beyond this list; configs reference
 * any event name as a bare string. This array is the union of "events
 * that conformant hosts SHOULD fire when their semantic conditions hold."
 */
export const LIFECYCLE_EVENTS = [
  // Workspace lifecycle
  "workspace-open",
  "workspace-close",
  // Conversation lifecycle
  "conversation-start",
  "conversation-end",
  // Agent turn lifecycle
  "turn-start",
  "turn-end",
  "turn-error",
  // Tool / command lifecycle
  "tool-call",
  "tool-result",
  "tool-error",
  // File / write lifecycle
  "write",
  "delete",
  // Manual
  "manual",
] as const

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number]

/**
 * Templated event names — hosts substitute the placeholder before firing.
 * `idle-<N>` and `conversation-idle-<N>` accept a positive integer
 * `N` (seconds since the relevant scope went idle).
 */
export const LIFECYCLE_TEMPLATED_EVENTS = ["idle", "conversation-idle"] as const

export type LifecycleTemplatedEvent =
  (typeof LIFECYCLE_TEMPLATED_EVENTS)[number]

/**
 * Aliases — shorthand names that resolve to standard event names.
 * Hosts MUST accept aliases transparently (a config saying
 * `commit.on: per-turn` is equivalent to `commit.on: turn-end`).
 */
export const LIFECYCLE_ALIASES = {
  "each-write": "write",
  "per-turn": "turn-end",
  "per-conversation": "conversation-end",
} as const

export type LifecycleAlias = keyof typeof LIFECYCLE_ALIASES

/**
 * Resolve any event reference (alias, standard, templated, or
 * host-namespaced) to its canonical form. Aliases are rewritten;
 * everything else passes through. Returns the input unchanged when
 * no alias matches — consumers handle templated and namespaced
 * events themselves.
 */
export function resolveLifecycleEvent(name: string): string {
  return name in LIFECYCLE_ALIASES
    ? LIFECYCLE_ALIASES[name as LifecycleAlias]
    : name
}

/**
 * True if `name` is one of the standard event names listed in this
 * spec. Useful for host implementations to decide whether they
 * support firing the event.
 */
export function isStandardLifecycleEvent(
  name: string
): name is LifecycleEvent {
  return (LIFECYCLE_EVENTS as readonly string[]).includes(name)
}

/**
 * Parse a templated event name (`idle-300`, `conversation-idle-600`)
 * into its base + the integer threshold. Returns null when the name
 * isn't a templated event.
 */
export function parseTemplatedLifecycleEvent(
  name: string
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

/**
 * True if `name` is a host-namespaced (non-portable) event like
 * `agentik:scheduled-pull`. Configs using these declare an explicit
 * host dependency.
 */
export function isNamespacedLifecycleEvent(name: string): boolean {
  return name.includes(":")
}
