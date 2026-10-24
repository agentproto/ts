import { createHash } from "node:crypto"
import type { RoutineFrontmatter } from "@agentproto/routine"
import {
  parseAgentHookMap,
  parseHookEventRef,
  type HookEventRef,
  type HostEventRegistration,
} from "@agentproto/lifecycle"

/** Host events this runtime emits. A namespaced event is accepted in a routine or an `on` map only when listed here. */
export const HOST_EVENT_REGISTRATIONS: readonly HostEventRegistration[] = Object.freeze([
  Object.freeze<HostEventRegistration>({
    event: "agentproto:session-completed",
    host: "agentproto",
    portability: "nonportable",
    description: "A session reached a terminal completed outcome, once per terminal transition.",
  }),
])

/** Dotted payload path to a primitive. Semantics: every entry must match, exact equality, AND of all entries. */
export type EventFilter = Readonly<Record<string, string | number | boolean | null>>

export type EventBindingSource =
  | { kind: "routine"; routineId: string }
  | { kind: "agent-on"; agentId: string; event: string; index: number }

export interface ResolvedEventBinding {
  /** routine: `routine:<routine-id>`; agent `on`: `<agent-id>/on/<canonical-event>/<index>` (PLAN decision 15). */
  bindingId: string
  /** The parsed event ref; `event.event` is the canonical name (aliases resolved). */
  event: HookEventRef
  filter?: EventFilter
  /** The AIP-41 target arm as authored (`action` | `workflow` | `tool` | `agent`), or `{ action, inputs? }` for an `on` entry. Not dispatched here. */
  target: RoutineFrontmatter["target"]
  source: EventBindingSource
  /** Stable 16 hex chars: sha256 of the key-sorted JSON of { event: event.event, filter, target }. Same input, same revision, across processes. It hashes the config content only; the binding identity is `bindingId`. */
  configRevision: string
}

export type EventBindingErrorCode = "filter-invalid" | "agent-id-invalid"

export class EventBindingError extends Error {
  readonly code: EventBindingErrorCode

  constructor(code: EventBindingErrorCode, message: string) {
    super(message)
    this.name = "EventBindingError"
    this.code = code
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(entry => (entry === undefined ? "null" : stableStringify(entry))).join(",")}]`
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    const parts: string[] = []
    for (const key of keys) {
      const entry = value[key]
      if (entry === undefined) continue
      parts.push(`${JSON.stringify(key)}:${stableStringify(entry)}`)
    }
    return `{${parts.join(",")}}`
  }
  return JSON.stringify(value)
}

function configRevisionFor(event: string, filter: EventFilter | undefined, target: RoutineFrontmatter["target"]): string {
  return createHash("sha256")
    .update(stableStringify({ event, filter, target }))
    .digest("hex")
    .slice(0, 16)
}

function parseFilter(value: unknown): EventFilter | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    throw new EventBindingError("filter-invalid", "schedule.filter must be a plain object")
  }
  const filter: Record<string, string | number | boolean | null> = {}
  for (const key of Object.keys(value)) {
    const segments = key.split(".")
    if (segments.includes("__proto__")) {
      throw new EventBindingError(
        "filter-invalid",
        `schedule.filter key ${JSON.stringify(key)} must not contain a __proto__ segment`,
      )
    }
    if (segments.length === 0 || segments.some(segment => segment.length === 0)) {
      throw new EventBindingError(
        "filter-invalid",
        `schedule.filter key ${JSON.stringify(key)} must be a non-empty dotted path with no empty segment`,
      )
    }
    const entry = value[key]
    const valid =
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    if (!valid) {
      throw new EventBindingError(
        "filter-invalid",
        `schedule.filter key ${JSON.stringify(key)} must be a string, finite number, boolean or null`,
      )
    }
    filter[key] = entry
  }
  return Object.keys(filter).length === 0 ? undefined : filter
}

/** undefined when the routine is not `schedule.kind: "event"` or is `enabled: false`. Throws HooksContractError (bad or unregistered event) or EventBindingError (bad filter). No I/O. */
export function resolveRoutineEventBinding(frontmatter: RoutineFrontmatter): ResolvedEventBinding | undefined {
  const schedule: unknown = frontmatter.schedule
  if (!isPlainObject(schedule) || schedule.kind !== "event") return undefined
  if (!frontmatter.enabled) return undefined

  const event = parseHookEventRef(schedule.on, { hostEvents: HOST_EVENT_REGISTRATIONS })
  const filter = parseFilter(schedule.filter)
  const routineId = frontmatter.id
  return {
    bindingId: `routine:${routineId}`,
    event,
    ...(filter ? { filter } : {}),
    target: frontmatter.target,
    source: { kind: "routine", routineId },
    configRevision: configRevisionFor(event.event, filter, frontmatter.target),
  }
}

function isValidAgentIdSegment(segment: string): boolean {
  if (segment.length === 0) return false
  for (let i = 0; i < segment.length; i++) {
    const ch = segment.charCodeAt(i)
    if (ch <= 0x1f || ch === 0x7f) return false
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) return false
    if (ch === 0x2f || ch === 0x5c) return false
  }
  return true
}

function validateAgentId(agentId: string): void {
  if (agentId.length === 0) {
    throw new EventBindingError("agent-id-invalid", "agent id must be a non-empty string")
  }
  const segments = agentId.split("/")
  if (segments.some(segment => !isValidAgentIdSegment(segment))) {
    throw new EventBindingError(
      "agent-id-invalid",
      "agent id must not contain empty segments, whitespace/control characters or path separators",
    )
  }
}

/** `on` is the raw AGENT.md map. [] for undefined. Throws what parseAgentHookMap throws, or EventBindingError agent-id-invalid for an empty agentId. */
export function resolveAgentOnBindings(agentId: string, on: unknown): ResolvedEventBinding[] {
  validateAgentId(agentId)
  const reactions = parseAgentHookMap(on, { hostEvents: HOST_EVENT_REGISTRATIONS })
  const nextIndexByEvent = new Map<string, number>()
  const bindings: ResolvedEventBinding[] = []
  for (const reaction of reactions) {
    const canonical = reaction.event.event
    const index = nextIndexByEvent.get(canonical) ?? 0
    nextIndexByEvent.set(canonical, index + 1)
    const target: RoutineFrontmatter["target"] =
      reaction.action.inputs === undefined
        ? { action: reaction.action.action }
        : { action: reaction.action.action, inputs: reaction.action.inputs }
    bindings.push({
      bindingId: `${agentId}/on/${canonical}/${index}`,
      event: reaction.event,
      target,
      source: { kind: "agent-on", agentId, event: canonical, index },
      configRevision: configRevisionFor(canonical, undefined, target),
    })
  }
  return bindings
}

/** Pure. undefined filter matches everything. */
export function matchEventFilter(filter: EventFilter | undefined, payload: unknown): boolean {
  if (filter === undefined) return true
  for (const [path, expected] of Object.entries(filter)) {
    let current: unknown = payload
    for (const segment of path.split(".")) {
      if (typeof current !== "object" || current === null || Array.isArray(current)) return false
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return false
      current = (current as Record<string, unknown>)[segment]
    }
    if (current !== expected) return false
  }
  return true
}
