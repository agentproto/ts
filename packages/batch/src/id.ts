/**
 * Minimal ULID generator (Crockford base32, 48-bit time + 80-bit randomness).
 * No `ulid` dependency in the workspace lockfile; batch handle ids only need
 * to be unique and roughly time-sortable, so a small local implementation
 * keeps this package dependency-free beyond zod.
 */

import { randomBytes } from "node:crypto"

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function encodeTime(time: number, length: number): string {
  let remaining = time
  let out = ""
  for (let i = 0; i < length; i++) {
    const mod = remaining % 32
    out = CROCKFORD_ALPHABET[mod] + out
    remaining = (remaining - mod) / 32
  }
  return out
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length)
  let out = ""
  for (const byte of bytes) {
    out += CROCKFORD_ALPHABET[byte % 32]
  }
  return out
}

/** A 26-character ULID: 10 chars of millisecond time, 16 chars of randomness. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16)
}

/** Our own batch handle id — driver-agnostic, stable across re-attaches. */
export function newBatchId(): string {
  return `b_${ulid()}`
}
