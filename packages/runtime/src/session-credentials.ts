/**
 * SESSION CREDENTIALS: a daemon-issued identity token per spawned session
 * (ts#2165 step 5, shadow mode).
 *
 * Today a session proves nothing: `?callerSessionId=` and the
 * `x-agentproto-caller-session-id` header are CLAIMS any local process can
 * make. This store mints, at spawn, a token only the daemon and that
 * session's adapter know; the adapter presents it on the daemon self-mount
 * (`SESSION_TOKEN_HEADER`), and the receiving side can check that the claim
 * and the token agree. In shadow mode nothing is refused: `http-server.ts`
 * only counts verified / mismatching / claim-only / anonymous calls.
 *
 * Token lifecycle (modelled on `parent-relay.ts`'s relay grants):
 *  - The RAW token exists only in the mint result, which the spawn path
 *    hands to the adapter's own copy of its mounts. It never lands on a
 *    descriptor (`SessionDescriptor.mcpServers` is persisted and returned by
 *    read surfaces), in a log, an error message or `sessions.json`.
 *  - The daemon keeps only the token's SHA-256 hash, in memory and in
 *    `session-credentials.json` (0600, atomic rename), reloaded at boot so a
 *    daemon restart keeps live sessions verifiable.
 *  - Every restart / resume / continue-fresh mints a FRESH token; nothing is
 *    ever read back from a descriptor.
 *  - Tokens are REVOKED when their session retires (`index.ts` subscribes
 *    `registry.onSessionRetired`), and a boot prune drops tokens of sessions
 *    the registry no longer knows.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

/** Header carrying the raw session token on a daemon mount. */
export const SESSION_TOKEN_HEADER = "x-agentproto-session-token"

/** Prefix of every raw session token (makes a leaked one recognisable). */
export const SESSION_TOKEN_PREFIX = "apst_"

/** File (under the daemon home) holding the token hashes. Never a raw token. */
export const SESSION_CREDENTIALS_FILE = "session-credentials.json"

/** Default persist location, `<AGENTPROTO_HOME|~/.agentproto>/session-credentials.json`,
 *  the same home-dir resolution as `orchestratorScopesFile()`. */
export function sessionCredentialsFile(): string {
  return resolve(process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto"), SESSION_CREDENTIALS_FILE)
}

/** The record a token stands for. Holds the HASH only. */
export interface SessionCredential {
  /** SHA-256 (hex) of the raw token, see {@link hashSessionToken}. */
  tokenHash: string
  /** The session the token was minted for. */
  sessionId: string
  /** Mint time (epoch ms). */
  mintedAt: number
}

/** Credentials keyed by token hash. */
const credentials = new Map<string, SessionCredential>()

let storePath: string | undefined

/** SHA-256 (hex) of a raw token: the only form the daemon keeps. */
export function hashSessionToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex")
}

/** 32 random bytes in base64url (no padding) is 43 characters. */
const TOKEN_RE = /^apst_[A-Za-z0-9_-]{43}$/

function isCredentialShape(v: unknown): v is SessionCredential {
  if (!v || typeof v !== "object") return false
  const c = v as Record<string, unknown>
  return (
    typeof c.tokenHash === "string" &&
    /^[0-9a-f]{64}$/.test(c.tokenHash) &&
    typeof c.sessionId === "string" &&
    c.sessionId.length > 0 &&
    typeof c.mintedAt === "number"
  )
}

/** Write the hashes to the attached store, atomically and owner-only.
 *  Best-effort: a failed write never breaks a spawn (memory stays
 *  authoritative for this process). The message names the path only. */
function persistCredentials(): void {
  if (!storePath) return
  const path = storePath
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    const body = JSON.stringify({ version: 1, credentials: Array.from(credentials.values()) }, null, 2)
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    console.warn(
      `[session-credentials] could not persist the session credentials to ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function loadCredentials(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return
  }
  try {
    const parsed = JSON.parse(raw) as { credentials?: unknown }
    const list = Array.isArray(parsed.credentials) ? parsed.credentials : []
    for (const c of list) {
      if (!isCredentialShape(c) || credentials.has(c.tokenHash)) continue
      credentials.set(c.tokenHash, { tokenHash: c.tokenHash, sessionId: c.sessionId, mintedAt: c.mintedAt })
    }
  } catch {
    // A corrupt file is ignored (and rewritten on the next mutation).
  }
}

/** Attach the store to `path` and reload the hashes it persisted, so a
 *  daemon restart keeps live sessions verifiable. `keep` (optional) is a
 *  boot prune: a credential whose session it rejects is dropped. Returns a
 *  detach function (a no-op once another store was attached). */
export function attachSessionCredentialStore(opts: {
  path: string
  keep?: (sessionId: string) => boolean
}): () => void {
  loadCredentials(opts.path)
  storePath = opts.path
  let pruned = 0
  if (opts.keep) {
    for (const [hash, c] of credentials) {
      if (!opts.keep(c.sessionId)) {
        credentials.delete(hash)
        pruned++
      }
    }
  }
  if (pruned > 0) persistCredentials()
  const attached = opts.path
  return () => {
    if (storePath === attached) storePath = undefined
  }
}

/** Mint a token for `sessionId`. Returns the RAW token exactly once; only
 *  its hash is kept. The caller must hand it to the adapter and nowhere
 *  else (never a descriptor, a log or an error). */
export function mintSessionToken(sessionId: string): string {
  const raw = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`
  const tokenHash = hashSessionToken(raw)
  credentials.set(tokenHash, { tokenHash, sessionId, mintedAt: Date.now() })
  persistCredentials()
  return raw
}

/** The session a raw token belongs to, or `undefined` when the token is
 *  malformed, unknown or revoked. Never throws. */
export function verifySessionToken(raw: string | undefined): string | undefined {
  if (typeof raw !== "string" || !TOKEN_RE.test(raw)) return undefined
  const hash = hashSessionToken(raw)
  const found = credentials.get(hash)
  if (!found) return undefined
  const a = Buffer.from(found.tokenHash, "hex")
  const b = Buffer.from(hash, "hex")
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
  return found.sessionId
}

/** Whether a live credential is held for `sessionId`. Answers yes or no
 *  only: never a token, a hash or a mint time. */
export function hasSessionCredential(sessionId: string): boolean {
  for (const c of credentials.values()) if (c.sessionId === sessionId) return true
  return false
}

/** Drop every token minted for `sessionId`. Returns how many were dropped. */
export function revokeSessionTokens(sessionId: string): number {
  let revoked = 0
  for (const [hash, c] of credentials) {
    if (c.sessionId === sessionId) {
      credentials.delete(hash)
      revoked++
    }
  }
  if (revoked > 0) persistCredentials()
  return revoked
}

/** Test seam: drop every credential from memory and detach the store (the
 *  file is left as is, so a re-attach simulates a daemon restart). */
export function clearSessionCredentials(): void {
  credentials.clear()
  storePath = undefined
}
