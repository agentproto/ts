/**
 * Device registry — a read view over `PairingRegistry` (+, when wired,
 * `HostRegistry`) that presents each pairing/host as a "device" (DEVICES-PLAN
 * PR-A, hosts added PR-C). A paired CLIENT (today's `pair_offer`/`pair
 * accept`) gets `role: "client"`; a registered HOST (`pair offer --host` +
 * `devices add`, host-registry.ts) gets `role: "host"`.
 *
 * This is deliberately a thin computed view, not a second store: renaming
 * and revoking a client device mutate the same `pairings.json`
 * `PairingRegistry` already owns; a host device mutates the same
 * `hosts.json` `HostRegistry` — so `pair_*`/`/pairings` and
 * `device_*`/`/devices` are two surfaces over the same two sources of truth.
 */

import type { PairingRegistry, PairingRecord } from "./pairing-registry.js"
import { isSessionsPath, type HostRegistry, type HostRecord, type ForwardHttpRequest, type ForwardHttpResponse } from "./host-registry.js"

export type DeviceRole = "client" | "host"
export type DeviceKind = "browser" | "cli" | "daemon"

export interface Device {
  fingerprint: string
  name: string
  role: DeviceRole
  kind: DeviceKind
  rendezvous: string
  createdAt: string
  lastSeen: string
  /** A channel (offer or reconnect) is served for this device right now
   *  (client), or for a host: a forward/snapshot is in flight or one reached
   *  it within the online grace window (a background poll keeps that fresh
   *  for joined hosts) — see host-registry.ts's "Online tracking". */
  online: boolean
  /** A pair/v1 pairing: listed and revocable, but can't connect until
   *  re-paired — see `PairingRecord.legacy`. */
  legacy?: true
  /** Set when this device's pairing/host record was granted under a
   *  HOST-scoped offer (`agentproto pair offer --host`) — see
   *  offer-url.ts's "Offer scope". Surfaced from either side of a pairing so
   *  a user can see, from EITHER daemon, which of their pairings/hosts grant
   *  host control. */
  scope?: "host"
  /** Self-reported by a host at join time (SANDBOX-VISIBILITY-JOIN) — see
   *  `HostRecord.provider`/`sandboxId`/`labels`. Absent for a client device. */
  provider?: string
  sandboxId?: string
  labels?: Record<string, string>
  /** Host only: when this daemon last tried to reach it, and why the most
   *  recent attempt failed (absent when the last attempt succeeded). */
  lastProbeAt?: string
  lastError?: string
  /** Host only: a join-added (CI) host that is gone — said goodbye or was
   *  unreachable past the TTL. Hidden from `list()` unless `includeEnded`. */
  ended?: true
  endedAt?: string
  /** Host only: a manually added host unreachable past the TTL. Still listed,
   *  never auto-deleted. */
  stale?: true
}

export interface ListDevicesOptions {
  /** Include ended (gone) join-added hosts, which `list()` hides by default. */
  includeEnded?: boolean
}

export interface DeviceRegistry {
  /** Every known device, minus ended join-added hosts unless
   *  `includeEnded`. Read-only. */
  list(opts?: ListDevicesOptions): Promise<Device[]>
  /** Rename a device (fingerprint or current name) to a new label. Tries the
   *  pairing registry first, then the host registry. Returns false when
   *  nothing matched. */
  rename(idOrName: string, newName: string): Promise<boolean>
  /** Drop a device by fingerprint or name — same effect as `pair revoke` for
   *  a client device, `devices revoke`-of-a-host for a host device. Tries
   *  the pairing registry first, then the host registry. Returns false when
   *  nothing matched. */
  revoke(idOrName: string): Promise<boolean>
  /** Register a host from an offer URL (delegates to `HostRegistry.add`).
   *  Rejects if no `HostRegistry` was wired into this device registry. */
  add(offerUrl: string, name?: string): Promise<{ fingerprint: string; name: string; rendezvousUrl: string }>
  /**
   * Forward one HTTP request to a HOST device on demand (delegates to
   * `HostRegistry.forwardHttp`) — the basis for `device_sessions`. Rejects
   * if no `HostRegistry` was wired, or if `idOrName` doesn't match a host.
   *
   * For a GET `/sessions*` request specifically (SANDBOX-VISIBILITY-JOIN
   * #3): if the live forward fails (most commonly the host is offline —
   * an ephemeral CI box's ~3min lifetime is well within normal
   * `device_sessions` polling cadence), falls back to
   * `HostRegistry.getSessionsSnapshot` — the last successful response for
   * that EXACT path, `stale: true`, with a `capturedAt` timestamp — instead
   * of throwing. Still throws if there's no snapshot to fall back to, or
   * for any other path (exec, device-inference, …), where serving stale
   * data silently would be actively wrong.
   */
  forwardHttp(idOrName: string, req: ForwardHttpRequest): Promise<ForwardHttpResponse>
}

