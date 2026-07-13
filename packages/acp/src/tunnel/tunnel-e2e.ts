/**
 * Opt-in E2E negotiation for the reverse `serve --connect` tunnel
 * (design: tunnel-e2e/v1).
 *
 * The plaintext reverse tunnel lets a host terminate the WS and read every
 * `agentproto/tunnel/v1` frame. These helpers upgrade that channel to the
 * `wrapE2E` AEAD box using a short, token-authenticated ephemeral handshake, so
 * even a trusted host loses plaintext visibility — while staying fully
 * backward-compatible: with an old peer (or the feature off) the channel stays
 * exactly as it is today.
 *
 * ## Negotiation, and why it lives before the tunnel `hello`
 *
 * `createTunnelServer` emits the tunnel `hello` as its very first frame, and we
 * want that `hello` — and everything after it — INSIDE the encrypted box. So the
 * negotiation cannot ride on the `hello`; it runs first, on the raw sink, over
 * `e2e_handshake` frames:
 *
 * ```
 *   daemon → host:  e2e_handshake(offer)     // daemon advertises e2e + its ephemeral
 *   host   → daemon: e2e_handshake(accept)   // host advertises e2e + its ephemeral
 *   … both wrapE2E(sink) and speak tunnel/v1 encrypted from here …
 * ```
 *
 * The daemon (initiator) offers e2e ONLY when configured to; the host accepts
 * ONLY when it too supports it. If either doesn't, we fall back to plaintext:
 *   - **Old host**: never sends an `accept`. `e2e_handshake` is a known frame
 *     type with no handler on an unwrapped peer, so the daemon's offer is
 *     ignored, and after `timeoutMs` the daemon falls back to plaintext on the
 *     same still-open sink. One stray, ignored frame — behaviour is otherwise
 *     identical to today.
 *   - **Daemon with e2e off**: never sends an `offer`; it emits the plaintext
 *     `hello` first. An e2e-capable host detects a non-handshake first frame and
 *     falls back, re-injecting that frame into its plaintext client.
 *
 * ## Fail-closed vs. fall-back
 *
 * A silent peer (timeout) is a COMPATIBILITY signal → fall back to plaintext. A
 * peer that DID answer but whose handshake is invalid (a wrong `tunnel.token`, a
 * tampered message) is a SECURITY signal → the injected crypto throws and we
 * close the sink and propagate, never downgrading to plaintext. Distinguishing
 * these two is the whole point of returning `null` on timeout but throwing on a
 * bad handshake.
 *
 * This module is crypto-agnostic: all key material comes from injected callbacks
 * (backed by `@agentproto/secrets/pairing`'s `tunnel-handshake`). It depends only
 * on `wrapE2E` + the frame codec, so `@agentproto/acp` never imports the crypto
 * package — exactly as the pairing handshake-over-sink helpers do.
 */

import { wrapE2E, E2eError, type E2eKeys, type E2eFrameSink, type WrapE2EOptions } from "./e2e.js"
import type { FrameSink } from "./transport.js"
import type { TunnelFrame } from "./frames.js"

/** Default negotiation timeout: how long the daemon waits for the host's
 *  `accept` (or the host waits for the daemon's first frame) before concluding
 *  the peer does not support e2e and falling back to plaintext. */
export const DEFAULT_TUNNEL_E2E_TIMEOUT_MS = 8_000

export interface TunnelE2EOptions {
  /** Negotiation timeout in ms. Default `DEFAULT_TUNNEL_E2E_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Forwarded to `wrapE2E`. */
  wrap?: WrapE2EOptions
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

/**
 * Await the first frame on `sink`. Resolves with the frame, or `null` on
 * timeout, and rejects (with the close reason) if the transport closes first.
 * Leaves the sink untouched on timeout so the caller can fall back on it.
 */
function awaitFirstFrame(sink: FrameSink, timeoutMs: number): Promise<TunnelFrame | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubFrame()
      unsubClose()
      fn()
    }
    const timer = setTimeout(() => finish(() => resolve(null)), timeoutMs)
    const unsubFrame = sink.onFrame(frame => finish(() => resolve(frame)))
    const unsubClose = sink.onClose(reason =>
      finish(() =>
        reject(new E2eError("decode", `transport closed during e2e negotiation: ${reason ?? "unknown"}`)),
      ),
    )
  })
}

// ─── daemon (initiator) side ────────────────────────────────────

