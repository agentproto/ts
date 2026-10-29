/**
 * The AGENT.md `on: {turn-end: session:clerk-pass}` entry: the declarative way
 * for an agent to enable the AIP-68 clerk for its own sessions.
 *
 * The clerk is driven by its own turn-end controller (debounced, single
 * flight), not by the reaction runner, so the entry is read at spawn time to
 * switch the agent level of the clerk hook on, and the agent `on` scanner
 * leaves it out of the reaction bindings. The clerk's configuration (debounce,
 * run, exclude) stays in `metadata.hooks.clerk`.
 */

import { parseAgentHookMap } from "@agentproto/lifecycle"

import { HOST_EVENT_REGISTRATIONS } from "./event-bindings.js"

export const CLERK_REACTION_ACTION_ID = "session:clerk-pass"

const TURN_END_EVENT = "turn-end"

/** True for the one `on` entry the clerk owns: canonical event `turn-end` (aliases resolved) and action `session:clerk-pass`. */
export function isClerkTurnEndEntry(event: string, actionId: string): boolean {
  return event === TURN_END_EVENT && actionId === CLERK_REACTION_ACTION_ID
}

/** True when a raw AGENT.md `on` map carries the clerk entry. An invalid map enables nothing: the agent `on` scanner reports it as a refusal. */
export function agentOnEnablesClerk(on: unknown): boolean {
  try {
    return parseAgentHookMap(on, { hostEvents: HOST_EVENT_REGISTRATIONS }).some(reaction =>
      isClerkTurnEndEntry(reaction.event.event, reaction.action.action),
    )
  } catch {
    return false
  }
}
