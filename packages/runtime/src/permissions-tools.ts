/**
 * `permissions_explain`: the read-only introspection twin of `decide()`
 * (permissions.ts). It answers "may this principal do this action on this
 * target, and which rule says so" with the SAME function the enforcement
 * sites call (AIP-46 §Delegation: one predicate for enforcement and
 * introspection). It changes nothing.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import type { Grant } from "@agentproto/policy"

import { buildMessagingPermissionContext } from "./messaging-context.js"
import { DRIVE_TOOL_ACTIONS } from "./drive-gate.js"
import type { OrchestratorScope } from "./orchestrator-gateway.js"
import type { SessionsRegistry } from "./sessions.js"
import { loadConfig } from "./config.js"
import { callerProfileSet } from "./profile-gate.js"
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
  /** `defaults.messaging.allowSameWorkspace`, resolved for this request. */
  allowSameWorkspace?: boolean
  /** `defaults.messaging.peerGroups`, resolved for this request. */
  peerGroups?: readonly (readonly string[])[]
  /** `defaults.messaging.grants`, resolved for this request: explicit
   *  AIP-38 `session:message` grants that may admit a pair. */
  messagingGrants?: readonly Grant[]
  /** `defaults.messaging.agentInterrupt === "allow"`, resolved for this request. */
  allowInterrupt?: boolean
  /** `defaults.messaging.peerBinding` - "slug" (default) or "verified". */
  peerBinding?: "slug" | "verified"
  /** cwd to registered-workspace resolver for verified peer binding. Omitted: no cwd resolves, so "verified" links no peers. */
  workspaceOfCwd?: (cwd: string) => string | undefined
  /** `defaults.spawn.sharedProfiles`, resolved for this request. Omitted: read from config per call. */
  sharedProfiles?: readonly string[]
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

const text = (body: Record<string, unknown>, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  ...(isError ? { isError: true } : {}),
})

export function registerPermissionsTools(server: McpServer, opts: RegisterPermissionsToolsOptions): void {
  const {
    registry,
    callerScope,
    callerSessionId,
    allowSiblings,
    allowSameWorkspace,
    peerGroups,
    messagingGrants,
    allowInterrupt,
    peerBinding,
    workspaceOfCwd,
    sharedProfiles,
  } = opts

  server.tool(
    "permissions_explain",
    "Read-only: explain whether a principal may perform an action, and which rule decides. " +
      "Uses the same decide() the daemon enforces with. The principal is you (your session " +
      "identity, or the operator when you connect without one) unless `asSessionId` names " +
      "another session (the operator may name any; a session may name itself or a descendant). `sessionId` is the target (the recipient for session.message). " +
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
      profile: z
        .string()
        .min(1)
        .optional()
        .describe("The auth profile ref, for action auth.profile.use."),
      tool: z
        .enum(Object.keys(DRIVE_TOOL_ACTIONS) as [string, ...string[]])
        .optional()
        .describe(
          "For action session.drive: the drive tool whose action and refusal text to explain. Default agent_prompt.",
        ),
    },
    async input => {
      const callerId = callerScope?.ownerSessionId ?? callerSessionId
      // `asSessionId` is the operator's lens (a caller with no session
      // identity). A session caller may only explain itself or a session in
      // its own subtree, so the tool cannot be used to probe other sessions'
      // ACL / `allowPromptFrom` or whether their ids exist.
      if (input.asSessionId && callerId && input.asSessionId !== callerId) {
        let inSubtree = false
        const seen = new Set<string>()
        let cur: string | undefined = registry.get(input.asSessionId)?.parentSessionId
        while (cur && !seen.has(cur)) {
          if (cur === callerId) {
            inSubtree = true
            break
          }
          seen.add(cur)
          cur = registry.get(cur)?.parentSessionId
        }
        if (!inSubtree) {
          return text(
            {
              ok: false,
              error: "forbidden_as_session",
              message: "asSessionId must be yourself or a session in your own subtree",
            },
            true,
          )
        }
      }
      const selfId = input.asSessionId ?? callerId
      let principal: Principal
      if (!selfId) {
        principal = { kind: "operator", via: "anonymous-local" }
      } else {
        const self = registry.get(selfId)
        if (!self) {
          return text({ ok: false, error: "no_such_session", message: `session "${selfId}" is not in the registry` }, true)
        }
        // An external identifier is a label, evaluated as anonymous (AIP-46
        // rule 7); for an auth profile it explains as the spawn gate treats it.
        principal =
          input.profile && self.kind === "external"
            ? { kind: "operator", via: "anonymous-local" }
            : { kind: "session", session: self }
      }
      let resource: PermissionResource = { kind: "none" }
      if (input.profile) {
        resource = { kind: "profile", ref: input.profile }
      } else if (input.sessionId) {
        const target = registry.get(input.sessionId)
        if (!target) {
          return text(
            { ok: false, error: "no_such_session", message: `session "${input.sessionId}" is not in the registry` },
            true,
          )
        }
        resource = { kind: "session", session: target }
        if (input.action === "session.drive") {
          const tool = input.tool ?? "agent_prompt"
          resource = {
            kind: "session",
            session: target,
            drive: { tool, action: DRIVE_TOOL_ACTIONS[tool] ?? "session:control" },
          }
        }
      }
      // The same shared messaging context the enforcement sites build, so
      // explain and enforce cannot drift (including explicit grants).
      const messagingContext = buildMessagingPermissionContext({
        defaults: {
          allowSiblings: allowSiblings === true,
          allowSameWorkspace: allowSameWorkspace !== false,
          peerGroups: peerGroups ?? [],
          peerBinding: peerBinding ?? "slug",
          agentInterrupt: allowInterrupt ? "allow" : "deny",
          grants: messagingGrants ?? [],
        },
        registry,
        ...(workspaceOfCwd ? { workspaceOfCwd } : {}),
      })
      const decision = decide(principal, input.action, resource, {
        ...messagingContext,
        ...(input.profile
          ? {
              profiles: {
                callerAllowed: callerProfileSet({
                  caller: selfId ? registry.get(selfId) : undefined,
                  shared: sharedProfiles ?? (await defaultSharedProfiles()),
                }),
              },
            }
          : {}),
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

/** `defaults.spawn.sharedProfiles`, read per call; a missing or malformed config gives none. */
async function defaultSharedProfiles(): Promise<readonly string[]> {
  try {
    return (await loadConfig()).defaults?.spawn?.sharedProfiles ?? []
  } catch {
    return []
  }
}