/**
 * Daemon side of the tunnel-e2e negotiation. Sends the `offer` bytes as an
 * `e2e_handshake` frame, awaits the host's single reply, and:
 *
 *   - **reply arrives** → runs `deriveKeys` (which verifies the reply and yields
 *     the session keys) and returns a `wrapE2E`-wrapped sink. If `deriveKeys`
 *     throws — a wrong `tunnel.token`, a tampered accept — this CLOSES the sink
 *     and rethrows: a security failure must NOT silently downgrade to plaintext.
 *   - **timeout (peer silent)** → returns `null`. The peer is an old/plaintext
 *     host; the sink is left open so the caller falls back to plaintext on it.
 *   - **a non-handshake frame arrives first** → protocol violation (a compliant
 *     old host stays silent until it receives the tunnel `hello`); closes the
 *     sink and throws.
 */
export async function connectSinkE2E(
  sink: FrameSink,
  offer: Uint8Array,
  deriveKeys: (reply: Uint8Array) => E2eKeys,
  opts: TunnelE2EOptions = {},
): Promise<E2eFrameSink | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TUNNEL_E2E_TIMEOUT_MS
  const firstPromise = awaitFirstFrame(sink, timeoutMs)
  sink.send({ t: "e2e_handshake", d: b64(offer) })
  const first = await firstPromise
  if (first === null) {
    // Peer never answered — treat as "does not support e2e" and fall back.
    return null
  }
  if (first.t !== "e2e_handshake") {
    sink.close("e2e negotiation: unexpected frame")
    throw new E2eError(
      "not_e2e",
      `expected an e2e_handshake accept, received "${first.t}"`,
    )
  }
  let keys: E2eKeys
  try {
    keys = deriveKeys(Buffer.from(first.d, "base64"))
  } catch (err) {
    // Wrong token / tampered accept → fail closed, never downgrade.
    sink.close("e2e handshake failed")
    throw err
  }
  return wrapE2E(sink, keys, opts.wrap)
}

// ─── host (responder) side ──────────────────────────────────────

/** Outcome of the host-side negotiation. On the plaintext branch, `sink` is a
 *  view of the original transport that will replay any already-read frame to the
 *  first subscriber — so the host can hand it straight to a plaintext tunnel
 *  client without losing the daemon's `hello`. */
export type AcceptSinkE2EResult =
  | { e2e: true; sink: E2eFrameSink }
  | { e2e: false; sink: FrameSink }

/**
 * Host side of the tunnel-e2e negotiation. Awaits the daemon's first frame:
 *
 *   - **`e2e_handshake` offer** → runs `respond` (which verifies the offer and
 *     yields the reply bytes + session keys), sends the reply, and returns a
 *     `wrapE2E`-wrapped sink. A `respond` throw — wrong token, tampered offer —
 *     closes the sink and rethrows (fail closed).
 *   - **any other frame** (the daemon emitted a plaintext `hello` — it isn't
 *     doing e2e) → returns `{ e2e: false }` with a sink that replays that frame,
 *     so the caller's plaintext client still sees it.
 *   - **timeout** → `{ e2e: false }` on the raw sink (nothing to replay).
 */
export async function acceptSinkE2E(
  sink: FrameSink,
  respond: (offer: Uint8Array) => { reply: Uint8Array; keys: E2eKeys },
  opts: TunnelE2EOptions = {},
): Promise<AcceptSinkE2EResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TUNNEL_E2E_TIMEOUT_MS
  const first = await awaitFirstFrame(sink, timeoutMs)
  if (first === null) {
    return { e2e: false, sink }
  }
  if (first.t !== "e2e_handshake") {
    // Daemon isn't offering e2e — hand back a sink that re-delivers this frame.
    return { e2e: false, sink: prependFrame(sink, first) }
  }
  let result: { reply: Uint8Array; keys: E2eKeys }
  try {
    result = respond(Buffer.from(first.d, "base64"))
  } catch (err) {
    sink.close("e2e handshake failed")
    throw err
  }
  sink.send({ t: "e2e_handshake", d: b64(result.reply) })
  return { e2e: true, sink: wrapE2E(sink, result.keys, opts.wrap) }
}

/**
 * A thin `FrameSink` view of `inner` that re-delivers one already-consumed
 * `frame` to the FIRST `onFrame` subscriber before forwarding live frames. Used
 * on the host's plaintext-fallback path: the negotiation read the daemon's first
 * frame (its `hello`) off the raw sink, so it must be replayed to the plaintext
 * client that subscribes next. The replay runs BEFORE we subscribe to `inner`,
 * so a buffering transport's queued frames still arrive in order after it.
 */
function prependFrame(inner: FrameSink, frame: TunnelFrame): FrameSink {
  let replayed = false
  return {
    get isOpen() {
      return inner.isOpen
    },
    send(f) {
      inner.send(f)
    },
    close(reason) {
      inner.close(reason)
    },
    onFrame(handler) {
      if (!replayed) {
        replayed = true
        handler(frame)
      }
      return inner.onFrame(handler)
    },
    onClose(handler) {
      return inner.onClose(handler)
    },
  }
}
