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
 *     The box stores the non-secret part on its row as `remoteParent`
 *     instead of `parentSessionId`; the TOKEN stays in memory (see
 *     `rememberRelayToken`) and never reaches a descriptor or the disk.
 *  2. BOX: `message_parent` sees the remote parent and POSTs the envelope
 *     to the host's relay endpoint instead of looking the parent up in the
 *     box registry. The payload carries only the message itself - never the
 *     recipient.
 *  3. HOST: the relay endpoint authenticates the token, resolves the
 *     session ids FROM THE TOKEN (never from the payload) and delivers
 *     through the ordinary `registry.sendMessage` path - so the parent sees
 *     a normal `session-message`, with the same kind/urgency semantics.
 *
 * Token lifecycle:
 *  - BOX: the raw token lives in memory only (never on a descriptor, a
 *    summary, a log or `sessions.json`). Nothing about it is persisted on
 *    the box: a box session does not outlive its box daemon, and a restarted
 *    box session gets a FRESH token from the host's restart path.
 *  - HOST: only the token's SHA-256 hash is kept, in memory and in
 *    `parent-relay-grants.json` (0600, next to the sessions registry's
 *    state), reloaded at boot so a host daemon restart keeps live relays.
 *  - A grant SLIDES on every successful use and is RENEWED by the periodic
 *    sweep while both its sessions are live; it is REVOKED when the box
 *    session or the parent ends / is archived / is forgotten, when the box
 *    boot fails, and by the sweep once either session is dead. Expired
 *    grants are pruned.
 *
 * Reachability (design item 4) is the operator's job: the host's relay URL
 * must be reachable FROM the box (a tunnel / public endpoint). When no relay
 * URL is configured the host forwards NO remote parent, and the box's
 * `message_parent` keeps today's clear "no recorded parent" error.
 */

import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
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

/** The host-side record a relay token stands for.
 *
 *  The host never keeps the RAW token: it stores (in memory and on disk) only
 *  its SHA-256 hash, so a leaked grants file cannot be replayed against the
 *  relay route. The raw token exists only in the mint result (forwarded once
 *  into the box) and in the box's own memory. */
export interface ParentRelayGrant {
  /** SHA-256 (hex) of the relay token - see {@link hashParentRelayToken}. */
  tokenHash: string
  /** The host-side parent session the report is delivered to. */
  parentSessionId: string
  /** The host-side proxy row of the BOX session (the attested sender). */
  boxSessionId: string
  expiresAt: number
  /** The grant's own lifetime - reused to SLIDE the expiry on every
   *  successful relay use (see `slideParentRelayGrant`). */
  ttlMs: number
}

/** Header carrying the relay token on the box → host POST. */
export const PARENT_RELAY_TOKEN_HEADER = "x-agentproto-parent-relay"

/** The host's relay route. */
export const PARENT_RELAY_PATH = "/relay/parent-message"

/** Default token lifetime: one hour (a box session's parent report window).
 *
 *  The lifetime SLIDES: every successful relay use pushes the expiry out by
 *  one more TTL, so a box session that keeps reporting is never cut off
 *  mid-flight, while a silent box session still expires (and its grant is
 *  pruned) an hour after its last report. */
export const PARENT_RELAY_TTL_MS = 60 * 60 * 1000

/** How often expired grants are swept out of the in-memory map (the sweep
 *  timer is unref'd, so it never keeps a daemon alive). */
export const PARENT_RELAY_PRUNE_INTERVAL_MS = 60_000

/** Default timeout for the box → host relay POST, so an unreachable host can
 *  never block `message_parent` forever. */
export const PARENT_RELAY_TIMEOUT_MS = 15_000

/** Env var naming the host relay base URL (operator-provided reachability). */
export const PARENT_RELAY_URL_ENV = "AGENTPROTO_PARENT_RELAY_URL"

/** File (under the daemon's state dir) holding the host-side grants, so a
 *  host daemon restart does not turn every live box's relay into
 *  `relay_token_unknown`. Holds HASHES only (never a raw token), mode 0600. */
export const PARENT_RELAY_GRANTS_FILE = "parent-relay-grants.json"

/** Host-side grants, keyed by the token HASH (never by the raw token). */
const grants = new Map<string, ParentRelayGrant>()

/** SHA-256 (hex) of a relay token: the only form the host keeps. */
export function hashParentRelayToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/** Liveness of a session row as the attached registry sees it: `live`
 *  (running/starting), `dead` (a terminal row) or `unknown` (no such row in
 *  this registry - e.g. not restored yet, or another daemon's). */
export type ParentRelayLiveness = "live" | "dead" | "unknown"

interface ParentRelayStore {
  path: string
  liveness?: (sessionId: string) => ParentRelayLiveness
}

let store: ParentRelayStore | undefined

