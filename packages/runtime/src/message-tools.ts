/**
 * Typed inter-session messaging tools (AIP-46 §Session messages):
 * `message_send`, `message_reply`, `inbox_list`, `inbox_ack`, `inbox_wait`.
 * (`message_parent`, the original child→parent report tool, lives in
 * agent-tools.ts and routes through the same `registry.sendMessage`.)
 *
 * None of these is a delegation tool: they reach only tree neighbours
 * (child↔parent; siblings when `allowSiblings`) and grant no control over
 * the recipient. None takes a sender field — `from` is computed from the
 * gateway-verified caller identity and the session tree.
 */

import { homedir } from "node:os"
import { join } from "node:path"

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import type { Grant } from "@agentproto/policy"

import { DELIVERY_LEDGER_FILE, appendLedgerLine } from "@agentproto/delivery/ledger-writer"
import {
  shadowDeliveryGrant,
  type DeliveryApplyConfig,
  type Level,
} from "@agentproto/delivery"

import { sendMessageWithDeadRecipientRoute } from "./message-dead-route.js"
import { buildMessagingPermissionContext } from "./messaging-context.js"
import type { OrchestratorScope } from "./orchestrator-gateway.js"
import { SessionRetiredError, retiredErrorWire, type SessionDescriptor, type SessionsRegistry } from "./sessions.js"
import { ANONYMOUS_SEND_RULE, REPLY_RULE, decide, type PermissionContext } from "./permissions.js"
import { warnPeerUnverified } from "./workspace-binding.js"
import {
  createSessionMessage,
  messageFrom,
  MESSAGE_KINDS,
  MESSAGE_URGENCIES,
  type MessageFilter,
  type MessageKind,
  type MessageUrgency,
  replyToUnverifiedSenderPrefix,
  unverifiedSenderPrefix,
  type SessionMessage,
} from "./session-message.js"

/** `inbox_wait` bounds — stays under the MCP request timeout, like
 *  `session_monitor` (orchestration-tools.ts). */
export const INBOX_WAIT_MIN_MS = 1_000
export const INBOX_WAIT_MAX_MS = 49_000
export const INBOX_WAIT_DEFAULT_MS = 25_000

/** Kind → default urgency when the caller leaves it unset. A blocker or a
 *  question wants the recipient's attention inside its current turn
 *  (`steer`); everything else waits for the turn to end. */
export function defaultUrgencyForKind(kind: MessageKind): MessageUrgency {
  return kind === "blocker" || kind === "question" ? "steer" : "next-turn"
}

export interface RegisterMessageToolsOptions {
  registry: SessionsRegistry
  callerScope?: OrchestratorScope
  callerSessionId?: string
  /** `defaults.messaging.allowSiblings` - sibling↔sibling messages. Off by
   *  default. */
  allowSiblings?: boolean
  /** `defaults.messaging.allowSameWorkspace` - a session may message any
   *  other session of the SAME workspace, even without a tree edge. On by
   *  default. */
  allowSameWorkspace?: boolean
  /** `defaults.messaging.peerGroups` - groups of workspace slugs. A session
   *  may message any other session whose workspace slug sits in the SAME
   *  group, even without a tree edge and even when the same-workspace
   *  allowance is off. Empty (the default) = no cross-workspace link. */
  peerGroups?: readonly (readonly string[])[]
  /** `defaults.messaging.grants` - explicit AIP-38 `session:message` grants.
   *  A matching allow admits a pair the tree and switches refuse. */
  messagingGrants?: readonly Grant[]
  /** `defaults.messaging.peerBinding` - "slug" (default) or "verified". */
  peerBinding?: "slug" | "verified"
  /** cwd to registered workspace slug, for the verified peer binding. */
  workspaceOfCwd?: (cwd: string) => string | undefined
  /** `defaults.messaging.agentInterrupt: "allow"` — let a session sender's
   *  `interrupt` cancel the recipient's turn. Off by default (→ `steer`). */
  allowInterrupt?: boolean
  /** `defaults.messaging.anonymousSend` - "label" (default) or "block". */
  anonymousSend?: "block" | "label"
  /** `mcp.noCallerIdentity` — how a call with no caller identity is handled.
   *  `block` (default) keeps the refusal; `accept` lets an identity-less
   *  `message_send` go out as the anonymous `claude-code` sender; `ask`
   *  parks that send on a human approval. */
  noCallerIdentity?: "block" | "ask" | "accept"
  /** `ask` mode: raise a human approval for an identity-less send and
   *  resolve true only when it is approved. Absent ⇒ `ask` degrades to the
   *  `block` refusal (reported in the error text). */
  requestAnonymousMessageApproval?: (detail: AnonymousMessageApprovalDetail) => Promise<boolean>
  /** `delivery.apply` (K6 funnel). A `message.*` type opted in routes a
   *  message to a dead recipient to its live parent. Absent = off. */
  deliveryApply?: DeliveryApplyConfig
  /** Delivery ledger file for the lines the funnel writes (tests). Default
   *  `<AGENTPROTO_HOME or ~/.agentproto>/delivery-ledger.jsonl`. */
  ledgerPath?: string
}

