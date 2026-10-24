/**
 * action-hooks/v1 contract - frozen vocabulary joining AIP-37 lifecycle events to
 * AIP-39 action refs. This module is intentionally contract-only: it parses
 * and validates declarations, but does not dispatch actions, emit events, or
 * persist receipts.
 *
 * The contract has exactly three paths:
 *
 *   - admission: a policy runs BEFORE a daemon-owned action is invoked.
 *   - lifecycle: an event is emitted after a state transition, non-blocking.
 *   - reaction:  an event is bound to an action, with an explicit delivery
 *                and reconciliation posture.
 *
 * There is no universal callback and no second prompt queue. See
 * `docs/design/action-hooks-v1.md` for the compatibility inventory.
 *
 * Spec: https://agentproto.sh/docs/aip-37
 *       https://agentproto.sh/docs/aip-39
 *       https://agentproto.sh/docs/aip-41
 *       https://agentproto.sh/docs/aip-42
 */

import {
  isNamespacedLifecycleEvent,
  isStandardLifecycleEvent,
  parseTemplatedLifecycleEvent,
  resolveLifecycleEvent,
} from "./events.js"

export const HOOKS_CONTRACT = "action-hooks/v1" as const

export const HOOK_PATHS = ["admission", "lifecycle", "reaction"] as const
export type HookPath = (typeof HOOK_PATHS)[number]

/**
 * Capability discovery for hooks is additive on the existing surfaces. There
 * is deliberately no `hooks_capabilities` tool: harness-level support belongs
 * in `harness_capabilities`, session-level support in
 * `session_capabilities`.
 */
export const HOOK_CAPABILITY_SURFACES = [
  "harness_capabilities",
  "session_capabilities",
] as const
export type HookCapabilitySurface = (typeof HOOK_CAPABILITY_SURFACES)[number]

export type HookEventKind = "standard" | "alias" | "templated" | "custom" | "host"

export interface HookEventRef {
  /** The literal key from the declaration. */
  raw: string
  /** Canonical event name. Aliases are resolved; everything else is unchanged. */
  event: string
  kind: HookEventKind
  /** False for host events, which are explicitly nonportable. */
  portable: boolean
  /** Namespace prefix for a host event (the part before the first colon). */
  host?: string
  /** Present when `kind` is `"templated"`. */
  thresholdSeconds?: number
}

export interface HookActionRef {
  /** AIP-39 action id. Resource-qualified ids are preferred. */
  action: string
  inputs?: Record<string, unknown>
}

export interface HostEventRegistration {
  /** Host-specific event name, e.g. `agentproto:child-housekeeping`. */
  event: string
  /** Namespace prefix. Must match the prefix in `event`. */
  host: string
  /** Always nonportable: other hosts do not have to understand this event. */
  portability: "nonportable"
  description?: string
}

export interface ParsedHookOptions {
  /** Explicitly registered host events. Portable AIP-37 events do not need this. */
  hostEvents?: readonly HostEventRegistration[]
}

interface AgentHookObjectRef {
  action?: unknown
  ref?: unknown
  inputs?: unknown
}

export interface HookReaction {
  path: "reaction"
  event: HookEventRef
  action: HookActionRef
  /**
   * `best-effort` means the in-memory event bus may drop the reaction on
   * restart. `durable` is only valid when the host keeps a receipt store.
   */
  delivery: "best-effort" | "durable"
  /**
   * `safe` is only valid when the target action is replay-safe. `none` is the
   * only honest default for today's in-memory bus.
   */
  reconciliation: "none" | "safe"
}

export const HOOKS_ERROR_CODES = [
  "action-ref-invalid",
  "action-ref-type",
  "action-ref-ambiguous",
  "action-ref-missing",
  "action-ref-inputs-invalid",
  "event-ref-invalid",
  "event-ref-host-unregistered",
  "host-event-registration-invalid",
  "host-event-registration-mismatch",
  "agent-hook-map-invalid",
  "agent-hook-entry-empty",
] as const