function isGrantShape(v: unknown): v is ParentRelayGrant {
  if (!v || typeof v !== "object") return false
  const g = v as Record<string, unknown>
  return (
    typeof g.tokenHash === "string" &&
    /^[0-9a-f]{64}$/.test(g.tokenHash) &&
    typeof g.parentSessionId === "string" &&
    typeof g.boxSessionId === "string" &&
    typeof g.expiresAt === "number" &&
    typeof g.ttlMs === "number"
  )
}

/** Write the grants (hashes only) to the attached store, atomically and
 *  owner-only. Best-effort: a failed write never breaks a relay (the
 *  in-memory map stays authoritative for this process). */
function persistGrants(): void {
  if (!store) return
  const path = store.path
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    const body = JSON.stringify({ version: 1, grants: Array.from(grants.values()) }, null, 2)
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    console.warn(
      `[parent-relay] could not persist the relay grants to ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Load the grants persisted at `path` into the in-memory map (expired and
 *  malformed entries are dropped). Merges: a grant already in memory wins. */
function loadGrants(path: string, nowMs: number): void {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return
  }
  try {
    const parsed = JSON.parse(raw) as { grants?: unknown }
    const list = Array.isArray(parsed.grants) ? parsed.grants : []
    for (const g of list) {
      if (!isGrantShape(g) || g.expiresAt <= nowMs) continue
      if (!grants.has(g.tokenHash)) {
        grants.set(g.tokenHash, {
          tokenHash: g.tokenHash,
          parentSessionId: g.parentSessionId,
          boxSessionId: g.boxSessionId,
          expiresAt: g.expiresAt,
          ttlMs: g.ttlMs,
        })
      }
    }
  } catch {
    // A corrupt file is ignored (and rewritten on the next mutation).
  }
}

/** HOST: attach the grant store to a state dir (the sessions registry's own,
 *  see `createSessionsRegistry`) and reload the grants it persisted, so live
 *  box sessions keep reporting across a host daemon restart. `liveness`
 *  lets the periodic sweep RENEW a grant while both its sessions are live
 *  and REVOKE it once either is dead. Returns a detach function (a no-op once
 *  another store was attached). */
export function attachParentRelayStore(opts: {
  dir: string
  liveness?: (sessionId: string) => ParentRelayLiveness
  nowMs?: number
}): () => void {
  const path = join(opts.dir, PARENT_RELAY_GRANTS_FILE)
  loadGrants(path, opts.nowMs ?? Date.now())
  const attached: ParentRelayStore = { path, ...(opts.liveness ? { liveness: opts.liveness } : {}) }
  store = attached
  if (grants.size > 0) {
    persistGrants()
    ensurePruneTimer()
  }
  return () => {
    if (store === attached) store = undefined
  }
}

/** The BOX side's outgoing relay tokens, keyed by the box session id.
 *
 *  The token is a SECRET: it authenticates the box against the host's relay
 *  endpoint. It therefore never lands on a descriptor (and never on disk -
 *  see `sessions.ts`'s snapshot rows): it lives in this in-memory map only,
 *  so a daemon restart loses it (and `message_parent` then fails with a
 *  clear "relay token lost after restart" rather than silently sending an
 *  unauthenticated report). */
const relayTokensBySession = new Map<string, string>()

/** Remember the relay token a session was spawned with (in memory only). */
export function rememberRelayToken(sessionId: string, token: string): void {
  if (!sessionId || !token) return
  relayTokensBySession.set(sessionId, token)
}

/** The relay token a session was spawned with, or `undefined` when the
 *  session has none (never spawned with a remote parent, or the daemon
 *  restarted and lost the in-memory token). */
export function relayTokenForSession(sessionId: string): string | undefined {
  return relayTokensBySession.get(sessionId)
}

/** Forget a session's outgoing relay token (e.g. when the session ends). */
export function forgetRelayToken(sessionId: string): void {
  relayTokensBySession.delete(sessionId)
}

/** Test seam: drop every remembered outgoing token. */
export function clearRelayTokens(): void {
  relayTokensBySession.clear()
}

/** The configured host relay base URL, or `undefined` when the operator did
 *  not configure one (⇒ no remote parent is forwarded at all). */
export function parentRelayUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[PARENT_RELAY_URL_ENV]
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/\/+$/, "")
}

/** Drop every grant whose expiry has passed. Called on each mint and on a
 *  slow unref'd sweep, so an abandoned box session's grant does not linger
 *  in memory forever. */
export function pruneExpiredParentRelayGrants(nowMs: number = Date.now()): number {
  let dropped = 0
  for (const [hash, grant] of grants) {
    if (grant.expiresAt <= nowMs) {
      grants.delete(hash)
      dropped++
    }
  }
  if (dropped > 0) persistGrants()
  return dropped
}

/** The periodic grant sweep: drops expired grants, REVOKES a grant once its
 *  box session or its parent session is dead (a terminal row in the attached
 *  registry), and RENEWS a grant while BOTH sessions are live - so a box
 *  session that runs (silently) longer than one TTL keeps its relay, while a
 *  grant whose sessions are gone still dies. Renewal happens once less than
 *  half the TTL is left, so a live grant is rewritten at most twice per TTL. */
export function sweepParentRelayGrants(nowMs: number = Date.now()): {
  pruned: number
  revoked: number
  renewed: number
} {
  let pruned = 0
  let revoked = 0
  let renewed = 0
  const liveness = store?.liveness
  for (const [hash, grant] of grants) {
    if (grant.expiresAt <= nowMs) {
      grants.delete(hash)
      pruned++
      continue
    }
    if (!liveness) continue
    const parent = liveness(grant.parentSessionId)
    const box = liveness(grant.boxSessionId)
    if (parent === "dead" || box === "dead") {
      grants.delete(hash)
      revoked++
      continue
    }
    if (parent === "live" && box === "live" && grant.expiresAt - nowMs < grant.ttlMs / 2) {
      grant.expiresAt = nowMs + grant.ttlMs
      renewed++
    }
  }
  if (pruned + revoked + renewed > 0) persistGrants()
  return { pruned, revoked, renewed }
}

let pruneTimer: NodeJS.Timeout | undefined

/** Start the (unref'd) expiry sweep. Never keeps the process alive; started
 *  lazily on the first mint so a daemon that never relays pays nothing. */
function ensurePruneTimer(): void {
  if (pruneTimer) return
  pruneTimer = setInterval(() => {
    sweepParentRelayGrants()
  }, PARENT_RELAY_PRUNE_INTERVAL_MS)
  pruneTimer.unref?.()
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
  // Sweep the dead ones first: a mint is the natural moment to notice that
  // an earlier box session's grant is stale.
  pruneExpiredParentRelayGrants(now)
  ensurePruneTimer()
  const token = randomBytes(24).toString("hex")
  const ttlMs = input.ttlMs ?? PARENT_RELAY_TTL_MS
  const tokenHash = hashParentRelayToken(token)
  grants.set(tokenHash, {
    tokenHash,
    parentSessionId: input.parentSessionId,
    boxSessionId: input.boxSessionId,
    expiresAt: now + ttlMs,
    ttlMs,
  })
  persistGrants()
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
  const hash = hashParentRelayToken(token)
  const grant = grants.get(hash)
  if (!grant) return undefined
  if (grant.expiresAt <= nowMs) {
    grants.delete(hash)
    persistGrants()
    return undefined
  }
  return grant
}

/** Forget a grant by its raw token (e.g. when the box boot fails). */
export function revokeParentRelayGrant(token: string): void {
  if (grants.delete(hashParentRelayToken(token))) persistGrants()
}

/** Forget every grant one session takes part in - as the BOX session or as
 *  the PARENT. Called when that session ends or is archived/forgotten: a box
 *  session that is gone must never report up again (even with a token it
 *  kept), and a parent that is gone has nobody left to receive. */
export function revokeParentRelayGrantsForSession(sessionId: string): number {
  let revoked = 0
  for (const [hash, grant] of grants) {
    if (grant.boxSessionId === sessionId || grant.parentSessionId === sessionId) {
      grants.delete(hash)
      revoked++
    }
  }
  if (revoked > 0) persistGrants()
  return revoked
}

/** HOST: mint the grant for a box session that has a host-side parent and
 *  return the remote-parent block to forward into the box's `agent_start`,
 *  or `undefined` when no relay URL is configured (nothing is forwarded and
 *  the box keeps the clear "no recorded parent" error). Shared by the
 *  spawn boot and both restart paths (live-box re-attach and fresh box). */
export function mintRemoteParentForBox(
  parentRelay: { parentSessionId: string; boxSessionId: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RemoteParent | undefined {
  if (!parentRelay) return undefined
  const url = parentRelayUrlFromEnv(env)
  if (!url) return undefined
  return mintParentRelayGrant({ ...parentRelay, url })
}

/** SLIDE the grant's expiry forward by its own TTL: every SUCCESSFUL relay
 *  use buys the session one more TTL, so a live box session that keeps
 *  reporting is never cut off at the original deadline, while a silent one
 *  still expires (and is pruned) an hour after its last report. */
export function slideParentRelayGrant(
  grant: ParentRelayGrant,
  nowMs: number = Date.now(),
): ParentRelayGrant {
  grant.expiresAt = nowMs + grant.ttlMs
  persistGrants()
  return grant
}

/** Test seam: drop every minted grant (and detach any store). */
export function clearParentRelayGrants(): void {
  grants.clear()
  store = undefined
  if (pruneTimer) {
    clearInterval(pruneTimer)
    pruneTimer = undefined
  }
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
  // SLIDING TTL: the relay just worked, so the grant's window slides one
  // more TTL forward (see `PARENT_RELAY_TTL_MS`).
  slideParentRelayGrant(grant, input.nowMs ?? Date.now())
  return {
    ok: true,
    messageId: result.messageId,
    delivery,
    urgencyApplied: result.urgencyApplied,
  }
}