/**
 * Best-effort device kind from the client's self-reported name. No wire
 * field carries a real client-kind hint yet — pair/v2's `clientName` is the
 * only signal the handshake exchanges — but both shipped clients default
 * that name to a recognisable shape: `browser@<host>` (or bare `browser`)
 * for the web pair page (`pair-client/src/pair.ts`), `<user>@<host>` for the
 * CLI (`cli/src/util/pair-transport.ts`). A user-supplied `--name` overrides
 * the default and loses the signal — acceptable for a hint, not an identity.
 */
function inferKind(name: string): DeviceKind {
  return /^browser(@|$)/i.test(name) ? "browser" : "cli"
}

function toDevice(record: PairingRecord, online: boolean): Device {
  return {
    fingerprint: record.fingerprint,
    name: record.name,
    role: "client",
    kind: inferKind(record.name),
    rendezvous: record.rendezvousUrl,
    createdAt: record.createdAt,
    lastSeen: record.lastSeen,
    online,
    ...(record.legacy ? { legacy: true } : {}),
    ...(record.scope ? { scope: record.scope } : {}),
  }
}

/** A registered host is always `kind: "daemon"` — the other side of a
 *  reverse pairing is, by construction, an agentproto daemon (never a
 *  browser). A host is always `scope: "host"` by construction: `add()`
 *  refuses anything else. */
