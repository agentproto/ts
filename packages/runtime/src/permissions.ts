/**
 * One permission decision point for the daemon (AIP-38 grants over AIP-39
 * actions, AIP-46 §Delegation "one predicate for enforcement and
 * introspection").
 *
 *   decide(principal, action, resource, context) -> Decision
 *
 * Every enforcement site that has been migrated calls `decide()`, and the
 * read-only `permissions_explain` tool calls the very same function, so
 * "what would happen" and "what happens" cannot drift apart.
 *
 * Scope of this first cut (steps 1 and 2 of the permissions plan):
 *
 *  - `session.message` and `session.message.interrupt` are AUTHORITATIVE:
 *    the four messaging entry points (`message_send` / `message_reply`,
 *    `message_parent`, `POST /sessions/:id/messages`, the box parent relay)
 *    all route through them, and `registry.sendMessage` refuses a message
 *    whose attached decision does not allow it.
 *  - `session.drive` is evaluated with the exact predicate the drive tools
 *    already call (`checkSessionOwnerGate`), but the drive tools do not
 *    route through `decide()` yet, so its decisions are marked
 *    non-authoritative.
 *  - Every other action in the vocabulary is declared (types, enforcement
 *    site) but not routed: `decide()` answers `allow: false,
 *    authoritative: false` and names the site that enforces it today.
 *
 * Pure module: no registry, no I/O. Callers resolve the principal and the
 * policy (config) and pass them in.
 */

import {
  samePeerGroup,
  sameWorkspace,
  type MessageRelation,
  type MessageTreeNode,
} from "./session-message.js"
import { checkSessionOwnerGate } from "./session-owner.js"

// ── Action vocabulary (v1) ─────────────────────────────────────────────

export const PERMISSION_ACTIONS = [
  "session.spawn",
  "session.drive",
  "session.message",
  "session.message.interrupt",
  "session.read",
  "command.exec",
  "terminal.open",
  "mcp.mount.stdio",
  "pr.open",
  "auth.profile.use",
  "auth.profile.manage",
  "config.write",
  "remote.publish",
  "cron.schedule",
  "approval.decide",
  "box.relay",
] as const

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

export function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === "string" && (PERMISSION_ACTIONS as readonly string[]).includes(value)
}

export interface ActionInfo {
  /** `decide()` is the enforcement for this action. */
  routed: boolean
  /** Where the action is enforced today (file or mechanism). */
  enforcedAt: string
  /** Surfaces (MCP tools, HTTP routes) that perform the action. */
  surfaces: readonly string[]
}

/** Tool/route → action table. Hand-maintained for now; the plan's
 *  generated table (next to `daemon-tool-names.generated.ts`) replaces it
 *  once every action is routed. */