export type HooksErrorCode = (typeof HOOKS_ERROR_CODES)[number]

export class HooksContractError extends Error {
  readonly code: HooksErrorCode

  constructor(code: HooksErrorCode, message: string) {
    super(message)
    this.name = "HooksContractError"
    this.code = code
  }
}

const ACTION_ID_RE = /^[a-z0-9][a-z0-9.-]*(:[a-z0-9][a-z0-9.-]*)?$/
const EVENT_WHITESPACE_RE = /\s/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseActionId(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length < 2) {
    throw new HooksContractError("action-ref-invalid", `${context}: action ref must contain at least two characters`)
  }
  if (value.length > 80) {
    throw new HooksContractError("action-ref-invalid", `${context}: action ref must be at most 80 characters`)
  }
  if (!ACTION_ID_RE.test(value)) {
    throw new HooksContractError(
      "action-ref-invalid",
      `${context}: action ref ${JSON.stringify(value)} must be an AIP-39 id ` +
        "(lowercase, with an optional resource kind such as `session:child-housekeeping`)",
    )
  }
  return value
}

/**
 * Parse a string or AIP-42 actionRef object into the action-hooks/v1 action shape.
 * An object must carry exactly one of `action` or `ref`; both spellings are
 * accepted because AGENT.schema.json accepts both.
 */
export function parseHookActionRef(value: unknown, context = "action"): HookActionRef {
  if (typeof value === "string") {
    return { action: parseActionId(value, context) }
  }
  if (!isRecord(value)) {
    throw new HooksContractError("action-ref-type", `${context}: action ref must be a string or an actionRef object`)
  }

  const obj = value as AgentHookObjectRef
  const action = obj.action
  const ref = obj.ref
  if (action !== undefined && ref !== undefined) {
    throw new HooksContractError("action-ref-ambiguous", `${context}: actionRef must set only one of "action" or "ref"`)
  }
  const id = action ?? ref
  if (id === undefined) {
    throw new HooksContractError("action-ref-missing", `${context}: actionRef must set "action" or "ref"`)
  }
  const parsed: HookActionRef = { action: parseActionId(id, context) }

  if (obj.inputs !== undefined) {
    if (!isRecord(obj.inputs)) {
      throw new HooksContractError("action-ref-inputs-invalid", `${context}: actionRef.inputs must be an object`)
    }
    parsed.inputs = obj.inputs
  }
  return parsed
}

/**
 * Parse an AIP-37 event reference. Hosts may define additional bare events.
 * Host-specific namespaced events must be explicitly
 * registered, so a typo cannot silently become a nonportable dependency.
 */
export function parseHookEventRef(
  name: unknown,
  options: ParsedHookOptions = {},
): HookEventRef {
  if (typeof name !== "string" || name.length === 0) {
    throw new HooksContractError("event-ref-invalid", "event ref must be a non-empty string")
  }
  if (EVENT_WHITESPACE_RE.test(name)) {
    throw new HooksContractError("event-ref-invalid", `event ref ${JSON.stringify(name)} must not contain whitespace`)
  }

  const canonical = resolveLifecycleEvent(name)
  if (canonical !== name) {
    return { raw: name, event: canonical, kind: "alias", portable: true }
  }
  if (isStandardLifecycleEvent(name)) {
    return { raw: name, event: name, kind: "standard", portable: true }
  }
  const templated = parseTemplatedLifecycleEvent(name)
  if (templated) {
    return {
      raw: name,
      event: name,
      kind: "templated",
      portable: true,
      thresholdSeconds: templated.thresholdSeconds,
    }
  }
  if (isNamespacedLifecycleEvent(name)) {
    const registrations = (options.hostEvents ?? []).map(parseHostEventRegistration)
    const registration = registrations.find(entry => entry.event === name)
    if (!registration) {
      throw new HooksContractError(
        "event-ref-host-unregistered",
        `event ref ${JSON.stringify(name)} is host-specific and nonportable; ` +
          "register it explicitly before using it in action-hooks/v1",
      )
    }
    const host = name.slice(0, name.indexOf(":"))
    return { raw: name, event: name, kind: "host", portable: false, host }
  }

  return { raw: name, event: name, kind: "custom", portable: true }
}