function toHostDevice(record: HostRecord, online: boolean): Device {
  return {
    fingerprint: record.fingerprint,
    name: record.name,
    role: "host",
    kind: "daemon",
    rendezvous: record.rendezvousUrl,
    createdAt: record.createdAt,
    lastSeen: record.lastSeen,
    online,
    ...(record.legacy ? { legacy: true } : {}),
    scope: "host",
    ...(record.provider ? { provider: record.provider } : {}),
    ...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
    ...(record.labels ? { labels: record.labels } : {}),
    ...(record.lastProbeAt ? { lastProbeAt: record.lastProbeAt } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...(record.ended ? { ended: true as const, ...(record.endedAt ? { endedAt: record.endedAt } : {}) } : {}),
    ...(record.stale ? { stale: true as const } : {}),
  }
}

export function createDeviceRegistry(pairing: PairingRegistry, hosts?: HostRegistry): DeviceRegistry {
  return {
    async list(opts) {
      const records = await pairing.list()
      const devices = records.map(r => toDevice(r, pairing.isOnline(r.fingerprint)))
      if (hosts) {
        const hostRecords = await hosts.list()
        devices.push(
          ...hostRecords
            .filter(r => opts?.includeEnded || !r.ended)
            .map(r => toHostDevice(r, hosts.isOnline(r.fingerprint))),
        )
      }
      return devices
    },
    async rename(idOrName, newName) {
      if (await pairing.rename(idOrName, newName)) return true
      if (hosts) return hosts.rename(idOrName, newName)
      return false
    },
    async revoke(idOrName) {
      if (await pairing.revoke(idOrName)) return true
      if (hosts) return hosts.revoke(idOrName)
      return false
    },
    async add(offerUrl, name) {
      if (!hosts) {
        throw new Error(
          "this daemon has no host registry wired — devices add is unavailable (internal " +
            "configuration issue, not a user error)",
        )
      }
      return hosts.add(offerUrl, name)
    },
    async forwardHttp(idOrName, req) {
      if (!hosts) {
        throw new Error(
          "this daemon has no host registry wired — device sessions is unavailable (internal " +
            "configuration issue, not a user error)",
        )
      }
      try {
        return await hosts.forwardHttp(idOrName, req)
      } catch (err) {
        if (req.method !== "GET" || !isSessionsPath(req.path)) throw err
        const snapshot = hosts.getSessionsSnapshot(idOrName, req.path)
        if (!snapshot) throw err
        return snapshot
      }
    },
  }
}

// ── device prompt (BOOTSTRAP P4 item 1) ─────────────────────────

/** The host-side route `promptHostSession` forwards to — served by the HOST
 *  daemon's `/device-prompt/:sessionId` (http-server.ts), gated by the same
 *  host-scoped-pairing + `deviceSpawnAllow` two-gate as `/device-spawn/*`. */
export const DEVICE_PROMPT_PATH_PREFIX = "/device-prompt"

export interface PromptHostSessionInput {
  /**
   * The turn to deliver — same shapes local `agent_prompt` accepts: a
   * non-empty string, a content block object, or a non-empty array of
   * content blocks. Validated here (never forwarded ill-formed).
   */
  prompt: unknown
  /** When the host session is mid-turn, redirect instead of queueing
   *  (mirrors local `agent_prompt`'s `interrupt`). Default false. */
  interrupt?: boolean
  /** With a mid-turn session, jump the FRONT of the FIFO instead of the
   *  back (mirrors local `agent_prompt`'s `force`). Default false. */
  force?: boolean
  /** Block until the prompted turn drains (the session goes idle with an
   *  empty queue) instead of fire-and-forget. Default false. */
  wait?: boolean
  /** Poll cadence while `wait`ing, ms — clamped to [10, 10_000], default
   *  1_000. Each poll is a fresh E2E dial to the host, so don't set this
   *  low in production; the clamp floor exists for tests. */
  pollMs?: number
  /** Give up `wait`ing after this long (ms). 0 (default) = wait forever. */
  maxWaitMs?: number
  /** Injectable delay for tests. Default a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>
}

export interface PromptHostSessionResult {
  ok: boolean
  /** The enqueue landed in the host session's FIFO (it was mid-turn) —
   *  present on the fire-and-forget arm only. */
  pending?: boolean
  queueId?: string
  queuePosition?: number
  /** Present on the `wait` arm: how long the turn took to drain. */
  waitedMs?: number
  /** The host's HTTP status, when the enqueue itself failed. */
  status?: number
  message?: string
}

/** Is `prompt` one of the shapes local `agent_prompt` accepts? Kept in sync
 *  with `POST /sessions/:id/prompt`'s own validation (http-server.ts). */
function isValidPrompt(prompt: unknown): boolean {
  if (typeof prompt === "string") return prompt.length > 0
  if (Array.isArray(prompt)) {
    return prompt.length > 0 && prompt.every(b => b !== null && typeof b === "object")
  }
  return prompt !== null && typeof prompt === "object"
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A forwarded non-2xx body is the host's JSON error envelope when it is one
 *  — surface its human `message`, not the raw envelope string. */
function httpErrorMessage(body: Uint8Array): string {
  const raw = Buffer.from(body).toString("utf8")
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { message?: unknown })["message"] === "string") {
      return (parsed as { message: string })["message"]
    }
  } catch {
    /* not JSON — raw body is the message */
  }
  return raw
}

/**
 * Prompt a HOST device's session — the write counterpart of `device_sessions`
 * (BOOTSTRAP P4 item 1). Forwards `POST /device-prompt/:sessionId` over the
 * host's E2E channel (`HostRegistry.forwardHttp`, the same dial the read
 * verbs use); the host daemon, if it has opted in (`deviceSpawnAllow`) and
 * the pairing is host-scoped, calls its own `POST
 * /sessions/:id/prompt` — queueing rules identical to a local prompt.
 *
 * Fire-and-forget by default (the enqueue's 202 comes straight back);
 * `wait: true` then polls the host's `GET /sessions/:id` until the session
 * is idle with an empty queue (or dies, or `maxWaitMs` elapses). Never
 * silently serves stale data — a failed forward throws, there is no
 * snapshot fallback for a write.
 */
