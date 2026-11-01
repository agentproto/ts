/**
 * One shared `PermissionContext` for the messaging entry points.
 *
 * The `message_send` / `message_reply` tools, `POST /sessions/:id/messages`
 * and `permissions_explain` all have to decide the same `session.message`
 * question, so they build the same context here: the `defaults.messaging.*`
 * switches, the registry lookups (`parentOf`, `operatorLabelOf`), the cwd to
 * workspace resolver, and - only when the operator configured any - the
 * explicit AIP-38 `session:message` grants under a `default: deny` policy.
 *
 * With no grants the returned context has no `policy` key at all, so the
 * no-grants context stays byte for byte the one those call sites built by
 * hand before explicit grants existed.
 *
 * Tree-only entry points do NOT use this: `message_parent`
 * (`agent-tools.ts`) and the box parent relay (`parent-relay.ts`) follow a
 * parent or child relation, which a grant cannot create or remove.
 */

import type { Grant } from "@agentproto/policy"

import type { ResolvedMessagingDefaults } from "./messaging-defaults.js"
import type { PermissionContext } from "./permissions.js"
import type { SessionsRegistry } from "./sessions.js"

export interface BuildMessagingPermissionContextInput {
  defaults: Omit<
    Pick<
      ResolvedMessagingDefaults,
      "allowSiblings" | "allowSameWorkspace" | "peerGroups" | "peerBinding" | "agentInterrupt"
    >,
    "peerGroups"
  > & {
    peerGroups?: readonly (readonly string[])[]
    grants?: readonly Grant[]
  }
  registry: Pick<SessionsRegistry, "get">
  workspaceOfCwd?: PermissionContext["workspaceOfCwd"]
  /** Overrides `defaults.agentInterrupt` (the tools take a boolean). */
  allowInterrupt?: boolean
}

export interface BuildSessionGrantContextInput {
  registry: Pick<SessionsRegistry, "get">
  grants?: readonly Grant[]
}

/**
 * The registry lookups and the explicit AIP-38 grant policy shared by the
 * messaging and drive contexts. With no grants the returned object has no
 * `policy` key at all, so the no-grants context stays byte for byte the one
 * call sites built by hand before explicit grants existed.
 */
export function buildSessionGrantContext(
  input: BuildSessionGrantContextInput,
): Pick<PermissionContext, "parentOf" | "operatorLabelOf" | "policy"> {
  const grants = input.grants ?? []
  return {
    parentOf: id => input.registry.get(id)?.parentSessionId,
    operatorLabelOf: id => input.registry.get(id)?.operatorLabel,
    ...(grants.length > 0 ? { policy: { inputs: [{ default: "deny" as const, grants }] } } : {}),
  }
}

export function buildMessagingPermissionContext(
  input: BuildMessagingPermissionContextInput,
): PermissionContext {
  const { defaults, registry, workspaceOfCwd, allowInterrupt } = input
  const grants = defaults.grants ?? []
  const interrupt = allowInterrupt ?? defaults.agentInterrupt === "allow"
  return {
    messaging: {
      allowSiblings: defaults.allowSiblings === true,
      allowSameWorkspace: defaults.allowSameWorkspace !== false,
      peerGroups: defaults.peerGroups,
      peerBinding: defaults.peerBinding,
      agentInterrupt: interrupt ? "allow" : "deny",
    },
    ...(workspaceOfCwd ? { workspaceOfCwd } : {}),
    ...buildSessionGrantContext({ registry, grants }),
  }
}
