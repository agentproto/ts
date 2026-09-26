/**
 * Byte helpers shared by the Node and browser builds of the pairing / seal /
 * identity code — the `Uint8Array` replacements for the `Buffer` calls this
 * code used to make.
 *
 * Browser-safe: no `node:` import. When a global `Buffer` exists (Node) the
 * base64 helpers delegate to it, so Node output is byte-identical to the
 * `Buffer.from(…, "base64")` / `.toString("base64")` calls they replace by
 * construction. Elsewhere a portable implementation with the SAME semantics
 * takes over — including Buffer's lenient decode (both alphabets accepted,
 * unknown characters skipped, decoding stops at the first `=`), so a peer can't
 * craft a string the two runtimes read differently. `bytes.test.ts` pins the
 * portable path against `Buffer`.
 */

interface BufferLike {
  from(input: string, encoding: "base64"): Uint8Array
  from(input: Uint8Array): Uint8Array & { toString(encoding: "base64"): string }
}

function nodeBuffer(): BufferLike | undefined {
  const b = (globalThis as { Buffer?: BufferLike }).Buffer
  return typeof b?.from === "function" ? b : undefined
}

const ENC_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** char code → 6-bit value; -1 = not in either base64 alphabet. */
const DEC_TABLE: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < ENC_ALPHABET.length; i++) t[ENC_ALPHABET.charCodeAt(i)] = i
  t["-".charCodeAt(0)] = 62
  t["_".charCodeAt(0)] = 63
  return t
})()

/** Portable standard base64 (padded). Exported for the parity test. */
export function base64EncodePortable(bytes: Uint8Array): string {
  let out = ""
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out +=
      ENC_ALPHABET[(n >> 18) & 63]! +
      ENC_ALPHABET[(n >> 12) & 63]! +
      ENC_ALPHABET[(n >> 6) & 63]! +
      ENC_ALPHABET[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += ENC_ALPHABET[(n >> 18) & 63]! + ENC_ALPHABET[(n >> 12) & 63]! + "=="
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out +=
      ENC_ALPHABET[(n >> 18) & 63]! +
      ENC_ALPHABET[(n >> 12) & 63]! +
      ENC_ALPHABET[(n >> 6) & 63]! +
      "="
  }
  return out
}

/** Portable lenient base64 decode with `Buffer.from(s, "base64")` semantics.
 *  Exported for the parity test. */
export function base64DecodePortable(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 3)
  let len = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 61) break // "=" ends the data, as in Buffer
    const v = c < 128 ? DEC_TABLE[c]! : -1
    if (v < 0) continue
    acc = ((acc << 6) | v) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[len++] = (acc >> bits) & 0xff
    }
  }
  return out.slice(0, len)
}

/** Standard base64 (padded) — identical to `Buffer#toString("base64")`. */
export function base64Encode(bytes: Uint8Array): string {
  const B = nodeBuffer()
  return B ? B.from(bytes).toString("base64") : base64EncodePortable(bytes)
}

/** Lenient base64 decode — identical to `Buffer.from(s, "base64")`. Returns a
 *  plain `Uint8Array` view (a `Buffer` under Node). Never throws. */
export function base64Decode(s: string): Uint8Array {
  const B = nodeBuffer()
  return B ? B.from(s, "base64") : base64DecodePortable(s)
}

/** base64url without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const textEncoder = new TextEncoder()
// ignoreBOM: keep a leading U+FEFF in the output, as Buffer#toString does.
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true })

export function utf8Encode(s: string): Uint8Array {
  return textEncoder.encode(s)
}

/** UTF-8 decode, replacing invalid sequences with U+FFFD (like Buffer). */
export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Lexicographic byte comparison — same ordering as `Buffer.compare`. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/** Constant-time equality for equal-length inputs (length itself is not
 *  secret). Replaces `timingSafeEqual`. */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/** 8-byte big-endian encoding of a non-negative integer (≤ 2^64-1). */
export function u64be(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}