/** What an `ask` approval gate is asked to allow. */
export interface AnonymousMessageApprovalDetail {
  to: string
  text: string
  kind: MessageKind
  urgency: MessageUrgency
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

const ok = (body: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: true, ...body }) }],
})
const fail = (code: string, text: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: false, error: code, message: text }) }],
  isError: true,
})

const failRetired = (err: SessionRetiredError): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: false, ...retiredErrorWire(err) }) }],
  isError: true,
})

const kindField = z.enum(MESSAGE_KINDS as [MessageKind, ...MessageKind[]])
const urgencyField = z.enum(MESSAGE_URGENCIES as [MessageUrgency, ...MessageUrgency[]])
/** A send request can never set the sender — the daemon attests it. Present
 *  in the schema only so a caller that tries is REJECTED (see `send`), not
 *  silently stripped. (`z.unknown()`, not `z.undefined()`: the latter has no
 *  JSON Schema form and would break `tools/list` for the whole gateway.) */
const noFromField = z
  .unknown()
  .optional()
  .describe("Not settable — leave it out: the daemon attests the sender from your session identity.")

/** Compact wire view of a message for tool results. */
function view(m: SessionMessage): Record<string, unknown> {
  return {
    id: m.id,
    ts: m.ts,
    from: m.from,
    kind: m.kind,
    urgency: m.urgency,
    text: m.text,
    ...(m.data !== undefined ? { data: m.data } : {}),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    ...(m.replyAddress ? { replyAddress: m.replyAddress } : {}),
    ...(m.correlationId ? { correlationId: m.correlationId } : {}),
    ...(m.delivered ? { delivered: m.delivered } : {}),
  }
}

