/**
 * End-to-end AEAD wrapper for a `FrameSink` (design: DESIGN §5).
 *
 * `wrapE2E(inner, keys)` returns a `FrameSink` that is byte-for-byte
 * transparent to the tunnel client/server above it — they send and receive
 * ordinary `TunnelFrame`s — while everything crossing `inner` (the real
 * transport, typically a WebSocket spliced through an untrusted rendezvous) is
 * AES-256-GCM ciphertext wrapped in `e2e` envelope frames. The rendezvous sees
 * only opaque bytes, their sizes, and their timing.
 *
 * There is deliberately NO new application protocol: the existing
 * `agentproto/tunnel/v1` frames are reused verbatim, serialized with
 * `encodeFrame`, encrypted, and carried inside `e2e` envelopes. So
 * `createTunnelClient` / `createTunnelServer` work unchanged over a wrapped
 * sink.
 *
 * Nonce discipline (the security-critical part):
 *   - Two independent AES-256-GCM keys, one per direction (`sendKey` /
 *     `recvKey`), already assigned by the handshake — so a frame can never be
 *     reflected back and decrypt.
 *   - A per-direction, strictly-monotonic 64-bit counter `n` is the GCM nonce
 *     (never randomly chosen — GCM nonce reuse is catastrophic, and a counter
 *     under one key can never repeat). `n` is also bound as AEAD associated
 *     data, so it can't be edited without failing the tag.
 *   - The receiver requires `n` to be exactly the next expected value.
 *     Anything else — an older/repeated `n` (replay), a higher `n` (a dropped
 *     or reordered frame) — is a typed `E2eError` that closes the channel.
 *     The GCM tag itself catches any bit-flip inside the ciphertext.
 *
 * Async crypto, ordered delivery: the AES-GCM calls go through an `E2eAead`
 * (node:crypto or WebCrypto — ./aead.ts), which is Promise-based because
 * WebCrypto is. `send` stays a synchronous, fire-and-forget call: the counter
 * is assigned at call time, encryption starts immediately, and ciphertexts are
 * written to `inner` strictly in counter order. Inbound frames are checked
 * (envelope, counter) synchronously on arrival and delivered, after
 * decryption, strictly in arrival order. A graceful close — local or remote —
 * lets frames already in flight drain first; a security failure drops them.
 *
 * This module is browser-safe: it depends only on the `E2eAead` seam, the frame
 * codec and portable byte helpers — never on `node:*` or on the
 * crypto/handshake package. It consumes opaque key material and, for the
 * handshake-over-sink helpers, an opaque driver callback.
 */

import { webCryptoAead, type E2eAead } from "./aead.js"
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from "./bytes.js"
import {
  encodeFrame,
  parseFrame,
  type TunnelFrame,
} from "./frames.js"
import type { FrameSink } from "./transport.js"

/** The two symmetric session keys, already role-adjusted by the handshake
 *  (this side's `sendKey` is the peer's `recvKey`). Each is 32 bytes for
 *  AES-256-GCM. */
export interface E2eKeys {
  sendKey: Uint8Array
  recvKey: Uint8Array
}

/** Stable failure codes for the AEAD channel. */
export type E2eErrorCode =
  | "replay" // an inbound `n` we have already passed — a replayed/duplicated frame
  | "reorder" // an inbound `n` ahead of the next expected — a dropped or reordered frame
  | "auth" // GCM tag mismatch — the ciphertext or its bound counter was altered
  | "decode" // the envelope, or the decrypted plaintext, was not a valid frame
  | "not_e2e" // an inbound frame that is not an `e2e` envelope — a downgrade attempt
  | "overflow" // the send counter reached the rekey limit (2^32); rekey required

/** Raised for every E2E channel failure. Surfaced via `onSecurityError` and as
 *  the `onClose` reason — the channel always closes on any of these, so no
 *  tampered or out-of-order frame is ever delivered to the tunnel above. */
export class E2eError extends Error {
  readonly code: E2eErrorCode
  constructor(code: E2eErrorCode, message: string) {
    super(message)
    this.name = "E2eError"
    this.code = code
  }
}

export interface WrapE2EOptions {
  /**
   * Called once, with the typed error, the first time an inbound frame fails
   * an AEAD or counter check (or a send overflows). The channel is closed
   * immediately afterwards. Optional — the same reason is also delivered to
   * `onClose` listeners, so consumers that only care about closure can ignore
   * this.
   */
  onSecurityError?: (err: E2eError) => void
  /**
   * Frame count at which sends must stop and rekey. Defaults to 2^32 — the
   * point at which a 64-bit-counter/one-key regime should rotate keys. v1 has
   * no rekey, so it errors here instead of ever reusing a nonce. Unreachable
   * in practice; the guard exists so it can never be violated.
   */
  maxFrames?: number
  /**
   * The AES-256-GCM implementation. Defaults to WebCrypto here; the
   * `@agentproto/acp/tunnel` Node entry defaults it to `node:crypto`. Both
   * produce identical bytes.
   */
  aead?: E2eAead
}

