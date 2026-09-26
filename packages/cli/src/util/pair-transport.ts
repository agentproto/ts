/**
 * Client-side pairing transport — the `agentproto pair accept` / routing half.
 *
 *   - `dialRendezvous`   open a ws to the broker, adapt to a FrameSink.
 *   - `acceptOffer`      parse an offer URL, run the client handshake, verify the
 *                        daemon fingerprint, persist the pairing.
 *   - `openPairChannel`  reconnect an established pairing over the epoch route
 *                        (current → previous, to bridge clock skew), proving the
 *                        epoch auth token, and return a live `TunnelClient`.
 *
 * Only ROUTE tokens go on a broker URL; AUTH tokens only ever travel sealed in
 * the hello (see `@agentproto/secrets/pairing` derive.ts). The broker sees the
 * route and can't derive the auth from it.
 *   - `createLoopbackBridge`  a throwaway loopback HTTP server that forwards to
 *                        the pairing's E2E channel via `forwardHttp` /
 *                        `forwardHttpStream`, so ANY existing verb can run
 *                        against `AGENTPROTO_DAEMON_URL=<bridge>` unchanged.
 *
 * The routing seam is `createLoopbackBridge` + a child `agentproto <verb>` (see
 * `pair exec`): the smallest viable way to route every verb over a pairing
 * without threading an E2E transport through each command's HTTP helpers.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import WebSocket from "ws"
import {
  createTunnelClient,
  clientHandshakeOverSink,
  wrapWebSocket,
  type FrameSink,
  type TunnelClient,
} from "@agentproto/acp/tunnel"
import {
  startClientHandshake,
  encodePairingMessage,
  decodePairingReply,
  parseOfferUrl,
  derivePairRoot,
  deriveEpochTokens,
  deriveOfferTokens,
  currentEpoch,
  PAIRING_PROTOCOL_OUTDATED_MESSAGE,
  PairingError,
  type PairingSession,
} from "@agentproto/secrets/pairing"
import {
  upsertClientPairing,
  type ClientPairing,
} from "./client-pairings.js"

const DIAL_TIMEOUT_MS = 15_000
const HANDSHAKE_TIMEOUT_MS = 15_000

/** Open a WS to `url` and adapt it to a `FrameSink`. Rejects on dial failure or
 *  timeout. */
