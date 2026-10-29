/**
 * The AIP-39 action `tool:invoke` (AIP-38 §Tool names): the requested scope
 * is the tool's full name `<server>/<name>`, matched by scope rules 1, 2
 * and 5 only. No typed form and no selector form exists for it.
 */

import { combineDecisions, evaluateGrants, type GrantDecision, type GrantInput, type GrantRequest } from "./evaluate.js"

export const TOOL_INVOKE_ACTION = "tool:invoke"

/** The server name of the daemon's built-in tools. */
export const BUILTIN_TOOL_SERVER = "agentproto"

/**
 * The full tool name a request carries. A legacy bare built-in name becomes
 * `agentproto/<name>`, so the legacy spelling never needs its own grant. A
 * name that already has a server is returned as is.
 */
export function qualifyToolName(name: string): string {
  if (name === "" || name.includes("/")) return name
  return `${BUILTIN_TOOL_SERVER}/${name}`
}

export interface ToolInvokeRequest
  extends Pick<GrantRequest, "principals" | "now" | "evaluateCondition"> {
  /** The host registry's name of the tool being called, never taken from the call's arguments. */
  tool: string
  /** The action(s) the tool declares in `implements`. */
  implements?: string | readonly string[]
}

/**
 * Decide a tool call. A tool that declares `implements` is checked under
 * `tool:invoke` and under each implemented action together: a matching deny
 * on any refuses the call, a matching allow on any admits it.
 */
export function evaluateToolInvoke(inputs: readonly GrantInput[], request: ToolInvokeRequest): GrantDecision {
  const { tool, implements: implemented, ...rest } = request
  const implementedActions = implemented === undefined ? [] : typeof implemented === "string" ? [implemented] : implemented
  const decisions = [
    evaluateGrants(inputs, { ...rest, action: TOOL_INVOKE_ACTION, scope: qualifyToolName(tool) }),
    ...implementedActions.map(action => evaluateGrants(inputs, { ...rest, action })),
  ]
  return combineDecisions(decisions)
}