export const PERMISSION_ACTION_INFO: Readonly<Record<PermissionAction, ActionInfo>> = {
  "session.spawn": {
    routed: false,
    enforcedAt: "role.ts canSpawn (scoped gateway only), ?denyTools= on the self-mount",
    surfaces: ["agent_start", "cron_create (agent action)", "workflow_start", "app_run", "POST /sessions"],
  },
  "session.drive": {
    routed: false,
    enforcedAt: "session-owner.ts checkSessionOwnerGate (agent-tools.ts / session-tools.ts)",
    surfaces: ["agent_prompt", "agent_interrupt", "agent_kill", "session_restart", "session_continue_fresh"],
  },
  "session.message": {
    routed: true,
    enforcedAt: "permissions.ts decide()",
    surfaces: [
      "message_send",
      "message_reply",
      "message_parent",
      "POST /sessions/:id/messages",
      "POST /relay/parent-message",
    ],
  },
  "session.message.interrupt": {
    routed: true,
    enforcedAt: "permissions.ts decide()",
    surfaces: ["message_send", "message_reply", "message_parent", "POST /sessions/:id/messages", "POST /relay/parent-message"],
  },
  "session.read": {
    routed: false,
    enforcedAt: "none (GET /sessions/* is ungated on loopback)",
    surfaces: ["agent_output", "GET /sessions/:id/*", "inbox_list"],
  },
  "command.exec": {
    routed: false,
    enforcedAt: "command-allowlist.ts (isCommandAllowed / loadAllowlist)",
    surfaces: ["command_execute", "cron_create (command action)", "policy shell gates", "supervisor commit"],
  },
  "terminal.open": {
    routed: false,
    enforcedAt: "command-allowlist.ts terminalGate",
    surfaces: ["terminal_start"],
  },
  "mcp.mount.stdio": {
    routed: false,
    enforcedAt: "none (agent_start.mcpServers mounted verbatim)",
    surfaces: ["agent_start.mcpServers"],
  },
  "pr.open": {
    routed: false,
    enforcedAt: "not shipped",
    surfaces: ["pr_open"],
  },
  "auth.profile.use": {
    routed: false,
    enforcedAt: "none (any spawn may name any profile)",
    surfaces: ["agent_start.access", "agent_start.auth"],
  },
  "auth.profile.manage": {
    routed: false,
    enforcedAt: "/mcp auth only",
    surfaces: ["auth_profile_create", "auth_profile_delete", "auth_profile_import"],
  },
  "config.write": {
    routed: false,
    enforcedAt: "config-tools.ts writable flag",
    surfaces: ["config_set"],
  },
  "remote.publish": {
    routed: false,
    enforcedAt: "/mcp auth only",
    surfaces: ["remote_enable", "tunnel_create"],
  },
  "cron.schedule": {
    routed: false,
    enforcedAt: "/mcp auth only",
    surfaces: ["cron_create", "cron_delete"],
  },
  "approval.decide": {
    routed: false,
    enforcedAt: "surface=approval-cards refusal when a callerSessionId is present",
    surfaces: ["approval_card_decide"],
  },
  "box.relay": {
    routed: false,
    enforcedAt: "parent-relay.ts relay grant (delivery itself goes through session.message)",
    surfaces: ["POST /relay/parent-message"],
  },
}

// ── Principals and resources ───────────────────────────────────────────

/**
 * Who is asking. Resolved by the caller from the request, never from a
 * request body.
 *
 *  - `operator`: the human operator. `via: "anonymous-local"` is a local
 *    caller that carried no session identity at all (the CLI, an HTTP
 *    client, Claude Desktop / Cowork connecting without a session token).
 *    It keeps operator-equivalent rights on purpose: blocking it is a later,
 *    knob-gated step of the plan, not something this module does silently.
 *  - `session`: a daemon session, identified by the gateway (scope token or
 *    trusted `callerSessionId` claim).
 *  - `relay`: a box session reporting up through a host-minted relay grant;
 *    the grant (not the payload) names its parent.
 *  - `system`: daemon-internal notices (sentinels, follows, supervisors).
 */
export type Principal =
  | { kind: "operator"; via: "anonymous-local" | "credential" }
  | { kind: "session"; session: MessageTreeNode }
  | { kind: "relay"; boxSessionId: string; parentSessionId: string }
  | { kind: "system" }

/** A session target, with the fields the drive gate needs. */
export interface SessionResource {
  kind: "session"
  session: MessageTreeNode & { allowPromptFrom?: readonly string[] }
}

export type PermissionResource = SessionResource | { kind: "none" }

export interface PermissionContext {
  /** `defaults.messaging.*`, resolved per call (messaging-defaults.ts). */
  messaging?: {
    allowSiblings?: boolean
    /** `defaults.messaging.allowSameWorkspace` (default ON): two sessions of
     *  the same workspace may message each other without a tree edge. */
    allowSameWorkspace?: boolean
    /** `defaults.messaging.peerGroups`: workspace families linked regardless
     *  of `allowSameWorkspace`. */
    peerGroups?: readonly (readonly string[])[]
    agentInterrupt?: "allow" | "deny"
  }
  /** Registry lookups for the drive gate's ancestor and `label:` rules. */
  parentOf?: (id: string) => string | undefined
  operatorLabelOf?: (id: string) => string | undefined
  /** `defaults.drive.*`, resolved per call (messaging-defaults.ts). */
  drive?: {
    /** `defaults.drive.allowSameWorkspace` (default OFF): two sessions of
     *  the same workspace may drive each other without a tree edge or an
     *  `allowPromptFrom` grant. See `session-owner.ts`. */
    allowSameWorkspace?: boolean
  }
}

