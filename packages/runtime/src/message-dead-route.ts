/**
 * Dead-recipient route for `message.*` envelopes (delivery kernel, K5 twin).
 *
 * The sentinel and follow producers already hand a notice to the LIVE parent
 * when their target is dead (`sentinel-runtime.ts` `retargetToLiveParent`,
 * `session-follow.ts` retired-follower branch). The message producers
 * (`message_send` / `message_reply`, `POST /sessions/:id/messages`) had no
 * such route: a message to a killed child simply failed. This is the same
 * rule for them, behind the K6 funnel `delivery.apply.types["message.*"]`:
 *
 *   - the type (`message.<kind>`) is opted in, AND
 *   - `registry.sendMessage` refuses the recipient as not alive
 *     (status killed / exited / error, a lapsed external `cc:` row, a retired
 *     row), AND
 *   - the recipient is not superseded (a `continuedTo` successor keeps its
 *     own, more precise error) and has a parent that accepts the message.
 *
 * Then the same envelope goes to the parent with a `[for <recipient id>] `
 * prefix. In every other case the original error is rethrown: the flag off,
 * no parent, a dead parent, a superseded recipient all behave as before.
 */

import { shouldApplyDelivery, type DeliveryApplyConfig } from "@agentproto/delivery"

import type { Decision } from "./permissions.js"
import {
  SessionNotAliveError,
  SessionRetiredError,
  type SendMessageResult,
  type SessionDescriptor,
  type SessionsRegistry,
} from "./sessions.js"
import type { SessionMessage } from "./session-message.js"

type SendOptions = Parameters<SessionsRegistry["sendMessage"]>[1]

export interface DeadRouteResult {
  result: SendMessageResult
  /** True when the funnel opted this message type in (ledger `applied`). */
  applied: boolean
  /** The live parent that took the message instead of the dead recipient. */
  routedTo?: string
}

/** The text a routed message carries so the parent knows who it was for. */
export function deadRecipientPrefix(recipientId: string): string {
  return `[for ${recipientId}] `
}

export async function sendMessageWithDeadRecipientRoute(
  registry: Pick<SessionsRegistry, "sendMessage" | "get">,
  msg: SessionMessage,
  opts: SendOptions,
  apply: DeliveryApplyConfig | undefined,
  /** The `session.message` decision for the PARENT, evaluated by the caller
   *  with the same principal and policy as the original send. The route is
   *  taken only when it allows: a sender never reaches, through a dead
   *  child, a session it could not message directly. */
  decideForParent?: (parent: SessionDescriptor) => Decision,
): Promise<DeadRouteResult> {
  const applied = shouldApplyDelivery(apply, `message.${msg.kind ?? "message"}`)
  if (!applied) {
    return { result: await registry.sendMessage(msg, opts), applied: false }
  }
  try {
    return { result: await registry.sendMessage(msg, opts), applied: true }
  } catch (err) {
    if (!(err instanceof SessionNotAliveError)) throw err
    if (err instanceof SessionRetiredError && err.continuedTo) throw err
    const parentId = registry.get(msg.to)?.parentSessionId
    if (!parentId || parentId === msg.to) throw err
    const parent = registry.get(parentId)
    if (!parent) throw err
    // The decision made for the original recipient does not carry over to a
    // different session: re-decide for the parent, and refuse the route when
    // the sender could not have messaged it directly.
    // The interrupt grant is per recipient too: it is dropped, so an
    // `interrupt` to the parent degrades to `steer`.
    const { decision: _decision, allowInterrupt: _interrupt, ...rest } = opts ?? {}
    void _decision
    void _interrupt
    const parentDecision = decideForParent?.(parent)
    if (decideForParent && !parentDecision?.allow) throw err
    const parentOpts: SendOptions = { ...rest, ...(parentDecision ? { decision: parentDecision } : {}) }
    const forwarded: SessionMessage = {
      ...msg,
      to: parentId,
      text: `${deadRecipientPrefix(msg.to)}${msg.text}`,
    }
    try {
      const result = await registry.sendMessage(forwarded, parentOpts)
      return { result, applied: true, routedTo: parentId }
    } catch (parentErr) {
      if (parentErr instanceof SessionNotAliveError) throw err
      throw parentErr
    }
  }
}
