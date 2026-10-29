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
 * AIP-38 grants are consulted at call time through `PermissionContext.policy`
 * (`evaluateGrants` from `@agentproto/policy`): an explicit deny removes the
 * grant-derived reasons of `session.message` (sibling, peer) and refuses
 * `tool.invoke`. A tree edge, the operator and the system are never removed
 * by a deny (AIP-46 §Who may message whom rule 3). The context is read per
 * call, so a revoked grant applies on the next call. No caller passes
 * `policy` yet, so every existing decision is unchanged.
 *
 * Pure module: no registry, no I/O. Callers resolve the principal and the
 * policy (config) and pass them in.
 */

import {
  evaluateGrants,
  evaluateToolInvoke,
  PolicyGrantError,
  qualifyToolName,
  type GrantDecision,
  type GrantInput,
  type GrantRequest,
} from "@agentproto/policy"

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
  "tool.invoke",
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
  "tool.invoke": {
    routed: false,
    enforcedAt: "tool-deny-gate.ts: the /mcp server factory (agentproto/<name>) and createImportedCallGuard (<server>/<name>) evaluate a session's AGENT deny grants (deny-only) when its descriptor carries toolDenyGrants",
    surfaces: [],
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

/** A tool call. `name` is the registry's full name `<server>/<name>`, or a legacy bare built-in. */
export interface ToolResource {
  kind: "tool"
  name: string
  /** Actions the tool declares in `implements`. */
  implements?: string | readonly string[]
}

export type PermissionResource = SessionResource | ToolResource | { kind: "none" }

/** AIP-38 grants consulted at call time. Read per call: build a fresh object when the grants change. */
export interface PermissionPolicy {
  /** Composed policies and/or bare grants. */
  inputs: readonly GrantInput[]
  /** Identity refs of the principal. Default: `session-label://<operator label>` for a session with one. */
  principals?: (principal: Principal) => readonly string[]
  now?: GrantRequest["now"]
  resolveSelector?: GrantRequest["resolveSelector"]
  evaluateCondition?: GrantRequest["evaluateCondition"]
}

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
    /** `defaults.messaging.peerBinding` (default "slug"): "slug" links peers
     *  by recorded workspace slug; "verified" requires both cwds to resolve
     *  to the same registered workspace via `workspaceOfCwd`. */
    peerBinding?: "slug" | "verified"
    agentInterrupt?: "allow" | "deny"
  }
  /** cwd to registered workspace slug (undefined when unregistered). */
  workspaceOfCwd?: (cwd: string) => string | undefined
  /** Registry lookups for the drive gate's ancestor and `label:` rules. */
  parentOf?: (id: string) => string | undefined
  operatorLabelOf?: (id: string) => string | undefined
  /** AIP-38 grants for `session.message` denies and `tool.invoke`. Absent: no grant is consulted. */
  policy?: PermissionPolicy
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
  /** `session.message*`: set when a peer link is (or, under the verified
   *  binding, would have been) involved. `true` when both cwds resolve to the
   *  same registered workspace. */
  peerVerified?: boolean
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

function verifiedSlugOf(node: MessageTreeNode, ctx: PermissionContext): string | undefined {
  if (!node.cwd || !ctx.workspaceOfCwd) return undefined
  return ctx.workspaceOfCwd(node.cwd)?.trim() || undefined
}

/** Same-workspace and peer-group links by the VERIFIED slugs (cwd to registered workspace). */
function verifiedLinks(
  sender: MessageTreeNode,
  recipient: MessageTreeNode,
  ctx: PermissionContext,
): { group: boolean; workspace: boolean } {
  const a = verifiedSlugOf(sender, ctx)
  const b = verifiedSlugOf(recipient, ctx)
  if (!a || !b) return { group: false, workspace: false }
  return {
    group: samePeerGroup(
      { id: sender.id, workspaceSlug: a },
      { id: recipient.id, workspaceSlug: b },
      ctx.messaging?.peerGroups,
    ),
    workspace: a === b && ctx.messaging?.allowSameWorkspace !== false,
  }
}

function slugLinks(
  sender: MessageTreeNode,
  recipient: MessageTreeNode,
  ctx: PermissionContext,
): { group: boolean; workspace: boolean } {
  return {
    group: samePeerGroup(sender, recipient, ctx.messaging?.peerGroups),
    workspace: sameWorkspace(sender, recipient) && ctx.messaging?.allowSameWorkspace !== false,
  }
}

