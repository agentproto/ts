/**
 * AIP-53 link-token scoping — stateless HMAC-signed tokens that let an
 * installed app's UI reach a NARROWED slice of its own `ui.tools`
 * allowlist from outside the daemon's normal trust boundary (a link opened
 * on a phone, over a tunnel, with no bearer in it — see http-server.ts's
 * `tunnelBearerAllowed` doc for why the full daemon bearer must never ride
 * on a shared link).
 *
 * Two kinds of token, same signing key, same on-wire shape
 * (`base64url(JSON payload) + "." + hex HMAC-SHA256`), distinguished by
 * `kind` so one can never be mistaken for the other:
 *
 *   - `"link"` — minted by the privileged `app_link_mint` MCP tool
 *     (app-tools.ts). ALWAYS Telegram-identity-gated (`pendingTelegramAuth:
 *     true`, carrying a `telegramUserId` claim): it is never, by itself,
 *     enough to call a tool or read a session — see app-link-auth.ts's
 *     `authorizeAppLink`, the only function that ever turns one into the
 *     next kind.
 *   - `"session"` — minted by `authorizeAppLink` only after the opener's
 *     Telegram Mini App `initData` verified against the daemon's own
 *     stored bot token AND named the exact `telegramUserId` the link
 *     token claimed. THIS is what `dispatchAllowlistedAppTool`'s scoped
 *     mode and the tunnel-gate read-route bypass actually accept.
 *
 * The signing key lives at `~/.agentproto/keys/app_link_hmac` (32 random
 * bytes, hex-encoded, mode 0600), generated on first use — same "generate
 * once, chmod 0600, never echo" shape as `review-signing.ts`'s keypair,
 * minus the `ssh-keygen` shellout (a plain HMAC needs no asymmetric key).
 */

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export function defaultAppLinkKeyPath(): string {
  return join(homedir(), ".agentproto", "keys", "app_link_hmac")
}

let cachedKey: Buffer | undefined
let cachedKeyPath: string | undefined

function ensureAppLinkSigningKey(keyPath: string = defaultAppLinkKeyPath()): Buffer {
  if (cachedKey && cachedKeyPath === keyPath) return cachedKey
  mkdirSync(dirname(keyPath), { recursive: true })
  let key: Buffer
  if (existsSync(keyPath)) {
    const hex = readFileSync(keyPath, "utf8").trim()
    key = Buffer.from(hex, "hex")
    if (key.length !== 32) {
      throw new Error(`app-link signing key at '${keyPath}' is malformed (expected 32 bytes of hex).`)
    }
  } else {
    key = randomBytes(32)
    writeFileSync(keyPath, key.toString("hex") + "\n", { encoding: "utf8", mode: 0o600 })
    chmodSync(keyPath, 0o600)
  }
  cachedKey = key
  cachedKeyPath = keyPath
  return key
}

/** Test-only: drop the in-memory key cache so a test using its own
 *  `keyPath` under a tmp dir doesn't read another test's cached key. */
export function resetAppLinkSigningKeyCacheForTests(): void {
  cachedKey = undefined
  cachedKeyPath = undefined
}

interface AppLinkTokenPayload {
  v: 1
  kind: "link" | "session"
  appId: string
  claims: Record<string, string>
  /** Epoch seconds. */
  exp: number
  /** Only ever set on a `"link"` token — see the module doc. */
  pendingTelegramAuth?: true
}

export interface VerifiedAppLinkToken {
  appId: string
  claims: Readonly<Record<string, string>>
  exp: number
  pendingTelegramAuth?: true
}

export type VerifyAppLinkTokenResult =
  | { ok: true; payload: VerifiedAppLinkToken }
  | { ok: false; error: string }

function sign(payloadB64: string, key: Buffer): string {
  return createHmac("sha256", key).update(payloadB64).digest("hex")
}

