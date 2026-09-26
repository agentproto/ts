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

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import type { OrchestratorScope } from "./orchestrator-gateway.js"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"
import {
  createSessionMessage,
  isMessageAllowed,
  messageFrom,
  resolveRelation,
  MESSAGE_KINDS,
  MESSAGE_URGENCIES,
  type MessageFilter,
  type MessageKind,
  type MessageUrgency,
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
  /** `defaults.messaging.allowSiblings` — sibling↔sibling messages. Off by
   *  default. */
  allowSiblings?: boolean
  /** `defaults.messaging.agentInterrupt: "allow"` — let a session sender's
   *  `interrupt` cancel the recipient's turn. Off by default (→ `steer`). */
  allowInterrupt?: boolean
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
    ...(m.correlationId ? { correlationId: m.correlationId } : {}),
    ...(m.delivered ? { delivered: m.delivered } : {}),
  }
}

export function registerMessageTools(server: McpServer, opts: RegisterMessageToolsOptions): void {
  const { registry, callerScope, callerSessionId, allowSiblings, allowInterrupt } = opts

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

  /** Shared send path for `message_send` / `message_reply`. */
  const send = async (
    tool: string,
    self: SessionDescriptor,
    toId: string,
    input: {
      text: string
      kind?: MessageKind
      urgency?: MessageUrgency
      replyTo?: string
      correlationId?: string
      data?: Record<string, unknown>
      from?: unknown
    },
  ): Promise<ToolResult> => {
    if (input.from !== undefined) {
      return fail("from_not_settable", `${tool}: \`from\` is not settable — the daemon attests the sender.`)
    }
    const recipient = registry.get(toId)
    if (!recipient) return fail("no_such_session", `${tool}: session "${toId}" does not exist.`)
    const relation = resolveRelation(self, recipient)
    if (!isMessageAllowed(relation, { allowSiblings })) {
      return fail(
        "forbidden_recipient",
        `${tool}: "${toId}" is not a tree neighbour you may message ` +
          `(allowed: your parent, your direct children` +
          `${allowSiblings ? ", your siblings" : ""}).`,
      )
    }
    const kind = input.kind ?? "report"
    const urgency = input.urgency ?? defaultUrgencyForKind(kind)
    let msg: SessionMessage
    try {
      msg = createSessionMessage({
        to: recipient.id,
        from: messageFrom(self, relation),
        text: input.text,
        kind,
        urgency,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
      })
    } catch (err) {
      return fail("invalid_message", `${tool}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const provenance = `${relation}:${self.id}`
    try {
      const r = await registry.sendMessage(msg, {
        source: provenance,
        origin: provenance,
        ...(allowInterrupt ? { allowInterrupt: true } : {}),
      })
      return ok({
        messageId: r.messageId,
        to: recipient.id,
        relation,
        delivered: r.delivered,
        queued: r.queued,
        urgencyApplied: r.urgencyApplied,
        ...(r.urgencyApplied !== urgency
          ? { note: `urgency "${urgency}" delivered as "${r.urgencyApplied}"` }
          : {}),
      })
    } catch (err) {
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
    "Send a typed message to a tree neighbour — `to: \"parent\"` or a session id " +
      "of your parent or one of your direct children. The daemon attests the sender " +
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
      const self = resolveCaller("message_send")
      if (isResult(self)) return self
      let toId = input.to
      if (toId === "parent") {
        if (!self.parentSessionId) {
          return fail("no_parent", "message_send: this session has no recorded parent.")
        }
        toId = self.parentSessionId
      }
      return send("message_send", self, toId, input)
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
      if (isResult(self)) return self
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
      "too. History stays in your transcript.",
    {
      ids: z
        .union([z.literal("all"), z.array(z.string().min(1)).min(1)])
        .describe('Message ids to ack, or "all".'),
    },
    async input => {
      const self = resolveCaller("inbox_ack")
      if (isResult(self)) return self
      return ok(registry.ackInbox(self.id, input.ids))
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
      if (isResult(self)) return self
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
