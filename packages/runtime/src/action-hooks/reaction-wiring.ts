/**
 * Reaction wiring: connect the resolved AIP-41 event bindings to the durable
 * reaction runner. Every routine reconcile calls `refresh()`, which rebuilds
 * the live binding list (builtins first, then converted routines) and hands it
 * to `ReactionRunner.replaceBindings`.
 *
 * A binding that cannot be converted, or whose id is already taken, is refused
 * and never goes live. `refresh()` never throws: it keeps the previous live
 * set when the routine list or the runner fails, and reports the failure under
 * the binding id `*`.
 */

import type { SessionDescriptor } from "../sessions.js"
import type { ResolvedEventBinding } from "./event-bindings.js"
import {
  toReactionBinding,
  type ReactionBindingDeps,
  type ReactionBinding,
} from "./reaction-bindings.js"
import type { ReactionRunner } from "./reaction-runner.js"

const LOG_PREFIX = "[reaction-wiring]"

export interface ReactionWiringDeps {
  runner: Pick<ReactionRunner, "replaceBindings">
  /** Always-on bindings that are not authored by a user (the brain-ingest pilot). */
  builtin: readonly ReactionBinding[]
  /** `RoutineRegistrar.eventBindings`. */
  eventBindings: () => readonly ResolvedEventBinding[]
  /** Passed to `toReactionBinding` as is. */
  conversion: ReactionBindingDeps
  log?: (line: string) => void
}

export interface ReactionWiringResult {
  /** Binding ids now live, builtin first then routines in input order. */
  active: string[]
  refused: Array<{ bindingId: string; error: string }>
}

export interface ReactionWiring {
  refresh(): ReactionWiringResult
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The documented `session.<field>` filter facts of a session descriptor. */
export function sessionFactsOf(desc: SessionDescriptor): Record<string, unknown> {
  const facts: Record<string, unknown> = {
    kind: desc.kind,
    isChild: desc.parentSessionId !== undefined,
    workspaceSlug: desc.workspaceSlug,
  }
  if (desc.origin !== undefined) facts.origin = desc.origin
  if (desc.adapterSlug !== undefined) facts.adapter = desc.adapterSlug
  if (desc.label !== undefined) facts.label = desc.label
  return facts
}

export function createReactionWiring(deps: ReactionWiringDeps): ReactionWiring {
  const log = deps.log ?? ((line: string): void => console.warn(line))
  const logLine = (message: string): void => log(`${LOG_PREFIX} ${message}`)
  const loggedRefusals = new Set<string>()
  let current: readonly ReactionBinding[] = deps.builtin.slice()
  let lastResult: ReactionWiringResult = {
    active: current.map(binding => binding.bindingId),
    refused: [],
  }

  const logRefusal = (bindingId: string, error: string): void => {
    const key = `${bindingId}\u0000${error}`
    if (loggedRefusals.has(key)) return
    loggedRefusals.add(key)
    logLine(`refused ${bindingId}: ${error}`)
  }

  return {
    refresh(): ReactionWiringResult {
      try {
        const resolved = deps.eventBindings()
        const list: ReactionBinding[] = deps.builtin.slice()
        const ids = new Set(list.map(binding => binding.bindingId))
        const refused: ReactionWiringResult["refused"] = []

        for (const binding of resolved) {
          const converted = toReactionBinding(binding, deps.conversion)
          if (!converted.ok) {
            refused.push({ bindingId: binding.bindingId, error: converted.error })
            logRefusal(binding.bindingId, converted.error)
            continue
          }
          if (ids.has(converted.binding.bindingId)) {
            const error = `duplicate binding id '${converted.binding.bindingId}'`
            refused.push({ bindingId: converted.binding.bindingId, error })
            logRefusal(converted.binding.bindingId, error)
            continue
          }
          ids.add(converted.binding.bindingId)
          list.push(converted.binding)
        }

        deps.runner.replaceBindings(list)
        current = list
        lastResult = { active: list.map(binding => binding.bindingId), refused }
        return lastResult
      } catch (err) {
        const error = messageOf(err)
        logRefusal("*", error)
        const previous = lastResult.refused.filter(entry => entry.bindingId !== "*")
        lastResult = {
          active: current.map(binding => binding.bindingId),
          refused: [...previous, { bindingId: "*", error }],
        }
        return lastResult
      }
    },
  }
}