function encode(payload: AppLinkTokenPayload, key: Buffer): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${payloadB64}.${sign(payloadB64, key)}`
}

function isPayload(v: unknown): v is AppLinkTokenPayload {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return (
    r.v === 1 &&
    (r.kind === "link" || r.kind === "session") &&
    typeof r.appId === "string" &&
    typeof r.exp === "number" &&
    typeof r.claims === "object" &&
    r.claims !== null &&
    !Array.isArray(r.claims) &&
    Object.values(r.claims as Record<string, unknown>).every(c => typeof c === "string")
  )
}

function decode(token: string, key: Buffer, wantKind: "link" | "session"): VerifyAppLinkTokenResult {
  const dot = token.indexOf(".")
  if (dot === -1) return { ok: false, error: "malformed token" }
  const payloadB64 = token.slice(0, dot)
  const givenSig = token.slice(dot + 1)
  const expectedSig = sign(payloadB64, key)
  const expectedBuf = Buffer.from(expectedSig, "hex")
  const givenBuf = Buffer.from(givenSig, "hex")
  if (expectedBuf.length !== givenBuf.length || !timingSafeEqual(expectedBuf, givenBuf)) {
    return { ok: false, error: "invalid signature" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"))
  } catch {
    return { ok: false, error: "invalid payload json" }
  }
  if (!isPayload(parsed)) return { ok: false, error: "invalid payload shape" }
  if (parsed.kind !== wantKind) return { ok: false, error: `expected a "${wantKind}" token, got "${parsed.kind}"` }
  if (Math.floor(Date.now() / 1000) >= parsed.exp) return { ok: false, error: "expired token" }
  return {
    ok: true,
    payload: {
      appId: parsed.appId,
      claims: parsed.claims,
      exp: parsed.exp,
      ...(parsed.pendingTelegramAuth ? { pendingTelegramAuth: true as const } : {}),
    },
  }
}

export interface MintAppLinkTokenInput {
  appId: string
  claims: Record<string, string>
  /** Time-to-live in ms, from now. */
  ttlMs: number
  /** Always `true` in practice — see the module doc: a "link" token that
   *  isn't Telegram-gated is never minted by `app_link_mint`. Kept as an
   *  explicit input (not hardcoded) so a test can mint the narrower shape
   *  directly. */
  pendingTelegramAuth?: boolean
  keyPath?: string
}

/** Mint a `"link"` token — see the module doc. Never, by itself, enough to
 *  call a tool or read a session; `authorizeAppLink` is what exchanges it. */
export function mintAppLinkToken(input: MintAppLinkTokenInput): { token: string; exp: number } {
  const key = ensureAppLinkSigningKey(input.keyPath)
  const exp = Math.floor(Date.now() / 1000) + Math.floor(input.ttlMs / 1000)
  const payload: AppLinkTokenPayload = {
    v: 1,
    kind: "link",
    appId: input.appId,
    claims: input.claims,
    exp,
    ...(input.pendingTelegramAuth ? { pendingTelegramAuth: true as const } : {}),
  }
  return { token: encode(payload, key), exp }
}

export function verifyAppLinkToken(token: string, keyPath?: string): VerifyAppLinkTokenResult {
  return decode(token, ensureAppLinkSigningKey(keyPath), "link")
}

export interface MintAppLinkSessionTokenInput {
  appId: string
  claims: Record<string, string>
  ttlMs: number
  keyPath?: string
}

/** Mint a `"session"` token — ONLY ever called by `authorizeAppLink` after
 *  a Telegram identity check succeeded. This is what
 *  `dispatchAllowlistedAppTool`'s scoped mode and the tunnel-gate's
 *  read-route bypass accept. */
export function mintAppLinkSessionToken(input: MintAppLinkSessionTokenInput): { token: string; exp: number } {
  const key = ensureAppLinkSigningKey(input.keyPath)
  const exp = Math.floor(Date.now() / 1000) + Math.floor(input.ttlMs / 1000)
  const payload: AppLinkTokenPayload = { v: 1, kind: "session", appId: input.appId, claims: input.claims, exp }
  return { token: encode(payload, key), exp }
}

export function verifyAppLinkSessionToken(token: string, keyPath?: string): VerifyAppLinkTokenResult {
  return decode(token, ensureAppLinkSigningKey(keyPath), "session")
}

/** The raw signature half of a token (everything after the first `.`) —
 *  used as the single-use key in `app-link-auth.ts`'s consumed-token set.
 *  Two tokens can share a signature only if they share a key and payload,
 *  so this is as good a dedup key as the whole token string, without
 *  holding onto the (slightly larger) payload half in memory. */
export function appLinkTokenSignature(token: string): string {
  const dot = token.indexOf(".")
  return dot === -1 ? token : token.slice(dot + 1)
}

/** Extract a bearer-shaped token from a request: `Authorization: Bearer
 *  <token>` first, else `?token=` — the same two shapes
 *  `tunnelBearerAllowed`/`checkSessionsToken` already accept for the full
 *  daemon bearer (http-server.ts), so an EventSource (which can't set
 *  headers) can carry it in the URL. */
export function extractAppLinkBearer(req: { headers: { authorization?: string }; url?: string }): string | undefined {
  const header = req.headers.authorization
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice("Bearer ".length)
  const urlStr = req.url ?? ""
  const qIdx = urlStr.indexOf("?")
  if (qIdx === -1) return undefined
  const token = new URLSearchParams(urlStr.slice(qIdx + 1)).get("token")
  return token ?? undefined
}