/**
 * How a no-tree-edge pair is bound as peers under the slug rule: "verified"
 * when the verified rule (both cwds resolve to one registered workspace)
 * links them too, "unverified" when only the recorded slugs do, "none" when
 * the slug rule does not link them.
 */
function peerBindingStatus(
  sender: MessageTreeNode,
  recipient: MessageTreeNode,
  ctx: PermissionContext = {},
): "none" | "verified" | "unverified" {
  const slug = slugLinks(sender, recipient, ctx)
  if (!slug.group && !slug.workspace) return "none"
  const ver = verifiedLinks(sender, recipient, ctx)
  return ver.group || ver.workspace ? "verified" : "unverified"
}

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
      const links =
        ctx.messaging?.peerBinding === "verified"
          ? verifiedLinks(sender, recipient, ctx)
          : slugLinks(sender, recipient, ctx)
      const peerGroup = links.group
      if (out.length === 0) {
        if (peerGroup || links.workspace) {
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

// ── AIP-38 grants ──────────────────────────────────────────────────────

/** Relations that exist because of configuration (a grant), not a tree edge. */
const GRANT_DERIVED_RELATIONS: ReadonlySet<MessageRelation> = new Set<MessageRelation>(["sibling", "peer"])

function policyPrincipals(principal: Principal, policy: PermissionPolicy, ctx: PermissionContext): readonly string[] {
  if (policy.principals) return policy.principals(principal)
  if (principal.kind !== "session") return []
  const label = ctx.operatorLabelOf?.(principal.session.id)?.trim()
  return label ? [`session-label://${label}`] : []
}

function grantRequest(principal: Principal, policy: PermissionPolicy, ctx: PermissionContext) {
  return {
    principals: policyPrincipals(principal, policy, ctx),
    ...(policy.now !== undefined ? { now: policy.now } : {}),
    ...(policy.resolveSelector ? { resolveSelector: policy.resolveSelector } : {}),
    ...(policy.evaluateCondition ? { evaluateCondition: policy.evaluateCondition } : {}),
  }
}

function describeGrantSource(d: GrantDecision): string {
  return d.inputIndex === undefined
    ? "a policy grant"
    : `policy input ${d.inputIndex}${d.grantIndex !== undefined ? `, grant ${d.grantIndex}` : ""}`
}

/**
 * Does an AIP-38 explicit deny (or a policy that cannot be read) refuse a
 * `session:message` to the recipient? Only a deny counts: a policy allow
 * cannot admit a message, because the envelope needs a relation to carry.
 */
function messageRefusal(
  principal: Principal,
  recipient: MessageTreeNode,
  ctx: PermissionContext,
): { rule: string; reason: string } | undefined {
  const policy = ctx.policy
  if (!policy) return undefined
  const label = ctx.operatorLabelOf ? ctx.operatorLabelOf(recipient.id)?.trim() || null : undefined
  const workspace =
    ctx.workspaceOfCwd && recipient.cwd ? ctx.workspaceOfCwd(recipient.cwd)?.trim() || null : undefined
  try {
    const d = evaluateGrants(policy.inputs, {
      ...grantRequest(principal, policy, ctx),
      action: "session:message",
      scope: recipient.id,
      typed: { label, workspace },
    })
    return d.reason === "explicit-deny"
      ? {
          rule: "policy.explicit-deny",
          reason: `an explicit deny (${describeGrantSource(d)}) refuses session:message to "${recipient.id}"`,
        }
      : undefined
  } catch (err) {
    if (err instanceof PolicyGrantError) {
      return { rule: "policy.invalid", reason: `the policy grants cannot be read, so the send is refused: ${err.message}` }
    }
    throw err
  }
}

function decideTool(principal: Principal, resource: PermissionResource, ctx: PermissionContext, policy: PermissionPolicy): Decision {
  const base = { action: "tool.invoke" as const, authoritative: false }
  if (resource.kind !== "tool") {
    return mint({ ...base, allow: false, rule: "resource", reason: "tool.invoke needs a tool resource" })
  }
  const name = qualifyToolName(resource.name)
  try {
    const d = evaluateToolInvoke(policy.inputs, {
      ...grantRequest(principal, policy, ctx),
      tool: resource.name,
      ...(resource.implements !== undefined ? { implements: resource.implements } : {}),
    })
    const allow = d.decision === "allow"
    return mint({
      ...base,
      allow,
      resourceId: name,
      rule: allow ? (d.via === "default" ? "policy.default-allow" : "policy.matched-grant") : `policy.${d.reason}`,
      reason: allow
        ? `${name} is admitted by ${d.via === "default" ? "the composed policy default" : describeGrantSource(d)}`
        : d.reason === "explicit-deny"
          ? `an explicit deny (${describeGrantSource(d)}) refuses ${name}`
          : `no grant admits ${name} (${d.reason})`,
    })
  } catch (err) {
    if (err instanceof PolicyGrantError) {
      return mint({
        ...base,
        allow: false,
        resourceId: name,
        rule: "policy.invalid",
        reason: `the policy grants cannot be read, so the call is refused: ${err.message}`,
      })
    }
    throw err
  }
}

function decideMessage(
  principal: Principal,
  recipient: MessageTreeNode,
  ctx: PermissionContext,
): Decision {
  const relations = collectMessageRelations(principal, recipient, ctx)
  const verifiedMode = ctx.messaging?.peerBinding === "verified"
  const slugRelations =
    principal.kind === "session" && verifiedMode
      ? collectMessageRelations(principal, recipient, { ...ctx, messaging: { ...ctx.messaging, peerBinding: "slug" } })
      : relations
  const peerInvolved = relations.includes("peer") || slugRelations.includes("peer")
  const peerVerified =
    principal.kind === "session" && peerInvolved
      ? peerBindingStatus(principal.session, recipient, ctx) === "verified" ||
        (verifiedMode && relations.includes("peer"))
      : undefined
  const base = {
    action: "session.message" as const,
    authoritative: true,
    resourceId: recipient.id,
    relations,
    ...(peerVerified !== undefined ? { peerVerified } : {}),
  }
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
  // A matching AIP-38 deny removes only the grant-derived reasons (sibling,
  // peer); a tree edge, the operator and the system stay (AIP-46 rule 3).
  const candidates = RELATION_STRENGTH.filter(r => relations.includes(r)).map(r => ({ r, g: relationGrant(r, ctx) }))
  const refusal =
    principal.kind === "session" && relations.some(r => GRANT_DERIVED_RELATIONS.has(r))
      ? messageRefusal(principal, recipient, ctx)
      : undefined
  const granted = refusal ? candidates.filter(x => !GRANT_DERIVED_RELATIONS.has(x.r)) : candidates
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
  if (refusal && candidates.some(x => x.g.allow)) {
    return mint({ ...base, allow: false, relation: strongest(relations), rule: refusal.rule, reason: refusal.reason })
  }
  if (verifiedMode && slugRelations.includes("peer") && !relations.includes("peer")) {
    return mint({
      ...base,
      allow: false,
      relation: "peer",
      rule: "messaging.peerBinding",
      reason: "peers need a verified workspace binding (defaults.messaging.peerBinding: verified)",
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
  const r = checkSessionOwnerGate({
    callerSessionId,
    target: {
      id: target.id,
      ...(target.parentSessionId ? { parentSessionId: target.parentSessionId } : {}),
      ...(target.allowPromptFrom ? { allowPromptFrom: [...target.allowPromptFrom] } : {}),
    },
    tool: "session.drive",
    ...(ctx.parentOf ? { parentOf: ctx.parentOf } : {}),
    ...(ctx.operatorLabelOf ? { operatorLabelOf: ctx.operatorLabelOf } : {}),
  })
  return r.ok
    ? mint({
        ...base,
        allow: true,
        rule: "owner-gate",
        reason: callerSessionId ? "caller is the session, an ancestor, or granted by allowPromptFrom" : "the operator may drive any session",
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
    case "tool.invoke":
      if (context.policy) return decideTool(principal, resource, context, context.policy)
      return notRouted(action, recipient)
    default:
      return notRouted(action, recipient)
  }
}

function notRouted(action: PermissionAction, recipient: MessageTreeNode | undefined): Decision {
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
