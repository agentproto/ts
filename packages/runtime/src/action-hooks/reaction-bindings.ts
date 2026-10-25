/**
 * Reaction bindings: turn a resolved event binding (an AIP-41 event routine or
 * an AIP-42 `on` entry) into the runnable `ReactionBinding` the durable
 * reaction runner consumes.
 *
 * One typed action registry serves AIP-41 `action` targets. The three dispatch
 * target arms (`tool`, `workflow`, `agent`) lower through the same
 * `routineTargetToToolCall` / `toAgentStartCall` functions the routine runtime
 * uses, then call the injected `dispatchTool`. Nothing here subscribes to the
 * bus, writes a receipt or touches the daemon: this module is pure and every
 * dependency is injected.
 *
 * Known limits in this version: causedByEventId is not stamped and
 * reactionDepth is the static value 0; the only cycle guard is the self-chain
 * guard of agent arms, a tool or workflow arm that starts sessions is not covered; both
 * come with the daemon wiring task.
 */

import type { SessionEvent } from "../session-event-bus.js"
import type {
  ReactionBinding,
  ReactionTarget,
  ReactionTargetInput,
  ReactionTargetOutcome,
} from "./reaction-runner.js"
import type { ResolvedEventBinding } from "./event-bindings.js"
import { isActionKind } from "./occurrence-key.js"
import { matchEventFilter } from "./event-bindings.js"
import { routineTargetToToolCall } from "../routine-registrar.js"
import { toAgentStartCall } from "../agent-start-schema.js"

const LOG_PREFIX = "[reaction-bindings]"

const SESSION_COMPLETED_EVENT = "agentproto:session-completed"

const RESERVED_CATEGORY = "agentproto"

const DEFAULT_MAX_ATTEMPTS = 3

const ERROR_TEXT_MAX = 500

const OUTCOME_TEXT_MAX = 200

// ── Action registry ───────────────────────────────────────────────────

/** What a registered action receives: the runner's target input plus the `inputs` authored on the binding. */
export interface ActionRunInput extends ReactionTargetInput {
  inputs?: Record<string, unknown>
}

export interface ActionHandler {
  /** AIP-39 id (qualified `<category>:<verb>` or unqualified), valid per `isActionKind`. */
  readonly actionId: string
  /** true only when running the same occurrence twice is safe because the handler dedupes by its own durable ledger. */
  readonly idempotent: boolean
  run(input: ActionRunInput): Promise<ReactionTargetOutcome>
}

export interface ActionRegistry {
  register(handler: ActionHandler): void
  get(actionId: string): ActionHandler | undefined
  list(): readonly ActionHandler[]
}

export type ActionRegistryErrorCode = "invalid-id" | "reserved-category" | "duplicate"

export class ActionRegistryError extends Error {
  readonly code: ActionRegistryErrorCode

  constructor(code: ActionRegistryErrorCode, message: string) {
    super(message)
    this.name = "ActionRegistryError"
    this.code = code
  }
}

function categoryOf(actionId: string): string {
  const colon = actionId.indexOf(":")
  return colon === -1 ? actionId : actionId.slice(0, colon)
}

export function createActionRegistry(handlers: readonly ActionHandler[] = []): ActionRegistry {
  const byId = new Map<string, ActionHandler>()
  const order: ActionHandler[] = []

  const register = (handler: ActionHandler): void => {
    if (!isActionKind(handler.actionId)) {
      throw new ActionRegistryError(
        "invalid-id",
        `action id ${JSON.stringify(handler.actionId)} is not a valid AIP-39 action id`,
      )
    }
    if (categoryOf(handler.actionId) === RESERVED_CATEGORY) {
      throw new ActionRegistryError(
        "reserved-category",
        `action id ${JSON.stringify(handler.actionId)} uses the reserved category '${RESERVED_CATEGORY}'`,
      )
    }
    if (byId.has(handler.actionId)) {
      throw new ActionRegistryError(
        "duplicate",
        `action id ${JSON.stringify(handler.actionId)} is already registered`,
      )
    }
    byId.set(handler.actionId, handler)
    order.push(handler)
  }

  for (const handler of handlers) register(handler)

  return {
    register,
    get(actionId) {
      return byId.get(actionId)
    },
    list() {
      return order.slice()
    },
  }
}

// ── Event support ─────────────────────────────────────────────────────