// ── Decision ───────────────────────────────────────────────────────────

declare const DECISION_BRAND: unique symbol

export interface DecisionBody {
  action: PermissionAction
  allow: boolean
  /** Human-readable explanation. */
  reason: string
  /** Stable id of the rule that decided (`tree.parent`, `messaging.allowSiblings`, …). */
  rule: string
  /** `true` when `decide()` IS the enforcement for this action. */
  authoritative: boolean
  /** The resource's session id, when there is one. */
  resourceId?: string
  /** `session.message*`: every relation that holds between sender and recipient. */
  relations?: MessageRelation[]
  /** `session.message*`: the strongest relation whose grant matched (allow),
   *  or the strongest that held (deny). Reported on the envelope. */
  relation?: MessageRelation
}

/** A decision minted by `decide()`. The brand keeps a caller from
 *  hand-building an `allow: true` to slip past a sink that requires one. */
export type Decision = DecisionBody & { readonly [DECISION_BRAND]: true }

function mint(body: DecisionBody): Decision {
  return body as Decision
}

// ── Messaging relations ────────────────────────────────────────────────

/** Strongest first. Also the order `resolveRelation` used to test them. */
const RELATION_STRENGTH: readonly MessageRelation[] = ["parent", "child", "sibling", "peer", "human", "system"]

/**
 * Every relation that holds between the principal (as a sender) and the
 * recipient. A tree pair can hold more than one only in a corrupt forest,
 * but collecting them all (instead of returning the first match) is what
 * lets later relation kinds (peer, door) union with tree relations.
 */
export function collectMessageRelations(
  principal: Principal,
  recipient: MessageTreeNode,
  ctx: PermissionContext = {},
): MessageRelation[] {
  switch (principal.kind) {
    case "operator":
      return ["human"]
    case "system":
      return ["system"]
    case "relay":
      return principal.parentSessionId === recipient.id ? ["child"] : []
    case "session": {
      const sender = principal.session
      if (sender.id === recipient.id) return []
      const out: MessageRelation[] = []
      if (recipient.parentSessionId === sender.id) out.push("parent")
      if (sender.parentSessionId === recipient.id) out.push("child")
      const sibling =
        !!sender.parentSessionId && sender.parentSessionId === recipient.parentSessionId
      if (sibling) out.push("sibling")
      // No tree edge: same-workspace (unless turned off) or a peer group.
      // A DENIED sibling edge may still be overridden by an explicit peer
      // group, but never by the same-workspace convenience — the tree edge
      // decides first (see `resolveMessageAcl` in session-message.ts).
      const peerGroup = samePeerGroup(sender, recipient, ctx.messaging?.peerGroups)
      if (out.length === 0) {
        if (peerGroup || (sameWorkspace(sender, recipient) && ctx.messaging?.allowSameWorkspace !== false)) {
          out.push("peer")
        }
      } else if (sibling && peerGroup) {
        out.push("peer")
      }
      return out
    }
  }
}

function strongest(relations: readonly MessageRelation[]): MessageRelation | undefined {
  return RELATION_STRENGTH.find(r => relations.includes(r))
}

/** Grant for one relation under the current policy. */
function relationGrant(
  relation: MessageRelation,
  ctx: PermissionContext,
): { allow: boolean; rule: string } {
  switch (relation) {
    case "parent":
      return { allow: true, rule: "tree.parent" }
    case "child":
      return { allow: true, rule: "tree.child" }
    case "human":
      return { allow: true, rule: "operator" }
    case "system":
      return { allow: true, rule: "system" }
    case "sibling":
      return { allow: ctx.messaging?.allowSiblings === true, rule: "messaging.allowSiblings" }
    case "peer":
      // `collectMessageRelations` only reports `peer` when the link is
      // allowed (same workspace with the allowance on, or a peer group), so
      // the grant is already established.
      return { allow: true, rule: "messaging.peer" }
  }
}

