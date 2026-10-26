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
 */

import { decideRule, loadHooksConfig } from "./hooks-config.js"
import type { ProxyCallGuard } from "./mcp-proxy.js"
import type { SessionsRegistry } from "./sessions.js"

export interface ImportedCallGuardOptions {
  registry: Pick<SessionsRegistry, "requestToolPermission" | "get">
  /** Workspace whose hooks.json applies when the caller session is unknown. */
  workspace: string
  /** Fail-closed ceiling on waiting for a human. Default 10 minutes. */
  timeoutMs?: number
}

export function createImportedCallGuard(opts: ImportedCallGuardOptions): ProxyCallGuard {
  return async ({ alias, toolName, args, context }) => {
    const callerSessionId = context?.callerSessionId
    const caller = callerSessionId ? opts.registry.get(callerSessionId) : undefined
    const rules = loadHooksConfig(caller?.cwd ?? opts.workspace)
    if (rules.length === 0) return { allow: true }

    const held = [toolName, `imported:${alias}/${toolName}`].some(
      name => decideRule(rules, { tool: name }, "allow").decision !== "allow",
    )
    if (!held) return { allow: true }

    const outcome = await opts.registry.requestToolPermission({
      ...(callerSessionId ? { sessionId: callerSessionId } : {}),
      toolName,
      text: `Allow "${toolName}" on ${alias}?`,
      rawInput: { alias, toolName, args },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
    if (outcome.decision === "approve") return { allow: true }
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