export function dialRendezvous(url: string, timeoutMs = DIAL_TIMEOUT_MS): Promise<FrameSink> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(new Error(`rendezvous dial timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    ws.once("open", () => {
      clearTimeout(timer)
      resolve(wrapWebSocket(ws as unknown as Parameters<typeof wrapWebSocket>[0]))
    })
    ws.once("error", err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Broker upgrade URL. `route` must be a ROUTE token — never an auth token or
 *  the offer secret: everything here is visible to the broker. */
function rvUrl(base: string, side: "client", route: string): string {
  const sep = base.includes("?") ? "&" : "?"
  return `${base}${sep}side=${side}&t=${encodeURIComponent(route)}`
}

export interface AcceptResult {
  fingerprint: string
  name: string
  rendezvousUrl: string
}

/**
 * Accept an offer URL: dial the rendezvous, run the client handshake (verifying
 * the daemon's transcript signature against the offered Ed25519 key), confirm
 * the derived peer fingerprint matches the offer's `id`, persist the pairing
 * client-side, and close the one-shot channel. Throws on a malformed/expired
 * offer, a bad daemon signature, or a fingerprint mismatch.
 */
export async function acceptOffer(offerUrl: string, name?: string): Promise<AcceptResult> {
  const offer = await parseOfferUrl(offerUrl, { now: Date.now() })
  const { route, auth } = await deriveOfferTokens(offer.secret)
  const raw = await dialRendezvous(rvUrl(offer.rendezvousUrl, "client", route))

  const started = await startClientHandshake({
    daemonX25519Pub: offer.daemonX25519Pub,
    daemonEd25519Pub: offer.daemonEd25519Pub,
    authToken: auth,
    clientName: name ?? defaultClientName(),
  })
  let session: PairingSession | null = null
  const wrapped = await clientHandshakeOverSink(
    raw,
    encodePairingMessage(started.hello),
    async replyBytes => {
      session = await started.complete(decodePairingReply(replyBytes))
      return session
    },
    { timeoutMs: HANDSHAKE_TIMEOUT_MS },
  )
  if (!session) throw new Error("handshake did not derive a session")
  const derived: PairingSession = session

  // Defence in depth: the daemon we just authenticated (via `sig`) must be the
  // one the offer named. parseOfferUrl already checked id == fingerprint(pk);
  // this reconfirms against the value the handshake derived.
  if (derived.peerFingerprint !== offer.fingerprint) {
    wrapped.close("fingerprint mismatch")
    throw new Error(
      `daemon fingerprint ${derived.peerFingerprint} does not match the offer's ${offer.fingerprint}`,
    )
  }

  const nowIso = new Date().toISOString()
  const pairing: ClientPairing = {
    fingerprint: offer.fingerprint,
    name: name ?? offer.fingerprint,
    daemonX25519Pub: offer.daemonX25519Pub,
    daemonEd25519Pub: offer.daemonEd25519Pub,
    rendezvousUrl: offer.rendezvousUrl,
    pairRoot: await derivePairRoot(derived),
    createdAt: nowIso,
    lastSeen: nowIso,
  }
  await upsertClientPairing(pairing)

  // The accept ceremony is one-shot — close the channel; reconnect happens later
  // via `openPairChannel`.
  wrapped.close("accept complete")
  return { fingerprint: pairing.fingerprint, name: pairing.name, rendezvousUrl: pairing.rendezvousUrl }
}

export interface PairChannel {
  client: TunnelClient
  close(): Promise<void>
}

export interface OpenPairChannelOptions {
  /** Injectable clock (ms) — picks the epoch. Defaults to Date.now. */
  now?: number
  /** Rendezvous dial ceiling per attempt. */
  dialTimeoutMs?: number
  /** Handshake ceiling per attempt. */
  handshakeTimeoutMs?: number
}

/**
 * Reconnect an established pairing. Tries the current epoch route, then the
 * previous one (bridging clock skew), running a fresh handshake each time (new
 * ephemeral; the sealed hello carries that epoch's auth token, which the daemon
 * verifies). Returns a live tunnel client once the daemon's hello arrives.
 * Refuses a legacy (pair/v1) pairing outright with the re-pair instruction.
 */