function decideMessage(
  principal: Principal,
  recipient: MessageTreeNode,
  ctx: PermissionContext,
): Decision {
  const relations = collectMessageRelations(principal, recipient, ctx)
  const base = { action: "session.message" as const, authoritative: true, resourceId: recipient.id, relations }
  if (principal.kind === "session" && principal.session.id === recipient.id) {
    return mint({ ...base, allow: false, rule: "self", reason: "a session cannot message itself" })
  }
  if (principal.kind === "relay" && relations.length === 0) {
    return mint({
      ...base,
      allow: false,
      rule: "relay.grant",
      reason: `the relay grant names parent "${principal.parentSessionId}", not "${recipient.id}"`,
    })
  }
  // Union of grants: allow when ANY relation that holds has a matching grant.
  const granted = RELATION_STRENGTH.filter(r => relations.includes(r)).map(r => ({ r, g: relationGrant(r, ctx) }))
  const hit = granted.find(x => x.g.allow)
  if (hit) {
    const rule = principal.kind === "relay" ? "relay.grant" : hit.g.rule
    return mint({
      ...base,
      allow: true,
      relation: hit.r,
      rule,
      reason:
        principal.kind === "relay"
          ? `box session "${principal.boxSessionId}" reports to its parent through the relay grant`
          : hit.r === "human"
            ? principal.kind === "operator" && principal.via === "anonymous-local"
              ? "a local caller with no session identity acts as the operator"
              : "the operator may message any session"
            : hit.r === "peer"
              ? "sender shares the recipient's workspace or peer group"
              : `sender is the recipient's ${hit.r}`,
    })
  }
  const held = strongest(relations)
  if (held === "sibling") {
    return mint({
      ...base,
      allow: false,
      relation: held,
      rule: "messaging.allowSiblings",
      reason: "siblings may message each other only when defaults.messaging.allowSiblings is true",
    })
  }
  return mint({
    ...base,
    allow: false,
    rule: "tree.none",
    reason: "the sender is not the recipient's parent, direct child or (when allowed) sibling",
  })
}

function decideInterrupt(principal: Principal, recipient: MessageTreeNode | undefined, ctx: PermissionContext): Decision {
  const base = {
    action: "session.message.interrupt" as const,
    authoritative: true,
    ...(recipient ? { resourceId: recipient.id } : {}),
  }
  if (principal.kind === "operator") {
    return mint({ ...base, allow: true, rule: "operator", reason: "the operator may interrupt any turn" })
  }
  if (principal.kind === "system") {
    // Daemon-internal senders pass their own interrupt choice to the sink.
    return mint({ ...base, allow: true, rule: "system", reason: "daemon-internal sender" })
  }
  // An interrupt is a flavour of message: it is only grantable when the
  // principal may message the recipient at all.
  if (recipient) {
    const message = decideMessage(principal, recipient, ctx)
    if (!message.allow) {
      return mint({
        ...base,
        allow: false,
        rule: "session.message",
        reason: `cannot interrupt: session.message to "${recipient.id}" is refused (${message.rule}): ${message.reason}`,
      })
    }
  }
  const allow = ctx.messaging?.agentInterrupt === "allow"
  return mint({
    ...base,
    allow,
    rule: "messaging.agentInterrupt",
    reason: allow
      ? "defaults.messaging.agentInterrupt is \"allow\""
      : "session senders may not cut a turn unless defaults.messaging.agentInterrupt is \"allow\" (delivered as steer)",
  })
}