export function registerMessageTools(server: McpServer, opts: RegisterMessageToolsOptions): void {
  const { registry, callerScope, callerSessionId, allowSiblings, allowInterrupt } = opts
  /** `defaults.messaging.allowSameWorkspace` - ON unless the operator turned
   *  it off. */
  const allowSameWorkspace = opts.allowSameWorkspace !== false
  /** `defaults.messaging.peerGroups` - the operator's workspace families.
   *  Empty (the default) = no cross-workspace link. */
  const peerGroups = opts.peerGroups ?? []
  /** `defaults.messaging.anonymousSend` - "label" unless the operator set "block". */
  const anonymousSendMode: "block" | "label" = opts.anonymousSend ?? "label"
  // One shared messaging context (messaging-context.ts) so the tools,
  // `POST /sessions/:id/messages` and `permissions_explain` cannot drift.
  const basePolicy: PermissionContext = buildMessagingPermissionContext({
    defaults: {
      allowSiblings: allowSiblings === true,
      allowSameWorkspace,
      peerGroups,
      peerBinding: opts.peerBinding ?? "slug",
      agentInterrupt: allowInterrupt ? "allow" : "deny",
      anonymousSend: anonymousSendMode,
      grants: opts.messagingGrants ?? [],
    },
    registry,
    ...(opts.workspaceOfCwd ? { workspaceOfCwd: opts.workspaceOfCwd } : {}),
  })

  /** The verified caller, or a tool error explaining why there's none. */
  const resolveCaller = (tool: string): SessionDescriptor | ToolResult => {
    const selfId = callerScope?.ownerSessionId ?? callerSessionId
    if (!selfId) {
      return fail(
        "no_caller_identity",
        `${tool}: cannot identify the calling session — this tool needs gateway ` +
          "access attributed to a session (a scoped orchestrator gateway, or a " +
          "daemon `/mcp` URL carrying `?callerSessionId=`).",
      )
    }
    const self = registry.get(selfId)
    if (!self) return fail("no_caller_identity", `${tool}: calling session "${selfId}" is not in the registry.`)
    return self
  }
  const isResult = (v: unknown): v is ToolResult =>
    typeof v === "object" && v !== null && "content" in v

  const noCallerIdentity = opts.noCallerIdentity ?? "block"
  /** The id this gateway was told about, if any (absence is the
   *  identity-less case `noCallerIdentity` governs). */
  const rawCallerId = callerScope?.ownerSessionId ?? callerSessionId

  /** `cc:<id>` is always a declared address; any other value that names a
   *  live session is one too; `msg_*` stays a message thread id. Anything
   *  else is rejected rather than silently reinterpreted. */
  const classifyReplyTo = (
    value: string,
    tool: string,
  ): { replyTo?: string; replyAddress?: string } | ToolResult => {
    if (value.startsWith("msg_")) return { replyTo: value }
    const declared = /^(?:cc:)?[A-Za-z0-9._-]{1,128}$/.test(value)
    if ((declared && value.startsWith("cc:")) || registry.get(value)) {
      return { replyAddress: value }
    }
    return fail(
      "invalid_reply_to",
      `${tool}: replyTo "${value}" is neither a message id (msg_…) nor a declared ` +
        "caller address (cc:<id> or a live session id).",
    )
  }

  /** An identity-less client asks to send under `accept`/`ask`: only
   *  `message_send` may act, and always as the anonymous `claude-code`
   *  sender — never as a session. */
  const anonymousSend = async (
    tool: string,
    toId: string,
    input: {
      text: string
      kind?: MessageKind
      urgency?: MessageUrgency
      replyTo?: string
      replyAddress?: string
      correlationId?: string
      data?: Record<string, unknown>
      from?: unknown
    },
  ): Promise<ToolResult> => {
    if (noCallerIdentity === "block") {
      return fail(
        "no_caller_identity",
        `${tool}: cannot identify the calling session. Config \`mcp.noCallerIdentity\` ` +
          "is \"block\"; set it to \"accept\" (or \"ask\") to allow an anonymous send.",
      )
    }
    const kind = input.kind ?? "report"
    const urgency = input.urgency ?? defaultUrgencyForKind(kind)
    if (noCallerIdentity === "ask") {
      const request = opts.requestAnonymousMessageApproval
      if (!request) {
        return fail(
          "no_caller_identity",
          `${tool}: config \`mcp.noCallerIdentity\` is \"ask\", but no approval channel ` +
            "is wired into this gateway; the send is refused.",
        )
      }
      let approved = false
      try {
        approved = await request({ to: toId, text: input.text, kind, urgency })
      } catch {
        approved = false
      }
      if (!approved) {
        return fail(
          "anonymous_not_approved",
          `${tool}: an identity-less send to "${toId}" was not approved.`,
        )
      }
    }
    return send(tool, undefined, toId, { ...input, kind, urgency }, true)
  }

  /** What an `accept` reader can do instead of reading a nonexistent inbox. */
  const anonymousReadHint = (tool: string): ToolResult =>
    ok({
      messages: [],
      anonymous: true,
      hint:
        `${tool}: this caller has no session identity, so it has no inbox to read. ` +
        "To receive replies, pass your own session id as `replyTo` on `message_send` " +
        "(cc:<id> or the session id) so the recipient knows where to address a reply; " +
        "read your inbox through your harness hook instead.",
    })

  /** One ledger line per funnel-applied send (the producer is `message`; the
   *  target stays the addressed session, `routedTo` names the parent that
   *  took it). Nothing is written while the funnel is off. */
  const writeFunnelLedger = (
    msg: SessionMessage,
    self: SessionDescriptor | undefined,
    targetId: string,
    r: { queued: boolean; delivered: { via: string } | null; refused?: "inbox-full" },
    routedTo: string | undefined,
  ): void => {
    const level: Level = msg.urgency === "fyi" ? 1 : msg.urgency === "next-turn" ? 2 : 3
    const outcome =
      r.refused !== undefined
        ? "dropped"
        : routedTo !== undefined
          ? "retargeted"
          : r.queued
            ? "queued"
            : r.delivered?.via === "inbox"
              ? "inbox"
              : "delivered"
    appendLedgerLine(
      opts.ledgerPath ??
        join(process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto"), DELIVERY_LEDGER_FILE),
      {
        ts: new Date().toISOString(),
        producer: "message",
        subscriptionId: "message:tool",
        target: { kind: "session", id: targetId },
        eventId: msg.id,
        type: `message.${msg.kind ?? "message"}`,
        subject: self?.id ?? "claude-code",
        level,
        cap: 3,
        rule: "sender-urgency",
        applied: true,
        grant: shadowDeliveryGrant({ producer: {}, subject: self?.id ?? "claude-code", target: targetId }),
        outcome,
        ...(routedTo !== undefined ? { routedTo } : {}),
        messageId: msg.id,
      },
    )
  }

  /** Shared send path for `message_send` / `message_reply`. */
  const send = async (
    tool: string,
    self: SessionDescriptor | undefined,
    toId: string,
    input: {
      text: string
      kind?: MessageKind
      urgency?: MessageUrgency
      replyTo?: string
      replyAddress?: string
      correlationId?: string
      data?: Record<string, unknown>
      from?: unknown
    },
    anonymous = false,
  ): Promise<ToolResult> => {
    if (input.from !== undefined) {
      return fail("from_not_settable", `${tool}: \`from\` is not settable — the daemon attests the sender.`)
    }
    const recipient = registry.get(toId)
    if (!recipient) return fail("no_such_session", `${tool}: session "${toId}" does not exist.`)
    // A reply to a message the caller received is admitted whatever the
    // relation (permissions.ts REPLY_RULE); the context carries the lookup.
    const policy: PermissionContext =
      self && input.replyTo?.startsWith("msg_")
        ? {
            ...basePolicy,
            reply: {
              messageId: input.replyTo,
              originalSenderOf: (id, mid) => registry.findReceivedMessage(id, mid)?.from.sessionId,
            },
          }
        : basePolicy
    // One ACL for every messaging entry point (permissions.ts). An
    // identity-less caller is evaluated as the operator/human principal,
    // which is what it already is on the wire (the same principal an
    // unauthenticated local `/mcp` operator call gets); it is never any
    // session and never gains a session's grants.
    const principal = self
      ? ({ kind: "session", session: self } as const)
      : ({ kind: "operator", via: "anonymous-local" } as const)
    const resource = { kind: "session", session: recipient } as const
    const decision = decide(principal, "session.message", resource, policy)
    /** The message answers one the caller received from this recipient: it never interrupts. */
    const answersReceived =
      self !== undefined && policy.reply?.originalSenderOf(self.id, policy.reply.messageId) === recipient.id
    /** The message being answered came from an unverified/anonymous sender: label the reply too. */
    const originalFrom =
      answersReceived && self && input.replyTo ? registry.findReceivedMessage(self.id, input.replyTo)?.from : undefined
    const originalUnverified = originalFrom?.unverified === true || originalFrom?.anonymous === true
    const replyToUnverified = self !== undefined && decision.rule === REPLY_RULE && originalUnverified
    const relation = decision.relation
    if (self && decision.allow && decision.relation === "granted" && decision.peerVerified === false) {
      warnPeerUnverified({
        senderId: self.id,
        recipientId: recipient.id,
        slug: self.workspaceSlug,
        rule: decision.rule,
      })
    }
    if (!decision.allow || !relation) {
      return fail(
        "forbidden_recipient",
        `${tool}: "${toId}" is not a tree neighbour you may message ` +
          `(allowed: your parent, your direct children` +
          `${allowSiblings ? ", your siblings" : ""}` +
          `${allowSameWorkspace ? ", or any session in your workspace that is not a tree sibling" : ""}` +
          `${peerGroups.length > 0 ? ", or any session in a workspace of your peer groups" : ""}). ` +
          `The same-workspace allowance is config \`defaults.messaging.allowSameWorkspace\` ` +
          `(currently ${allowSameWorkspace}); the cross-workspace allowance is config ` +
          `\`defaults.messaging.peerGroups\` (currently ${
            peerGroups.length > 0 ? `${peerGroups.length} group(s)` : "no group"
          }).`,
      )
    }
    const kind = input.kind ?? "report"
    const urgency = input.urgency ?? defaultUrgencyForKind(kind)
    // `defaults.messaging.anonymousSend: "label"`: an identity-less caller, or
    // a session sender admitted only because its identity is unverified, is
    // delivered with a visible text prefix and capped at steer. "block"
    // leaves an anonymous sender exactly as before (operator principal).
    const labelled =
      anonymousSendMode === "label" && (self
        ? decision.rule === ANONYMOUS_SEND_RULE || replyToUnverified
        : anonymous)
    let msg: SessionMessage
    try {
      msg = createSessionMessage({
        to: recipient.id,
        from: self
          ? messageFrom(self, relation)
          : { relation: "human", label: "claude-code", anonymous: true },
        text: labelled
          ? (replyToUnverified
              ? replyToUnverifiedSenderPrefix(originalFrom?.label ?? originalFrom?.sessionId)
              : unverifiedSenderPrefix(self ? (self.label ?? self.id) : "claude-code")) + input.text
          : input.text,
        kind,
        urgency,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.replyAddress ? { replyAddress: input.replyAddress } : {}),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
      })
    } catch (err) {
      return fail("invalid_message", `${tool}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const provenance = self ? `${relation}:${self.id}` : "anonymous:claude-code"
    try {
      const interrupt = decide(principal, "session.message.interrupt", resource, policy)
      const routed = await sendMessageWithDeadRecipientRoute(
        registry,
        msg,
        {
          source: provenance,
          origin: provenance,
          decision,
          ...(interrupt.allow && !labelled && !answersReceived ? { allowInterrupt: true } : {}),
        },
        opts.deliveryApply,
        parent => decide(principal, "session.message", { kind: "session", session: parent } as const, policy),
      )
      const r = routed.result
      if (routed.applied) writeFunnelLedger(msg, self, recipient.id, r, routed.routedTo)
      return ok({
        messageId: r.messageId,
        to: routed.routedTo ?? recipient.id,
        ...(routed.routedTo ? { routedFrom: recipient.id } : {}),
        relation,
        delivered: r.delivered,
        queued: r.queued,
        urgencyApplied: r.urgencyApplied,
        ...(r.wake ? { wake: r.wake } : {}),
        ...(anonymous ? { anonymous: true, from: "claude-code" } : {}),
        ...(labelled
          ? {
              ...(replyToUnverified ? { replyToUnverified: true } : { unverified: true }),
              note: `${
                replyToUnverified
                  ? "delivered as a reply to an unverified sender: the recipient sees the original sender as unverified"
                  : "delivered unverified: the recipient sees the sender as unverified"
              } and the urgency is capped at steer${
                r.urgencyApplied !== urgency ? ` ("${urgency}" delivered as "${r.urgencyApplied}")` : ""
              }`,
            }
          : {}),
        ...(decision.rule === REPLY_RULE && recipient.kind === "external"
          ? {
              replyNote: `reply delivered to the external row "${recipient.id}" (its inbox/hook); a shared identity does not record which real session sent the original`,
            }
          : {}),
        ...(!labelled && r.urgencyApplied !== urgency
          ? { note: `urgency "${urgency}" delivered as "${r.urgencyApplied}"` }
          : {}),
      })
    } catch (err) {
      if (err instanceof SessionRetiredError) return failRetired(err)
      return fail("not_delivered", `${tool}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const payloadShape = {
    text: z.string().min(1).describe("The message body (plain text)."),
    kind: kindField
      .optional()
      .describe("report (default) | question | blocker | done | notice."),
    urgency: urgencyField
      .optional()
      .describe(
        "fyi (inbox only, never wakes the recipient) | next-turn (queued behind its " +
          "current turn) | steer (injected into its running turn when its agent " +
          "supports that, else next-turn) | interrupt (cancels its turn — only if the " +
          "operator allows it, else steer). Default: steer for blocker/question, " +
          "next-turn otherwise. The result reports the tier actually applied.",
      ),
    data: z.record(z.string(), z.unknown()).optional().describe("Optional structured payload (≤ 16 KB JSON)."),
    from: noFromField,
  }

  server.tool(
    "message_send",
    "Send a typed message to a tree neighbour - `to: \"parent\"` or a session id " +
      "of your parent or one of your direct children - or, while the operator leaves " +
      "`defaults.messaging.allowSameWorkspace` on (the default), to any session of " +
      "your own workspace, or to any session whose workspace sits in the same " +
      "`defaults.messaging.peerGroups` group as yours. The daemon attests the sender " +
      "(you) in the header the recipient sees; you never set it. Not a delegation " +
      "tool: it reaches only neighbours and grants no control. If the recipient is " +
      "blocked in `inbox_wait` it gets the message as that call's result; otherwise " +
      "it lands in its inbox and — unless `fyi` — arrives as its own turn.",
    {
      to: z.string().min(1).describe('"parent", or the recipient session id.'),
      ...payloadShape,
      replyTo: z.string().optional().describe("Id of the message this answers."),
      correlationId: z.string().optional().describe("Thread id (defaults to the first message's id)."),
    },
    async input => {
      const routed = input.replyTo !== undefined ? classifyReplyTo(input.replyTo, "message_send") : {}
      if (isResult(routed)) return routed
      const self = resolveCaller("message_send")
      if (isResult(self)) {
        // A known-caller-descriptor failure is a real refusal; only an
        // ABSENT identity is the case `mcp.noCallerIdentity` governs.
        if (rawCallerId) return self
        if (input.to === "parent") {
          return fail("no_parent", "message_send: this caller has no parent session.")
        }
        return anonymousSend("message_send", input.to, { ...input, ...routed })
      }
      let toId = input.to
      if (toId === "parent") {
        if (!self.parentSessionId) {
          return fail("no_parent", "message_send: this session has no recorded parent.")
        }
        toId = self.parentSessionId
      }
      return send("message_send", self, toId, { ...input, ...routed })
    },
  )

  server.tool(
    "message_reply",
    "Reply to a message you received (by its id): routed back to the original " +
      "sender, threaded on the same correlationId.",
    {
      replyTo: z.string().min(1).describe("Id of the message you're answering (msg_…)."),
      ...payloadShape,
    },
    async input => {
      const self = resolveCaller("message_reply")
      if (isResult(self)) return self
      const original = registry.findReceivedMessage(self.id, input.replyTo)
      if (!original) {
        return fail("unknown_message", `message_reply: you never received message "${input.replyTo}".`)
      }
      if (!original.from.sessionId) {
        return fail(
          "no_reply_route",
          `message_reply: "${input.replyTo}" came from the ${original.from.relation}, not a session — there is no one to route a reply to.`,
        )
      }
      return send("message_reply", self, original.from.sessionId, {
        ...input,
        correlationId: original.correlationId ?? original.id,
      })
    },
  )

  const filterShape = {
    from: z
      .union([z.literal("children"), z.array(z.string().min(1))])
      .optional()
      .describe('Sender session ids, or "children" for any of your direct children.'),
    kind: z.array(kindField).optional().describe("Only these kinds."),
    correlationId: z.string().optional().describe("Only this thread."),
  }
  const toFilter = (input: {
    from?: "children" | string[]
    kind?: MessageKind[]
    correlationId?: string
  }): MessageFilter => ({
    ...(input.from ? { from: input.from } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  })

  server.tool(
    "inbox_list",
    "List the messages waiting in your inbox (not yet consumed by a turn, an " +
      "`inbox_wait`, or `inbox_ack`), oldest first. Reading does not ack.",
    {
      ...filterShape,
      limit: z.number().int().min(1).max(200).optional().describe("Newest N only."),
    },
    async input => {
      const self = resolveCaller("inbox_list")
      if (isResult(self)) {
        if (!rawCallerId && noCallerIdentity === "accept") return anonymousReadHint("inbox_list")
        return self
      }
      const msgs = registry.listInbox(self.id, {
        ...toFilter(input),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      })
      return ok({ messages: (msgs ?? []).map(view) })
    },
  )

  server.tool(
    "inbox_ack",
    "Acknowledge (remove) messages from your inbox — by id, or \"all\". An acked " +
      "message still waiting to be delivered as a turn is dropped from that queue " +
      "too. History stays in your transcript. Set `noop: true` when you looked and " +
      "there is nothing to do: it lets the host record this wake as a silent turn " +
      "instead of mistaking your ack for work.",
    {
      ids: z
        .union([z.literal("all"), z.array(z.string().min(1)).min(1)])
        .describe('Message ids to ack, or "all".'),
      noop: z
        .boolean()
        .optional()
        .describe(
          'Set true when you looked and there is nothing to do. Only meaningful ' +
            'when this call actually acks at least one message; the host records ' +
            'it, never the message text.',
        ),
    },
    async input => {
      const self = resolveCaller("inbox_ack")
      if (isResult(self)) {
        if (!rawCallerId && noCallerIdentity === "accept") {
          const read = anonymousReadHint("inbox_ack")
          return ok({ ...JSON.parse(read.content[0]!.text), acked: [], noop: input.noop === true })
        }
        return self
      }
      const noop = input.noop === true
      const before = noop ? (registry.listInbox(self.id) ?? []) : []
      const result = registry.ackInbox(self.id, input.ids)
      if (noop && result.acked.length > 0) {
        const acked = new Set(result.acked)
        registry.recordNoopAck(self.id, before.filter(m => acked.has(m.id)))
      }
      return ok(result)
    },
  )

  server.tool(
    "inbox_wait",
    "Block until a message matching the filter arrives (returns at once if one is " +
      "already in your inbox), or the timeout passes. Use it to supervise children " +
      "WITHOUT ending your turn: loop `inbox_wait` until `pendingChildren` is empty. " +
      "Matching messages are returned here and never also injected as a turn. " +
      `timeoutMs ${INBOX_WAIT_MIN_MS}–${INBOX_WAIT_MAX_MS} (default ${INBOX_WAIT_DEFAULT_MS}).`,
    {
      ...filterShape,
      timeoutMs: z
        .number()
        .int()
        .min(INBOX_WAIT_MIN_MS)
        .max(INBOX_WAIT_MAX_MS)
        .optional()
        .describe(`Max wait, ms (default ${INBOX_WAIT_DEFAULT_MS}).`),
      ack: z.boolean().optional().describe("Ack returned messages (default true)."),
    },
    async (input, extra) => {
      const self = resolveCaller("inbox_wait")
      if (isResult(self)) {
        if (!rawCallerId && noCallerIdentity === "accept") {
          const read = anonymousReadHint("inbox_wait")
          return ok({ ...JSON.parse(read.content[0]!.text), timedOut: false, pendingChildren: [] })
        }
        return self
      }
      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal
      const r = await registry.waitForMessages(self.id, toFilter(input), {
        timeoutMs: input.timeoutMs ?? INBOX_WAIT_DEFAULT_MS,
        ...(input.ack !== undefined ? { ack: input.ack } : {}),
        ...(signal ? { signal } : {}),
      })
      // Children still working — so a supervising loop knows when to stop.
      const pendingChildren = registry
        .list()
        .filter(
          d =>
            d.parentSessionId === self.id &&
            (d.status === "starting" || (d.status === "running" && d.busy === true)),
        )
        .map(d => d.id)
      return ok({ messages: r.messages.map(view), timedOut: r.timedOut, pendingChildren })
    },
  )
}