/** A wrapped sink also exposes its direction counters, so a later phase can
 *  trigger a rekey as they approach the limit. */
export interface E2eFrameSink extends FrameSink {
  /** Number of frames this side has accepted for sending (each one has been
   *  assigned its counter; encryption and the write to `inner` follow in
   *  order). */
  readonly sentCount: number
  /** Number of frames this side has decrypted and delivered. */
  readonly recvCount: number
}

/** Default rekey ceiling: 2^32 frames per direction. */
export const DEFAULT_E2E_MAX_FRAMES = 0x1_0000_0000

const TAG_LEN = 16
const NONCE_LEN = 12

/** GCM nonce for counter `n`: 12 bytes, the 64-bit big-endian counter in the
 *  low 8 bytes (high 4 bytes zero). Direction separation comes from the key,
 *  not the nonce, so a per-direction counter never collides with itself. */
function nonceFor(n: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_LEN)
  new DataView(nonce.buffer).setBigUint64(NONCE_LEN - 8, BigInt(n))
  return nonce
}

/** Associated data binding the counter into the tag: the 64-bit BE counter. */
function aadFor(n: number): Uint8Array {
  const aad = new Uint8Array(8)
  new DataView(aad.buffer).setBigUint64(0, BigInt(n))
  return aad
}

/** Re-throw outside the promise chain, so a throwing listener surfaces as an
 *  uncaught error (as it did when delivery was synchronous) without stalling
 *  the ordered queue behind it. */
function rethrowAsync(err: unknown): void {
  queueMicrotask(() => {
    throw err
  })
}

/**
 * Wrap `inner` so the tunnel above it exchanges plaintext `TunnelFrame`s while
 * the wire carries AEAD ciphertext. Transparent: pass the result anywhere a
 * `FrameSink` is expected.
 */
