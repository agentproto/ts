/**
 * Per-call human approval on imported-MCP tool calls.
 *
 * An imported MCP tool (e.g. agentpush `send_message`) is reached through the
 * daemon's `McpProxyRegistry`, which has no per-call permission check and never
 * produces an ACP `session/request_permission`. This guard closes that gap for
 * the tools an operator names in `.agentproto/hooks.json`:
 *
 *   {"id":"hold-send","plane":"semantic","match":{"tool":"send_message"},"action":"hold"}
 *
 * A matching call is parked in the registry's pending-permissions inbox (the
 * same one `permissions_list` / `permissions_respond` and the
 * `session:permission-request` bus event serve) and only dispatched on
 * `allow_once`. A tool name is tested both bare (`send_message`) and
 * namespaced (`imported:<alias>/send_message`, the id form `app_tool_call`
 * already uses) so a rule can be scoped to one import.
 *
 * The fallback decision is `"allow"`: with no hooks.json, a log-only file, or
 * no matching rule, nothing is held and the call is dispatched untouched.
 * Any non-allow action (`hold`, `deny`, `gate`) routes to the human hold: this
 * seam has no shell-gate runner and does not auto-deny real work.
 *
 * Node scope (AIP-34): the guard derives the CALLER's scope itself and hands
 * it to the proxy as per-call headers (`x-agentproto-caller-session`, and
 * `x-agentproto-caller-node` when the session's ground lies in a declared
 * node), which the proxy sends to http/sse servers on this machine or ones
 * that opted in. A call that names a session the daemon does not know is
 * refused before anything is dispatched, hooks or not; a call that names no
 * session is a host call and is dispatched with no headers.
 *
 * Deny grants (T3b): a caller whose descriptor carries `toolDenyGrants` (from
 * its AGENT manifest's `tools` deny items) is refused a `<alias>/<tool>` they
 * name, with a reason naming the tool and the grant, before hooks or the
 * human hold. Deny-only: no grants, no evaluation.
 */

import { callerHeaders, callerScopes, type CallerScopes } from "./caller-scope.js"
import { decideRule, loadHooksConfig } from "./hooks-config.js"
import type { ProxyCallGuard } from "./mcp-proxy.js"
import type { SessionsRegistry } from "./sessions.js"
import { toolDenyRefusal } from "./tool-deny-gate.js"

export interface ImportedCallGuardOptions {
  registry: Pick<SessionsRegistry, "requestToolPermission" | "get">
  /** Workspace whose hooks.json applies when the caller session is unknown. */
  workspace: string
  /** Fail-closed ceiling on waiting for a human. Default 10 minutes. */
  timeoutMs?: number
  /** Where trees are read from. Default: the daemon's shared instance. */
  scopes?: CallerScopes
}

export function createImportedCallGuard(opts: ImportedCallGuardOptions): ProxyCallGuard {
  return async ({ alias, toolName, args, context }) => {
    const callerSessionId = context?.callerSessionId
    const callerScope = (opts.scopes ?? callerScopes).resolve(callerSessionId, opts.registry)
    if (callerScope.kind === "refused") return { allow: false, reason: callerScope.reason }
    const headers = callerHeaders(callerScope)
    const proceed = { allow: true as const, ...(headers ? { headers } : {}) }
    const caller = callerSessionId ? opts.registry.get(callerSessionId) : undefined
    const refusal = toolDenyRefusal(caller?.toolDenyGrants, `${alias}/${toolName}`, callerSessionId)
    if (refusal) return { allow: false, reason: `${refusal.reason}; nothing was sent.` }
    const rules = loadHooksConfig(caller?.cwd ?? opts.workspace)
    if (rules.length === 0) return proceed

    const held = [toolName, `imported:${alias}/${toolName}`].some(
      name => decideRule(rules, { tool: name }, "allow").decision !== "allow",
    )
    if (!held) return proceed

    const outcome = await opts.registry.requestToolPermission({
      ...(callerSessionId ? { sessionId: callerSessionId } : {}),
      toolName,
      text: `Allow "${toolName}" on ${alias}?`,
      rawInput: { alias, toolName, args },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
    if (outcome.decision === "approve") return proceed
    if (outcome.decision === "deny") {
      return { allow: false, reason: `${toolName} on ${alias} was rejected by the operator; nothing was sent.` }
    }
    return {
      allow: false,
      reason:
        outcome.reason === "timeout"
          ? `${toolName} on ${alias} timed out waiting for operator approval; nothing was sent.`
          : `${toolName} on ${alias} was cancelled (${outcome.reason}) before approval; nothing was sent.`,
    }
  }
}
