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
 * This module depends only on `node:crypto` and the frame codec — never on the
 * crypto/handshake package. It consumes opaque key material and, for the
 * handshake-over-sink helpers, an opaque driver callback.
 */

import { createCipheriv, createDecipheriv } from "node:crypto"
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
}

/** A wrapped sink also exposes its direction counters, so a later phase can
 *  trigger a rekey as they approach the limit. */
export interface E2eFrameSink extends FrameSink {
  /** Number of frames this side has encrypted and sent. */
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
function nonceFor(n: number): Buffer {
  const nonce = Buffer.alloc(NONCE_LEN)
  nonce.writeBigUInt64BE(BigInt(n), NONCE_LEN - 8)
  return nonce
}

/** Associated data binding the counter into the tag: the 64-bit BE counter. */
function aadFor(n: number): Buffer {
  const aad = Buffer.alloc(8)
  aad.writeBigUInt64BE(BigInt(n))
  return aad
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
  const sendKey = Buffer.from(keys.sendKey)
  const recvKey = Buffer.from(keys.recvKey)
  const frameHandlers = new Set<(frame: TunnelFrame) => void>()
  const closeHandlers = new Set<(reason?: string) => void>()

  let sentCount = 0
  let recvExpected = 0
  let recvCount = 0
  let open = inner.isOpen
  let failed = false

  /** Fail the channel: fire the typed error, close the transport, notify
   *  close listeners. Idempotent — the first failure wins. */
  const fail = (err: E2eError): void => {
    if (failed) return
    failed = true
    opts.onSecurityError?.(err)
    closeChannel(err.message)
  }

  const closeChannel = (reason?: string): void => {
    if (!open) return
    open = false
    inner.close(reason)
    for (const h of closeHandlers) h(reason)
    frameHandlers.clear()
    closeHandlers.clear()
  }

  const onInner = (frame: TunnelFrame): void => {
    if (!open) return
    if (frame.t !== "e2e") {
      // A wrapped endpoint must never accept a plaintext (or handshake) frame
      // once the channel is live — that would be a downgrade. Fail closed.
      fail(
        new E2eError(
          "not_e2e",
          `expected an e2e envelope, received a plaintext "${frame.t}" frame`
        )
      )
      return
    }

    const n = frame.n
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      fail(new E2eError("decode", "e2e envelope has an invalid counter"))
      return
    }
    if (n < recvExpected) {
      fail(new E2eError("replay", `replayed frame: counter ${n} < expected ${recvExpected}`))
      return
    }
    if (n > recvExpected) {
      fail(new E2eError("reorder", `out-of-order or dropped frame: counter ${n} > expected ${recvExpected}`))
      return
    }

    let buf: Buffer
    try {
      buf = Buffer.from(frame.d, "base64")
    } catch {
      fail(new E2eError("decode", "e2e envelope payload is not valid base64"))
      return
    }
    if (buf.length < TAG_LEN) {
      fail(new E2eError("decode", "e2e envelope payload is too short to hold a tag"))
      return
    }
    const ct = buf.subarray(0, buf.length - TAG_LEN)
    const tag = buf.subarray(buf.length - TAG_LEN)

    let plaintext: Buffer
    try {
      const decipher = createDecipheriv("aes-256-gcm", recvKey, nonceFor(n))
      decipher.setAAD(aadFor(n))
      decipher.setAuthTag(tag)
      plaintext = Buffer.concat([decipher.update(ct), decipher.final()])
    } catch {
      fail(new E2eError("auth", `frame ${n} failed authentication — tampered ciphertext or wrong key`))
      return
    }

    // Advance ONLY after a successful decrypt, so a rejected frame never
    // desynchronises the counter (an attacker can't push us past a good frame).
    recvExpected = n + 1
    recvCount += 1

    const decoded = parseFrame(plaintext.toString("utf8"))
    if (!decoded) {
      // AEAD guarantees integrity, so this means an authenticated-but-garbage
      // payload — only reachable via a bug on the far side. Fail closed rather
      // than hand undefined up to the tunnel.
      fail(new E2eError("decode", "decrypted payload was not a valid tunnel frame"))
      return
    }
    for (const h of frameHandlers) h(decoded)
  }

  const unsubInner = inner.onFrame(onInner)
  const unsubClose = inner.onClose(reason => {
    if (!open) return
    open = false
    for (const h of closeHandlers) h(reason)
    frameHandlers.clear()
    closeHandlers.clear()
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
      if (!open || failed) return
      if (sentCount >= maxFrames) {
        fail(
          new E2eError(
            "overflow",
            `send counter reached the rekey limit (${maxFrames}); a rekey is required`
          )
        )
        return
      }
      const n = sentCount
      const plaintext = Buffer.from(encodeFrame(frame), "utf8")
      const cipher = createCipheriv("aes-256-gcm", sendKey, nonceFor(n))
      cipher.setAAD(aadFor(n))
      const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const tag = cipher.getAuthTag()
      sentCount += 1
      inner.send({ t: "e2e", n, d: Buffer.concat([ct, tag]).toString("base64") })
    },
    close(reason) {
      unsubInner()
      unsubClose()
      closeChannel(reason)
    },
    onFrame(handler) {
      frameHandlers.add(handler)
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

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
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
    const unsubFrame = sink.onFrame(frame => {
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
      finish(() => resolve(Buffer.from(frame.d, "base64")))
    })
    const unsubClose = sink.onClose(reason =>
      finish(() =>
        reject(new E2eError("decode", `transport closed during handshake: ${reason ?? "unknown"}`))
      )
    )
  })
}

/**
 * Client side of the handshake-over-sink. Sends the `hello` bytes, awaits the
 * daemon's single reply, runs `deriveKeys` (which verifies the reply and yields
 * the session keys), and returns a wrapped sink. Rejects — closing the sink —
 * if `deriveKeys` throws (e.g. a bad daemon signature).
 */
export async function clientHandshakeOverSink(
  sink: FrameSink,
  hello: Uint8Array,
  deriveKeys: (reply: Uint8Array) => E2eKeys,
  opts: HandshakeOverSinkOptions = {}
): Promise<E2eFrameSink> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const replyPromise = awaitHandshakeFrame(sink, timeoutMs)
  sink.send({ t: "e2e_handshake", d: b64(hello) })
  const reply = await replyPromise
  let keys: E2eKeys
  try {
    keys = deriveKeys(reply)
  } catch (err) {
    sink.close("handshake failed")
    throw err
  }
  return wrapE2E(sink, keys, opts.wrap)
}

/**
 * Daemon side of the handshake-over-sink. Awaits the client `hello`, runs
 * `respond` (which validates it and yields the reply bytes + session keys),
 * sends the reply, and returns a wrapped sink. Rejects — closing the sink — if
 * `respond` throws (e.g. a rejected offer token or tampered hello).
 */
export async function daemonHandshakeOverSink(
  sink: FrameSink,
  respond: (hello: Uint8Array) => { reply: Uint8Array; keys: E2eKeys },
  opts: HandshakeOverSinkOptions = {}
): Promise<E2eFrameSink> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const hello = await awaitHandshakeFrame(sink, timeoutMs)
  let result: { reply: Uint8Array; keys: E2eKeys }
  try {
    result = respond(hello)
  } catch (err) {
    sink.close("handshake failed")
    throw err
  }
  sink.send({ t: "e2e_handshake", d: b64(result.reply) })
  return wrapE2E(sink, result.keys, opts.wrap)
}
