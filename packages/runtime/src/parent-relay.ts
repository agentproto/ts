/**
 * PARENT RELAY: reporting UP from inside a box (E2B / computer-use) to a
 * parent session that lives in the HOST daemon's registry.
 *
 * The problem (see `docs/lineage-handover.md`, section "Known gap - sessions
 * running INSIDE a box"): a session spawned inside a sandbox box runs
 * against the BOX daemon's own registry. The parent lives in the HOST
 * daemon's registry, so the box row has no `parentSessionId` and
 * `message_parent` fails with "no recorded parent".
 *
 * The mechanism implemented here is the DESIGN's push channel:
 *
 *  1. HOST: at spawn time the host knows the parent session id and the box
 *     session's own host-side proxy row. It mints a SHORT-LIVED,
 *     SINGLE-SESSION-SCOPED token bound to that pair and forwards
 *     `{ sessionId, url, token }` (a "remote parent") into the box's own
 *     `agent_start` (see `session-spawn.ts`'s `bootSandboxAgentSession`).
 *     The box stores it on its row as `remoteParent` instead of
 *     `parentSessionId`.
 *  2. BOX: `message_parent` sees the remote parent and POSTs the envelope
 *     to the host's relay endpoint instead of looking the parent up in the
 *     box registry. The payload carries only the message itself - never the
 *     recipient.
 *  3. HOST: the relay endpoint authenticates the token, resolves the
 *     session ids FROM THE TOKEN (never from the payload) and delivers
 *     through the ordinary `registry.sendMessage` path - so the parent sees
 *     a normal `session-message`, with the same kind/urgency semantics.
 *
 * Reachability (design item 4) is the operator's job: the host's relay URL
 * must be reachable FROM the box (a tunnel / public endpoint). When no relay
 * URL is configured the host forwards NO remote parent, and the box's
 * `message_parent` keeps today's clear "no recorded parent" error.
 */

import { randomBytes } from "node:crypto"
import {
  createSessionMessage,
  messageFrom,
  type MessageKind,
  type MessageUrgency,
  type SessionMessage,
} from "./session-message.js"

/** The remote-parent block a host forwards into a box at spawn time. */
export interface RemoteParent {
  /** The HOST-side parent session id (the box registry never holds this row). */
  sessionId: string
  /** The host daemon's relay base URL (reachable FROM the box). */
  url: string
  /** Short-lived, single-session-scoped relay token. */
  token: string
}

/** What the box sends to the host's relay endpoint. The RECIPIENT is never
 *  in here - the host resolves it from the token. */
export interface ParentRelayPayload {
  message: string
  kind: MessageKind
  urgency: MessageUrgency
  replyTo?: string
}

/** The host-side record a relay token stands for. */
export interface ParentRelayGrant {
  token: string
  /** The host-side parent session the report is delivered to. */
  parentSessionId: string
  /** The host-side proxy row of the BOX session (the attested sender). */
  boxSessionId: string
  expiresAt: number
}

/** Header carrying the relay token on the box → host POST. */
export const PARENT_RELAY_TOKEN_HEADER = "x-agentproto-parent-relay"

/** The host's relay route. */
export const PARENT_RELAY_PATH = "/relay/parent-message"

/** Default token lifetime: one hour (a box session's parent report window). */
export const PARENT_RELAY_TTL_MS = 60 * 60 * 1000

/** Default timeout for the box → host relay POST, so an unreachable host can
 *  never block `message_parent` forever. */
export const PARENT_RELAY_TIMEOUT_MS = 15_000

/** Env var naming the host relay base URL (operator-provided reachability). */
export const PARENT_RELAY_URL_ENV = "AGENTPROTO_PARENT_RELAY_URL"

const grants = new Map<string, ParentRelayGrant>()

/** The configured host relay base URL, or `undefined` when the operator did
 *  not configure one (⇒ no remote parent is forwarded at all). */
export function parentRelayUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[PARENT_RELAY_URL_ENV]
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/\/+$/, "")
}

/** Mint a relay token for one (parent, box-session) pair and return the
 *  remote-parent block to forward into the box. */
export function mintParentRelayGrant(input: {
  parentSessionId: string
  boxSessionId: string
  url: string
  ttlMs?: number
  nowMs?: number
}): RemoteParent {
  const now = input.nowMs ?? Date.now()
  const token = randomBytes(24).toString("hex")
  grants.set(token, {
    token,
    parentSessionId: input.parentSessionId,
    boxSessionId: input.boxSessionId,
    expiresAt: now + (input.ttlMs ?? PARENT_RELAY_TTL_MS),
  })
  return {
    sessionId: input.parentSessionId,
    url: input.url.replace(/\/+$/, ""),
    token,
  }
}

/** Resolve a relay token to its grant, or `undefined` when the token is
 *  unknown or expired. Never throws - a bad token is a refusal, not a crash. */
export function resolveParentRelayGrant(
  token: string | undefined,
  nowMs: number = Date.now(),
): ParentRelayGrant | undefined {
  if (!token) return undefined
  const grant = grants.get(token)
  if (!grant) return undefined
  if (grant.expiresAt <= nowMs) {
    grants.delete(token)
    return undefined
  }
  return grant
}

