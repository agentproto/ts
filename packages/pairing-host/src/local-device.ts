/**
 * Local-device bearer primitives (see "Local devices" in pairing-registry.ts).
 * Pure functions; the registry owns storage and file freshness.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const LOCAL_BEARER_PREFIX = "apd1"
const MAC_CONTEXT = "agentproto/local-device/v1|"

/** One local device as persisted in `pairings.json` under `localDevices`. */
export interface LocalDeviceRecord {
  /** 32 lowercase hex chars: the public handle (also the bearer's lookup key). */
  fingerprint: string
  name: string
  /** ISO-8601. */
  createdAt: string
  /** Per-device secret (base64url, 32 bytes). Never leaves the host. */
  secret: string
}

export function newLocalDevice(name: string, createdAt: string): LocalDeviceRecord {
  return {
    fingerprint: randomBytes(16).toString("hex"),
    name,
    createdAt,
    secret: randomBytes(32).toString("base64url"),
  }
}

function macOf(rec: Pick<LocalDeviceRecord, "fingerprint" | "secret">): Buffer {
  return createHmac("sha256", Buffer.from(rec.secret, "base64url"))
    .update(MAC_CONTEXT + rec.fingerprint, "utf8")
    .digest()
}

/** `apd1.<fingerprint>.<mac>`: opaque to the client, re-derivable by the host. */
export function deriveLocalBearer(rec: LocalDeviceRecord): string {
  return `${LOCAL_BEARER_PREFIX}.${rec.fingerprint}.${macOf(rec).toString("base64url")}`
}

export interface ParsedBearer {
  fingerprint: string
  /** Raw base64url as presented (NOT re-encoded from the decoded buffer — the
   *  trailing bits of a 32-byte MAC are dropped by base64url decoding, so the
   *  last character must be compared in string form). */
  mac: string
}

export function parseLocalBearer(bearer: string): ParsedBearer | null {
  if (typeof bearer !== "string" || bearer.length > 256) return null
  const parts = bearer.split(".")
  if (parts.length !== 3 || parts[0] !== LOCAL_BEARER_PREFIX) return null
  const [, fingerprint, mac] = parts as [string, string, string]
  if (!/^[0-9a-f]{32}$/.test(fingerprint) || !/^[A-Za-z0-9_-]+$/.test(mac)) return null
  return { fingerprint, mac }
}

/** Constant-time MAC check. Runs the same HMAC + compare for an unknown
 *  fingerprint (against a throwaway secret) so the miss path costs the same. */
export function verifyLocalBearer(rec: LocalDeviceRecord | undefined, parsed: ParsedBearer | null): boolean {
  const target = rec ?? { fingerprint: "0".repeat(32), secret: randomBytes(32).toString("base64url") }
  const expected = macOf(target).toString("base64url")
  const presented = parsed?.mac ?? ""
  const sameLength = presented.length === expected.length
  const equal = timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(sameLength ? presented : "0".repeat(expected.length)),
  )
  return Boolean(rec) && parsed !== null && sameLength && equal
}

export function isLocalDeviceRecord(v: unknown): v is LocalDeviceRecord {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r["fingerprint"] === "string" &&
    /^[0-9a-f]{32}$/.test(r["fingerprint"]) &&
    typeof r["name"] === "string" &&
    typeof r["createdAt"] === "string" &&
    typeof r["secret"] === "string" &&
    r["secret"].length > 0
  )
}