export function parseHostEventRegistration(value: unknown): HostEventRegistration {
  if (!isRecord(value)) {
    throw new HooksContractError("host-event-registration-invalid", "host event registration must be an object")
  }
  const event = value.event
  if (typeof event !== "string" || event.length === 0) {
    throw new HooksContractError("host-event-registration-invalid", "host event registration.event must be a non-empty string")
  }
  if (EVENT_WHITESPACE_RE.test(event)) {
    throw new HooksContractError(
      "host-event-registration-invalid",
      `host event registration.event ${JSON.stringify(event)} must not contain whitespace`,
    )
  }
  if (!isNamespacedLifecycleEvent(event)) {
    throw new HooksContractError(
      "host-event-registration-invalid",
      `host event registration.event ${JSON.stringify(event)} must be namespaced, for example ` +
        "`agentproto:child-housekeeping`",
    )
  }
  const prefix = event.slice(0, event.indexOf(":"))
  if (prefix.length === 0 || event.slice(event.indexOf(":") + 1).length === 0) {
    throw new HooksContractError(
      "host-event-registration-invalid",
      `host event registration.event ${JSON.stringify(event)} is not a valid namespaced event`,
    )
  }
  const host = value.host
  if (host !== undefined && host !== prefix) {
    throw new HooksContractError(
      "host-event-registration-mismatch",
      `host event registration.host ${JSON.stringify(host)} must match the event namespace ` +
        `${JSON.stringify(prefix)}`,
    )
  }
  if (value.portability !== undefined && value.portability !== "nonportable") {
    throw new HooksContractError(
      "host-event-registration-invalid",
      `host event registration.portability ${JSON.stringify(value.portability)} must be ` +
        '"nonportable" when present',
    )
  }

  const registration: HostEventRegistration = {
    event,
    host: prefix,
    portability: "nonportable",
  }
  if (value.description !== undefined) {
    if (typeof value.description !== "string" || value.description.length === 0) {
      throw new HooksContractError(
        "host-event-registration-invalid",
        "host event registration.description must be a non-empty string when present",
      )
    }
    registration.description = value.description
  }
  return registration
}

/**
 * Normalize the AIP-42 AGENT.md `on:` map into action-hooks/v1 reactions. This is
 * parsing only: the runtime does not dispatch these yet. Values may be a
 * string, an actionRef object, or an array of either. The shorthand has no
 * delivery/reconciliation fields, so both default to the honest in-memory
 * values (`best-effort`, `none`).
 */
export function parseAgentHookMap(
  on: unknown,
  options: ParsedHookOptions = {},
): HookReaction[] {
  if (on === undefined) return []
  if (!isRecord(on)) {
    throw new HooksContractError("agent-hook-map-invalid", "agent `on:` map must be an object")
  }

  const reactions: HookReaction[] = []
  for (const [eventName, rawTargets] of Object.entries(on)) {
    const event = parseHookEventRef(eventName, options)
    const targets = Array.isArray(rawTargets) ? rawTargets : [rawTargets]
    if (targets.length === 0) {
      throw new HooksContractError(
        "agent-hook-entry-empty",
        `agent \`on:\` entry ${JSON.stringify(eventName)} must name at least one action`,
      )
    }
    targets.forEach((target, index) => {
      reactions.push({
        path: "reaction",
        event,
        action: parseHookActionRef(
          target,
          `agent \`on:${eventName}\`${Array.isArray(rawTargets) ? `[${index}]` : ""}`,
        ),
        delivery: "best-effort",
        reconciliation: "none",
      })
    })
  }
  return reactions
}