/** Forget a grant (e.g. when the box session ends). */
export function revokeParentRelayGrant(token: string): void {
  grants.delete(token)
}

/** Test seam: drop every minted grant. */
export function clearParentRelayGrants(): void {
  grants.clear()
}

/** The minimal registry surface the relay needs (kept structural so this
 *  module stays free of a runtime dependency on `sessions.ts`). */
export interface ParentRelayRegistry {
  get(id: string):
    | {
        id: string
        parentSessionId?: string
        status: string
        label?: string
        role?: string
        adapterSlug?: string
      }
    | undefined
  sendMessage(
    envelope: SessionMessage,
    opts: { source: string; origin: string; allowInterrupt: boolean },
  ): Promise<{ messageId: string; queued: boolean; urgencyApplied: MessageUrgency; delivered?: { via: string } | null }>
}

export type ParentRelayDelivery =
  | "waited"
  | "steered"
  | "interrupted"
  | "enqueued"
  | "queued-next-turn"
  | "inbox"

export type ParentRelayResult =
  | { ok: true; messageId: string; delivery: ParentRelayDelivery; urgencyApplied: MessageUrgency }
  | { ok: false; code: string; message: string }

/** BOX side: POST the report to the host's relay endpoint. */
export async function postParentRelayMessage(
  remote: RemoteParent,
  payload: ParentRelayPayload,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<ParentRelayResult> {
  const doFetch = opts?.fetchImpl ?? fetch
  const url = `${remote.url.replace(/\/+$/, "")}${PARENT_RELAY_PATH}`
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PARENT_RELAY_TOKEN_HEADER]: remote.token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? PARENT_RELAY_TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => undefined)) as
      | {
          ok?: boolean
          messageId?: string
          delivery?: string
          urgencyApplied?: string
          error?: string
          message?: string
        }
      | undefined
    if (!res.ok || !body?.ok) {
      return {
        ok: false,
        code: body?.error ?? `relay_http_${res.status}`,
        message: body?.message ?? `the host relay answered ${res.status}`,
      }
    }
    return {
      ok: true,
      messageId: body.messageId ?? "",
      delivery: (body.delivery as ParentRelayDelivery) ?? "enqueued",
      urgencyApplied: (body.urgencyApplied as MessageUrgency) ?? payload.urgency,
    }
  } catch (err) {
    return {
      ok: false,
      code: "relay_unreachable",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/** HOST side: authenticate a relayed report and deliver it to the parent the
 *  token names - through the ordinary `registry.sendMessage` path, so the
 *  parent sees a normal `session-message` (same kind/urgency semantics). */
export async function deliverParentRelayMessage(input: {
  token: string | undefined
  payload: ParentRelayPayload
  registry: ParentRelayRegistry
  allowInterrupt?: boolean
  nowMs?: number
}): Promise<ParentRelayResult> {
  const grant = resolveParentRelayGrant(input.token, input.nowMs)
  if (!grant) {
    return {
      ok: false,
      code: "relay_token_unknown",
      message: "the relay token is unknown or expired",
    }
  }
  const parentId = grant.parentSessionId
  const parent = input.registry.get(parentId)
  if (!parent) {
    return {
      ok: false,
      code: "relay_parent_missing",
      message: `parent session "${parentId}" no longer exists`,
    }
  }
  if (parent.status !== "running" && parent.status !== "starting") {
    return {
      ok: false,
      code: "relay_parent_not_running",
      message: `parent session "${parentId}" is not running (status: ${parent.status})`,
    }
  }
  // The sender is the HOST-side proxy row of the box session - the row the
  // host already parented under `parentId`. The payload never names a
  // sender: the host attests it.
  const boxRow = input.registry.get(grant.boxSessionId)
  const envelope = createSessionMessage({
    to: parentId,
    from: messageFrom(boxRow ?? { id: grant.boxSessionId }, "child"),
    text: input.payload.message,
    kind: input.payload.kind,
    urgency: input.payload.urgency,
    ...(input.payload.replyTo ? { replyTo: input.payload.replyTo } : {}),
  })
  const provenance = `child:${grant.boxSessionId}`
  let result: Awaited<ReturnType<ParentRelayRegistry["sendMessage"]>>
  try {
    result = await input.registry.sendMessage(envelope, {
      source: provenance,
      origin: provenance,
      allowInterrupt: input.allowInterrupt === true,
    })
  } catch (err) {
    return {
      ok: false,
      code: "relay_delivery_failed",
      message: err instanceof Error ? err.message : String(err),
    }
  }
  const delivery: ParentRelayDelivery =
    result.delivered?.via === "wait"
      ? "waited"
      : result.delivered?.via === "steer"
        ? "steered"
        : result.delivered?.via === "interrupt"
          ? "interrupted"
          : !result.queued
            ? "enqueued"
            : "queued-next-turn"
  return {
    ok: true,
    messageId: result.messageId,
    delivery,
    urgencyApplied: result.urgencyApplied,
  }
}