function decideDrive(principal: Principal, target: SessionResource["session"], ctx: PermissionContext): Decision {
  const base = { action: "session.drive" as const, authoritative: false, resourceId: target.id }
  if (principal.kind === "relay") {
    return mint({ ...base, allow: false, rule: "relay", reason: "a relay grant carries only session.message" })
  }
  if (principal.kind === "system") {
    return mint({ ...base, allow: true, rule: "system", reason: "daemon-internal" })
  }
  const callerSessionId = principal.kind === "session" ? principal.session.id : undefined
  const callerWorkspaceSlug = principal.kind === "session" ? principal.session.workspaceSlug : undefined
  const r = checkSessionOwnerGate({
    callerSessionId,
    target: {
      id: target.id,
      ...(target.parentSessionId ? { parentSessionId: target.parentSessionId } : {}),
      ...(target.allowPromptFrom ? { allowPromptFrom: [...target.allowPromptFrom] } : {}),
      ...(target.workspaceSlug ? { workspaceSlug: target.workspaceSlug } : {}),
    },
    tool: "session.drive",
    ...(ctx.parentOf ? { parentOf: ctx.parentOf } : {}),
    ...(ctx.operatorLabelOf ? { operatorLabelOf: ctx.operatorLabelOf } : {}),
    ...(callerWorkspaceSlug ? { callerWorkspaceSlug } : {}),
    allowSameWorkspace: ctx.drive?.allowSameWorkspace === true,
  })
  return r.ok
    ? mint({
        ...base,
        allow: true,
        rule: "owner-gate",
        reason: callerSessionId
          ? "caller is the session, an ancestor, granted by allowPromptFrom, or (same-workspace driving is on) in the same workspace"
          : "the operator may drive any session",
      })
    : mint({ ...base, allow: false, rule: "owner-gate", reason: r.message })
}

/**
 * The one decision point. Pure.
 *
 * `session.message` / `session.message.interrupt` need a `session`
 * resource (the recipient). `session.drive` needs a `session` resource
 * (the target). Every other action is not routed yet and answers
 * `allow: false, authoritative: false`.
 */
export function decide(
  principal: Principal,
  action: PermissionAction,
  resource: PermissionResource,
  context: PermissionContext = {},
): Decision {
  const recipient = resource.kind === "session" ? resource.session : undefined
  switch (action) {
    case "session.message":
      if (!recipient) {
        return mint({ action, allow: false, authoritative: true, rule: "resource", reason: "session.message needs a recipient session" })
      }
      return decideMessage(principal, recipient, context)
    case "session.message.interrupt":
      return decideInterrupt(principal, recipient, context)
    case "session.drive":
      if (!recipient) {
        return mint({ action, allow: false, authoritative: false, rule: "resource", reason: "session.drive needs a target session" })
      }
      return decideDrive(principal, recipient, context)
    default: {
      const info = PERMISSION_ACTION_INFO[action]
      return mint({
        action,
        allow: false,
        authoritative: false,
        rule: "not-routed",
        ...(recipient ? { resourceId: recipient.id } : {}),
        reason: `${action} is not routed through decide() yet; today it is enforced at: ${info.enforcedAt}`,
      })
    }
  }
}

/** Thrown by a sink handed a decision that does not allow what it is asked to do. */
export class PermissionDeniedError extends Error {
  readonly decision: DecisionBody
  constructor(decision: DecisionBody, message?: string) {
    super(message ?? `permission denied: ${decision.action} (${decision.rule}): ${decision.reason}`)
    this.name = "PermissionDeniedError"
    this.decision = decision
  }
}

/** Sink-side check: the decision must allow `action` on `resourceId`. */
export function assertDecisionAllows(
  decision: Decision,
  action: PermissionAction,
  resourceId: string,
): void {
  if (decision.action !== action) {
    throw new PermissionDeniedError(decision, `permission decision is for ${decision.action}, not ${action}`)
  }
  if (decision.resourceId !== resourceId) {
    throw new PermissionDeniedError(
      decision,
      `permission decision is for "${decision.resourceId ?? "(none)"}", not "${resourceId}"`,
    )
  }
  if (!decision.allow) throw new PermissionDeniedError(decision)
}