export function wrapE2E(
  inner: FrameSink,
  keys: E2eKeys,
  opts: WrapE2EOptions = {}
): E2eFrameSink {
  const maxFrames = opts.maxFrames ?? DEFAULT_E2E_MAX_FRAMES
  const aead = opts.aead ?? webCryptoAead
  // Private copies: the caller's buffers can't be mutated under us, and a
  // stable identity lets the WebCrypto AEAD cache its imported keys.
  const sendKey = Uint8Array.from(keys.sendKey)
  const recvKey = Uint8Array.from(keys.recvKey)
  const frameHandlers = new Set<(frame: TunnelFrame) => void>()
  const closeHandlers = new Set<(reason?: string) => void>()

  let sentCount = 0
  let recvExpected = 0
  let recvCount = 0
  /** Accepting sends (and, until a local close/failure, delivering). */
  let open = inner.isOpen
  let failed = false
  let locallyClosed = false
  /** Set on the first inbound violation: nothing after it is looked at. */
  let recvPoisoned = false
  let sendBlocked = false
  let closeNotified = false
  /** Ordered pipelines: each step waits for the previous one. */
  let sendChain: Promise<void> = Promise.resolve()
  let recvChain: Promise<void> = Promise.resolve()
  /** Frames decrypted before anyone subscribed. Held for the first subscriber
   *  only — so a caller that attaches right after an `await` misses nothing. */
  let everSubscribed = false
  const early: TunnelFrame[] = []

  const notifyClose = (reason?: string): void => {
    if (closeNotified) return
    closeNotified = true
    for (const h of closeHandlers) h(reason)
    frameHandlers.clear()
    closeHandlers.clear()
  }

  /** Fail the channel: fire the typed error, close the transport, notify
   *  close listeners. Idempotent — the first failure wins. In-flight frames in
   *  either direction are dropped. */
  const fail = (err: E2eError): void => {
    if (failed) return
    failed = true
    const wasOpen = open
    open = false
    opts.onSecurityError?.(err)
    if (wasOpen) inner.close(err.message)
    notifyClose(err.message)
  }

  /** Fail on an inbound violation detected on arrival — but in order, after
   *  the frames accepted before it have been delivered, exactly as when
   *  delivery was synchronous. Nothing arriving after it is processed. */
  const failInOrder = (err: E2eError): void => {
    recvPoisoned = true
    recvChain = recvChain.then(() => fail(err))
  }

  const deliver = (frame: TunnelFrame): void => {
    if (!everSubscribed) {
      early.push(frame)
      return
    }
    for (const h of frameHandlers) h(frame)
  }

  const onInner = (frame: TunnelFrame): void => {
    if (failed || locallyClosed || recvPoisoned) return
    if (frame.t !== "e2e") {
      // A wrapped endpoint must never accept a plaintext (or handshake) frame
      // once the channel is live — that would be a downgrade. Fail closed.
      failInOrder(
        new E2eError(
          "not_e2e",
          `expected an e2e envelope, received a plaintext "${frame.t}" frame`
        )
      )
      return
    }

    const n = frame.n
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      failInOrder(new E2eError("decode", "e2e envelope has an invalid counter"))
      return
    }
    if (n < recvExpected) {
      failInOrder(new E2eError("replay", `replayed frame: counter ${n} < expected ${recvExpected}`))
      return
    }
    if (n > recvExpected) {
      failInOrder(new E2eError("reorder", `out-of-order or dropped frame: counter ${n} > expected ${recvExpected}`))
      return
    }
    if (typeof frame.d !== "string") {
      failInOrder(new E2eError("decode", "e2e envelope payload is not a string"))
      return
    }
    const buf = base64Decode(frame.d)
    if (buf.length < TAG_LEN) {
      failInOrder(new E2eError("decode", "e2e envelope payload is too short to hold a tag"))
      return
    }

    // The counter is checked on arrival, in arrival order, so it advances
    // here. That can't be abused to skip a frame: if this frame then fails
    // authentication the whole channel fails closed, and nothing after it is
    // ever delivered (the failure is sequenced in the same queue).
    recvExpected = n + 1

    const opened = aead.aesGcmDecrypt(recvKey, nonceFor(n), buf, aadFor(n))
    opened.catch(() => {}) // observed in order below; don't flag it unhandled meanwhile
    recvChain = recvChain
      .then(async () => {
        let plaintext: Uint8Array
        try {
          plaintext = await opened
        } catch {
          fail(new E2eError("auth", `frame ${n} failed authentication — tampered ciphertext or wrong key`))
          return
        }
        if (failed || locallyClosed) return
        recvCount += 1

        const decoded = parseFrame(utf8Decode(plaintext))
        if (!decoded) {
          // AEAD guarantees integrity, so this means an authenticated-but-garbage
          // payload — only reachable via a bug on the far side. Fail closed rather
          // than hand undefined up to the tunnel.
          fail(new E2eError("decode", "decrypted payload was not a valid tunnel frame"))
          return
        }
        deliver(decoded)
      })
      .catch(rethrowAsync)
  }

  const unsubInner = inner.onFrame(onInner)
  const unsubClose = inner.onClose(reason => {
    if (!open) return
    open = false
    // The peer hung up: deliver what already arrived, then report the close.
    recvChain = recvChain.then(() => notifyClose(reason))
  })

  return {
    get isOpen() {
      return open
    },
    get sentCount() {
      return sentCount
    },
    get recvCount() {
      return recvCount
    },
    send(frame) {
      if (!open || failed || sendBlocked) return
      if (sentCount >= maxFrames) {
        // Let the frames already queued go out, then fail — never reuse a nonce.
        sendBlocked = true
        const err = new E2eError(
          "overflow",
          `send counter reached the rekey limit (${maxFrames}); a rekey is required`
        )
        sendChain = sendChain.then(() => fail(err))
        return
      }
      const n = sentCount
      sentCount += 1
      const sealed = aead.aesGcmEncrypt(sendKey, nonceFor(n), utf8Encode(encodeFrame(frame)), aadFor(n))
      sealed.catch(() => {}) // observed in order below
      sendChain = sendChain
        .then(async () => {
          let ct: Uint8Array
          try {
            ct = await sealed
          } catch {
            fail(new E2eError("auth", `frame ${n} could not be encrypted`))
            return
          }
          if (failed) return
          inner.send({ t: "e2e", n, d: base64Encode(ct) })
        })
        .catch(rethrowAsync)
    },
    close(reason) {
      unsubInner()
      unsubClose()
      locallyClosed = true
      if (!open) return
      open = false
      notifyClose(reason)
      // Frames already handed to `send` still go out before the transport closes.
      sendChain = sendChain.then(() => inner.close(reason))
    },
    onFrame(handler) {
      frameHandlers.add(handler)
      if (!everSubscribed) {
        everSubscribed = true
        for (const f of early.splice(0)) handler(f)
      }
      return () => frameHandlers.delete(handler)
    },
    onClose(handler) {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
  }
}

// ─── handshake over a raw sink ──────────────────────────────────
//
// A tiny driver-based helper that runs the two-message `pair/v1` handshake
// over a raw `FrameSink` using `e2e_handshake` envelopes, then hands back a
// `wrapE2E`-wrapped sink. The crypto lives entirely in the injected callbacks
// (backed by `@agentproto/secrets/pairing`), so this stays crypto-agnostic.

