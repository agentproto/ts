/** HMAC header verification used by the push providers (`agentpush` legacy
 *  and GitHub's `x-hub-signature-256`). Mirrors the daemon's generic inbound
 *  helper for these two schemes only. */

import { createHmac, timingSafeEqual } from "node:crypto"

export type InboundSignatureProvider = "agentpush" | "sentinel"

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === "string") return value
    if (value && value.length > 0) return value[0]
  }
  return undefined
}

export function verifyInboundSignature(
  provider: InboundSignatureProvider,
  input: { rawBody: string; headers: Record<string, string | string[] | undefined>; secret: string; nowMs: number },
): { ok: true } | { ok: false; reason: string } {
  const headerName = provider === "agentpush" ? "x-agentpush-signature" : "x-hub-signature-256"
  const header = headerValue(input.headers, headerName)
  if (!header) return { ok: false, reason: `missing ${headerName}` }
  const prefix = "sha256="
  if (!header.startsWith(prefix)) return { ok: false, reason: `bad ${headerName} format` }
  const hex = header.slice(prefix.length)
  if (!/^[0-9a-fA-F]+$/.test(hex)) return { ok: false, reason: `bad ${headerName} hex` }
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest()
  let provided: Buffer
  try {
    provided = Buffer.from(hex, "hex")
  } catch {
    return { ok: false, reason: `bad ${headerName} hex` }
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: `bad ${headerName}` }
  }
  return { ok: true }
}

export function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const m = url.trim().match(/^(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/)
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined
}
