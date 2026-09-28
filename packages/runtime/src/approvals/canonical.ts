/**
 * Canonical JSON + sha256 for an approval payload — object keys sorted
 * recursively, arrays keep their order. Deep-equal payloads always produce
 * the same string, which is what makes `payloadSha256` a reliable "this
 * exact payload was approved" check (mirrors
 * `projects/pygmalion/packages/core/src/gate/canonical.ts`; duplicated
 * rather than imported since a runtime package may never depend on an
 * app's `@pygmalion/core`).
 */

import { createHash } from "node:crypto"

export function canonicalPayloadFor(payload: unknown): string {
  return canonicalize(payload)
}

function canonicalize(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const entries = keys.map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
  return `{${entries.join(",")}}`
}

export function payloadSha256(payload: unknown): string {
  return createHash("sha256").update(canonicalPayloadFor(payload)).digest("hex")
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex")
}