export interface HandshakeOverSinkOptions {
  /** How long to wait for the peer's handshake message before failing.
   *  Default 10s. */
  timeoutMs?: number
  /** Forwarded to `wrapE2E`. */
  wrap?: WrapE2EOptions
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

/**
 * A view of `inner` that holds frames arriving while it has no subscriber and
 * replays them, in order, to the next one. The handshake helpers read the
 * peer's handshake message, then spend a moment (async key derivation) before
 * `wrapE2E` subscribes; a peer that starts talking the instant its side is
 * wrapped must not lose those first frames to that gap. Transports like a raw
 * WebSocket don't buffer on their own.
 */
export function holdFrames(inner: FrameSink): FrameSink {
  const handlers = new Set<(frame: TunnelFrame) => void>()
  const held: TunnelFrame[] = []
  inner.onFrame(frame => {
    if (handlers.size === 0) {
      held.push(frame)
      return
    }
    for (const h of [...handlers]) h(frame)
  })
  return {
    get isOpen() {
      return inner.isOpen
    },
    send(frame) {
      inner.send(frame)
    },
    close(reason) {
      inner.close(reason)
    },
    onFrame(handler) {
      handlers.add(handler)
      while (held.length > 0 && handlers.has(handler)) handler(held.shift()!)
      return () => handlers.delete(handler)
    },
    onClose(handler) {
      return inner.onClose(handler)
    },
  }
}

/**
 * Wait for a single `e2e_handshake` frame on `sink`, returning its decoded
 * payload bytes. Rejects on timeout or if the transport closes first. Any
 * other frame type arriving mid-handshake is a protocol violation and rejects
 * — the channel is not yet wrapped, so a stray plaintext frame is illegitimate.
 */
function awaitHandshakeFrame(
  sink: FrameSink,
  timeoutMs: number
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubFrame = (): void => {}
    let unsubClose = (): void => {}
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubFrame()
      unsubClose()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new E2eError("decode", "handshake timed out"))),
      timeoutMs
    )
    unsubFrame = sink.onFrame(frame => {
      if (frame.t !== "e2e_handshake") {
        finish(() =>
          reject(
            new E2eError(
              "not_e2e",
              `expected an e2e_handshake frame, received "${frame.t}"`
            )
          )
        )
        return
      }
      finish(() => resolve(base64Decode(frame.d)))
    })
    if (settled) unsubFrame()
    unsubClose = sink.onClose(reason =>
      finish(() =>
        reject(new E2eError("decode", `transport closed during handshake: ${reason ?? "unknown"}`))
      )
    )
  })
}

/**
 * Client side of the handshake-over-sink. Sends the `hello` bytes, awaits the
 * daemon's single reply, runs `deriveKeys` (which verifies the reply and yields
 * the session keys; it may be async), and returns a wrapped sink. Rejects —
 * closing the sink — if `deriveKeys` throws (e.g. a bad daemon signature).
 * Frames the daemon sends while the keys are being derived are held and
 * delivered once wrapped.
 */
export async function clientHandshakeOverSink(
  sink: FrameSink,
  hello: Uint8Array,
  deriveKeys: (reply: Uint8Array) => E2eKeys | Promise<E2eKeys>,
  opts: HandshakeOverSinkOptions = {}
): Promise<E2eFrameSink> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const view = holdFrames(sink)
  const replyPromise = awaitHandshakeFrame(view, timeoutMs)
  view.send({ t: "e2e_handshake", d: base64Encode(hello) })
  const reply = await replyPromise
  let keys: E2eKeys
  try {
    keys = await deriveKeys(reply)
  } catch (err) {
    view.close("handshake failed")
    throw err
  }
  return wrapE2E(view, keys, opts.wrap)
}

/**
 * Daemon side of the handshake-over-sink. Awaits the client `hello`, runs
 * `respond` (which validates it and yields the reply bytes + session keys; it
 * may be async), sends the reply, and returns a wrapped sink. Rejects —
 * closing the sink — if `respond` throws (e.g. a rejected offer token or
 * tampered hello).
 */
export async function daemonHandshakeOverSink(
  sink: FrameSink,
  respond: (
    hello: Uint8Array
  ) => { reply: Uint8Array; keys: E2eKeys } | Promise<{ reply: Uint8Array; keys: E2eKeys }>,
  opts: HandshakeOverSinkOptions = {}
): Promise<E2eFrameSink> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const view = holdFrames(sink)
  const hello = await awaitHandshakeFrame(view, timeoutMs)
  let result: { reply: Uint8Array; keys: E2eKeys }
  try {
    result = await respond(hello)
  } catch (err) {
    view.close("handshake failed")
    throw err
  }
  view.send({ t: "e2e_handshake", d: base64Encode(result.reply) })
  return wrapE2E(view, result.keys, opts.wrap)
}