/** Events a reaction binding may subscribe to today. Each knows its occurrence id and the payload a filter path addresses. */
export interface ReactionEventSupport {
  occurrenceIdOf(event: SessionEvent): string | undefined
  /** The object `matchEventFilter` walks. undefined means "cannot be projected", so a filtered binding does not fire. */
  project(
    event: SessionEvent,
    getSessionFacts: (sessionId: string) => Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined
}

const sessionCompletedSupport: ReactionEventSupport = {
  occurrenceIdOf(event) {
    if (event.type !== SESSION_COMPLETED_EVENT) return undefined
    return event.occurrenceId
  },
  project(event, getSessionFacts) {
    if (event.type !== SESSION_COMPLETED_EVENT) return undefined
    const facts = getSessionFacts(event.sessionId)
    return {
      type: event.type,
      sessionId: event.sessionId,
      occurrenceId: event.occurrenceId,
      basis: event.basis,
      endedAt: event.endedAt,
      ...(event.label !== undefined ? { label: event.label } : {}),
      ...(facts !== undefined ? { session: facts } : {}),
    }
  },
}

export const REACTION_EVENT_SUPPORT: ReadonlyMap<string, ReactionEventSupport> = new Map([
  [SESSION_COMPLETED_EVENT, sessionCompletedSupport],
])

// ── Dispatch result mapping ───────────────────────────────────────────

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Map a raw `dispatchTool` result to a reaction outcome. A throw is left to the runner. */
export function dispatchResultToOutcome(result: unknown): ReactionTargetOutcome {
  if (typeof result !== "object" || result === null) {
    return { ok: true, outcomeRef: "ok" }
  }
  const raw = result as { content?: unknown; isError?: unknown }
  const content = Array.isArray(raw.content) ? raw.content : []
  const text = content
    .map(entry => {
      if (typeof entry !== "object" || entry === null) return ""
      const value = (entry as { text?: unknown }).text
      return typeof value === "string" ? value : ""
    })
    .join("\n")
    .trim()
  if (raw.isError === true) {
    return { ok: false, error: clip(text || "tool_error", ERROR_TEXT_MAX) }
  }
  return { ok: true, outcomeRef: clip(text || "ok", OUTCOME_TEXT_MAX) }
}

// ── Binding conversion ────────────────────────────────────────────────

export interface ReactionBindingDeps {
  registry: ActionRegistry
  /** The same authorized dispatch path routines use today (`RoutineRegistrar.trigger` calls it). */
  dispatchTool: (name: string, inputs: Record<string, unknown>) => Promise<unknown>
  /** Flat facts of a session for filter paths of the form `session.<field>` (kind, isChild, workspaceSlug, origin, ...). The daemon wiring (AH-12b) supplies it. */
  getSessionFacts: (sessionId: string) => Record<string, unknown> | undefined
  /** Workspace root for relative workflow files, as in routine-registrar. */
  workspaceRoot: string
  maxAttempts?: number
  log?: (line: string) => void
}

export type ToReactionBindingResult =
  | { ok: true; binding: ReactionBinding }
  | { ok: false; error: string }

function loweredTarget(
  call: { tool: string; inputs: Record<string, unknown> },
  actionId: string,
  deps: ReactionBindingDeps,
): ReactionTarget {
  return {
    actionId,
    idempotent: false,
    run: async () => dispatchResultToOutcome(await deps.dispatchTool(call.tool, call.inputs)),
  }
}

export function toReactionBinding(
  resolved: ResolvedEventBinding,
  deps: ReactionBindingDeps,
): ToReactionBindingResult {
  const eventName = resolved.event.event
  const support = REACTION_EVENT_SUPPORT.get(eventName)
  if (support === undefined) {
    const supported = [...REACTION_EVENT_SUPPORT.keys()].join(", ")
    return {
      ok: false,
      error: `event '${eventName}' is not supported by reaction bindings; only ${supported} are supported`,
    }
  }

  const log = deps.log ?? ((line: string): void => console.warn(line))
  const logLine = (message: string): void => log(`${LOG_PREFIX} ${message}`)

  const target = resolved.target
  let actionId: string
  let reactionTarget: ReactionTarget
  let agentArm = false

  if ("action" in target) {
    const handler = deps.registry.get(target.action)
    if (handler === undefined) {
      return {
        ok: false,
        error: `action '${target.action}' is not registered; a binding may not reference an unknown action`,
      }
    }
    const authored = target.inputs
    actionId = target.action
    reactionTarget = {
      actionId,
      idempotent: handler.idempotent,
      run: input =>
        handler.run({
          ...input,
          ...(authored !== undefined ? { inputs: authored as Record<string, unknown> } : {}),
        }),
    }
  } else {
    try {
      if ("tool" in target) {
        const call = routineTargetToToolCall(target, undefined, { workspaceRoot: deps.workspaceRoot })
        actionId = `tool:${target.tool}`
        reactionTarget = loweredTarget(call, actionId, deps)
      } else if ("workflow" in target) {
        const call = routineTargetToToolCall(target, undefined, { workspaceRoot: deps.workspaceRoot })
        actionId = "workflow:run-file"
        reactionTarget = loweredTarget(call, actionId, deps)
      } else {
        const call = toAgentStartCall(target.agent, {
          origin: `reaction:${resolved.bindingId}`,
          context: `reaction ${resolved.bindingId}`,
        })
        actionId = "agent:start"
        agentArm = true
        reactionTarget = loweredTarget(call, actionId, deps)
      }
    } catch (err) {
      return { ok: false, error: messageOf(err) }
    }
  }

  let guardLogged = false
  let missingFactsLogged = false

  const shouldHandle = async (event: SessionEvent): Promise<boolean> => {
    if (agentArm) {
      const sessionIdOf = (event as { sessionId?: unknown }).sessionId
      if (typeof sessionIdOf === "string") {
        const facts = deps.getSessionFacts(sessionIdOf)
        if (facts === undefined) {
          if (!missingFactsLogged) {
            missingFactsLogged = true
            logLine(
              `cannot read the session facts, not starting an agent for ${resolved.bindingId}`,
            )
          }
          return false
        }
        const origin = facts.origin
        if (typeof origin === "string" && origin.startsWith("reaction:")) {
          if (!guardLogged) {
            guardLogged = true
            logLine(
              `ignoring completion of a reaction-launched session for ${resolved.bindingId}`,
            )
          }
          return false
        }
      }
    }

    if (resolved.filter === undefined) return true

    const payload = support.project(event, deps.getSessionFacts)
    if (payload === undefined) return false
    return matchEventFilter(resolved.filter, payload)
  }

  const binding: ReactionBinding = {
    bindingId: resolved.bindingId,
    event: eventName,
    actionId,
    configRevision: resolved.configRevision,
    maxAttempts: deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    reactionDepth: 0,
    target: reactionTarget,
    occurrenceIdOf: event => support.occurrenceIdOf(event),
    shouldHandle,
  }

  return { ok: true, binding }
}