export async function promptHostSession(
  hosts: HostRegistry | undefined,
  target: string,
  sessionId: string,
  input: PromptHostSessionInput,
): Promise<PromptHostSessionResult> {
  if (!hosts) {
    throw new Error(
      "this daemon has no host registry wired — device prompt is unavailable (internal " +
        "configuration issue, not a user error)",
    )
  }
  if (!isValidPrompt(input.prompt)) {
    return {
      ok: false,
      message:
        "`prompt` must be a non-empty string, a content block object, or an array of content blocks.",
    }
  }

  const pollMs = Math.min(Math.max(input.pollMs ?? 1_000, 10), 10_000)
  const delay = input.sleep ?? sleep

  const enqueueBody: Record<string, unknown> = { prompt: input.prompt, queue: true }
  if (input.interrupt) enqueueBody.interrupt = true
  if (input.force) enqueueBody.force = true

  const startedAt = Date.now()
  let enqueueRes: ForwardHttpResponse
  try {
    enqueueRes = await hosts.forwardHttp(target, {
      method: "POST",
      path: `${DEVICE_PROMPT_PATH_PREFIX}/${encodeURIComponent(sessionId)}?wait=false`,
      headers: { "content-type": "application/json" },
      body: new Uint8Array(Buffer.from(JSON.stringify(enqueueBody), "utf8")),
    })
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  if (enqueueRes.status < 200 || enqueueRes.status >= 300) {
    return { ok: false, status: enqueueRes.status, message: httpErrorMessage(enqueueRes.body) }
  }

  let enqueueParsed: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(Buffer.from(enqueueRes.body).toString("utf8"))
    if (parsed !== null && typeof parsed === "object") enqueueParsed = parsed as Record<string, unknown>
  } catch {
    /* the host's 202 body is informational only */
  }

  if (!input.wait) {
    const pending = enqueueParsed["pending"] === true
    return {
      ok: true,
      ...(pending
        ? {
            pending: true,
            ...(typeof enqueueParsed["queueId"] === "string" ? { queueId: enqueueParsed["queueId"] } : {}),
            ...(typeof enqueueParsed["queuePosition"] === "number"
              ? { queuePosition: enqueueParsed["queuePosition"] }
              : {}),
          }
        : {}),
    }
  }

  // `wait` arm: poll the host's own session descriptor until the turn the
  // prompt joined drains. An idle session dispatched the prompt immediately,
  // so the very first poll can already see it busy or done.
  for (;;) {
    await delay(pollMs)
    const waitedMs = Date.now() - startedAt
    let descRes: ForwardHttpResponse
    try {
      descRes = await hosts.forwardHttp(target, {
        method: "GET",
        path: `/sessions/${encodeURIComponent(sessionId)}`,
      })
    } catch (err) {
      return { ok: false, waitedMs, message: err instanceof Error ? err.message : String(err) }
    }
    if (descRes.status === 404) {
      return { ok: false, waitedMs, status: 404, message: `session ${sessionId} not found on host ${target}` }
    }
    if (descRes.status < 200 || descRes.status >= 300) {
      return { ok: false, waitedMs, status: descRes.status, message: httpErrorMessage(descRes.body) }
    }
    let descriptor: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(Buffer.from(descRes.body).toString("utf8"))
      if (parsed !== null && typeof parsed === "object") descriptor = parsed as Record<string, unknown>
    } catch {
      return { ok: false, waitedMs, status: descRes.status, message: "host returned a non-JSON session descriptor" }
    }
    if (descriptor["alive"] === false) {
      return { ok: false, waitedMs, message: `session ${sessionId} ended while waiting for its turn to drain` }
    }
    const queue = Array.isArray(descriptor["promptQueue"]) ? (descriptor["promptQueue"] as unknown[]) : []
    if (descriptor["busy"] !== true && queue.length === 0) {
      return { ok: true, waitedMs }
    }
    if (input.maxWaitMs !== undefined && input.maxWaitMs > 0 && waitedMs >= input.maxWaitMs) {
      return { ok: false, waitedMs, message: `timed out after ${waitedMs}ms waiting for the turn to drain` }
    }
  }
}