export async function openPairChannel(
  pairing: ClientPairing,
  opts: OpenPairChannelOptions = {},
): Promise<PairChannel> {
  if (pairing.legacy) {
    throw new PairingError(
      "pairing_protocol_outdated",
      `pairing "${pairing.name}" (daemon ${pairing.fingerprint}): ${PAIRING_PROTOCOL_OUTDATED_MESSAGE}`,
    )
  }
  const now = opts.now ?? Date.now()
  const dialTimeoutMs = opts.dialTimeoutMs ?? DIAL_TIMEOUT_MS
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
  const epoch = currentEpoch(now)
  const attempts = [epoch, epoch - 1]
  let lastErr: unknown
  let hungUpOnHello = 0
  for (const e of attempts) {
    const { route, auth } = await deriveEpochTokens(pairing.pairRoot, e)
    let raw: FrameSink
    try {
      raw = await dialRendezvous(rvUrl(pairing.rendezvousUrl, "client", route), dialTimeoutMs)
    } catch (err) {
      lastErr = err
      continue
    }
    try {
      const started = await startClientHandshake({
        daemonX25519Pub: pairing.daemonX25519Pub,
        daemonEd25519Pub: pairing.daemonEd25519Pub,
        authToken: auth,
        clientName: pairing.name,
      })
      const wrapped = await clientHandshakeOverSink(
        raw,
        encodePairingMessage(started.hello),
        replyBytes => started.complete(decodePairingReply(replyBytes)),
        { timeoutMs: handshakeTimeoutMs },
      )
      const client = createTunnelClient({ sink: wrapped })
      await client.ready()
      // Refresh lastSeen (best-effort).
      await upsertClientPairing({ ...pairing, lastSeen: new Date().toISOString() }).catch(() => {})
      return { client, close: () => client.close() }
    } catch (err) {
      lastErr = err
      if (err instanceof Error && /transport closed during handshake/.test(err.message)) {
        hungUpOnHello++
      }
      try {
        raw.close("handshake failed")
      } catch {
        /* ignore */
      }
    }
  }
  // Every attempt reached a daemon that hung up on our hello: the likeliest
  // cause is a daemon still on pair/v1, which refuses a v2 hello without a
  // word. Say so rather than leave a bare "transport closed".
  const hint =
    hungUpOnHello === attempts.length
      ? " — the daemon hung up on the pair/v2 hello; if it runs an older agentproto " +
        "(pair/v1), upgrade it and re-pair: run `agentproto pair offer` on the daemon, " +
        "then `agentproto pair accept` here"
      : ""
  throw new Error(
    `could not reach daemon ${pairing.fingerprint} via ${pairing.rendezvousUrl}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }${hint}`,
  )
}

export interface LoopbackBridge {
  /** `http://127.0.0.1:<port>` — point AGENTPROTO_DAEMON_URL here. */
  url: string
  close(): Promise<void>
}

/**
 * Stand up a loopback HTTP server that forwards every request over the pairing's
 * E2E channel. SSE / event-stream responses are streamed; everything else is
 * buffered. This is what lets a child `agentproto <verb>` — which discovers the
 * daemon purely from `AGENTPROTO_DAEMON_URL` — run transparently over a pairing.
 */
export function createLoopbackBridge(client: TunnelClient): Promise<LoopbackBridge> {
  const server: Server = createServer((req, res) => {
    void forward(client, req, res).catch(err => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            error: "pair_bridge_failed",
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      } else {
        res.destroy()
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = addr && typeof addr === "object" ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>(res => {
            server.close(() => res())
          }),
      })
    })
  })
}

async function forward(
  client: TunnelClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k] = v
    else if (Array.isArray(v)) headers[k] = v.join(", ")
  }
  const path = req.url ?? "/"
  const method = req.method ?? "GET"
  const wantsStream =
    (req.headers.accept ?? "").includes("text/event-stream") || path.split("?")[0] === "/events"

  if (wantsStream) {
    const streamRes = await client.forwardHttpStream({
      method,
      path,
      headers,
      ...(body.length ? { body } : {}),
    })
    res.writeHead(streamRes.status, toOutHeaders(streamRes.headers))
    const reader = streamRes.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) res.write(Buffer.from(value))
    }
    res.end()
    return
  }

  const httpRes = await client.forwardHttp({
    method,
    path,
    headers,
    ...(body.length ? { body } : {}),
  })
  res.writeHead(httpRes.status, toOutHeaders(httpRes.headers))
  res.end(httpRes.body)
}

function toOutHeaders(h: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) {
    // Drop hop-by-hop / framing headers the daemon may echo: we re-emit the
    // body via res.write/res.end, so Node re-derives content-length (buffered)
    // or transfer-encoding (chunked) itself — forwarding the originals would
    // double up or mismatch the length.
    const lk = k.toLowerCase()
    if (lk === "connection" || lk === "transfer-encoding" || lk === "content-length") continue
    out[k] = v
  }
  return out
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function defaultClientName(): string {
  const user = process.env.USER ?? process.env.USERNAME ?? "client"
  const host = process.env.HOSTNAME ?? ""
  return host ? `${user}@${host}` : user
}
