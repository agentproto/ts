/**
 * `permissions_explain`: the read-only introspection twin of `decide()`
 * (permissions.ts). It answers "may this principal do this action on this
 * target, and which rule says so" with the SAME function the enforcement
 * sites call (AIP-46 §Delegation: one predicate for enforcement and
 * introspection). It changes nothing.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import type { OrchestratorScope } from "./orchestrator-gateway.js"
import type { SessionsRegistry } from "./sessions.js"
import {
  decide,
  PERMISSION_ACTIONS,
  PERMISSION_ACTION_INFO,
  type PermissionAction,
  type PermissionResource,
  type Principal,
} from "./permissions.js"

export interface RegisterPermissionsToolsOptions {
  registry: SessionsRegistry
  callerScope?: OrchestratorScope
  callerSessionId?: string
  /** `defaults.messaging.allowSiblings`, resolved for this request. */
  allowSiblings?: boolean
  /** `defaults.messaging.agentInterrupt === "allow"`, resolved for this request. */
  allowInterrupt?: boolean
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

const text = (body: Record<string, unknown>, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  ...(isError ? { isError: true } : {}),
})

export function registerPermissionsTools(server: McpServer, opts: RegisterPermissionsToolsOptions): void {
  const { registry, callerScope, callerSessionId, allowSiblings, allowInterrupt } = opts

  server.tool(
    "permissions_explain",
    "Read-only: explain whether a principal may perform an action, and which rule decides. " +
      "Uses the same decide() the daemon enforces with. The principal is you (your session " +
      "identity, or the operator when you connect without one) unless `asSessionId` names " +
      "another session. `sessionId` is the target (the recipient for session.message). " +
      "Decisions marked authoritative:false are for actions not yet routed through decide().",
    {
      action: z
        .enum(PERMISSION_ACTIONS as unknown as [PermissionAction, ...PermissionAction[]])
        .describe("The action, e.g. session.message, session.message.interrupt, session.drive."),
      sessionId: z.string().min(1).optional().describe("Target session id."),
      asSessionId: z
        .string()
        .min(1)
        .optional()
        .describe("Explain for this session as the principal instead of yourself."),
    },
    async input => {
      const selfId = input.asSessionId ?? callerScope?.ownerSessionId ?? callerSessionId
      let principal: Principal
      if (!selfId) {
        principal = { kind: "operator", via: "anonymous-local" }
      } else {
        const self = registry.get(selfId)
        if (!self) {
          return text({ ok: false, error: "no_such_session", message: `session "${selfId}" is not in the registry` }, true)
        }
        principal = { kind: "session", session: self }
      }
      let resource: PermissionResource = { kind: "none" }
      if (input.sessionId) {
        const target = registry.get(input.sessionId)
        if (!target) {
          return text(
            { ok: false, error: "no_such_session", message: `session "${input.sessionId}" is not in the registry` },
            true,
          )
        }
        resource = { kind: "session", session: target }
      }
      const decision = decide(principal, input.action, resource, {
        messaging: { allowSiblings: allowSiblings === true, agentInterrupt: allowInterrupt ? "allow" : "deny" },
        parentOf: id => registry.get(id)?.parentSessionId,
        operatorLabelOf: id => registry.get(id)?.operatorLabel,
      })
      return text({
        ok: true,
        principal:
          principal.kind === "session"
            ? { kind: "session", sessionId: principal.session.id }
            : { kind: principal.kind, ...(principal.kind === "operator" ? { via: principal.via } : {}) },
        decision,
        action: PERMISSION_ACTION_INFO[input.action],
      })
    },
  )
}
