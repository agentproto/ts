/**
 * Credential store for `agentproto auth login`.
 *
 * Format on disk (JSON, mode 0600):
 *
 *   {
 *     "version": 1,
 *     "hosts": {
 *       "wss://guilde.work/api/v1/agentproto/tunnel": {
 *         "token": "eyJ…",
 *         "tokenType": "Bearer",
 *         "expiresAt": "2026-08-08T12:34:56.000Z",
 *         "refreshToken": "rt_…",      // optional
 *         "scope": "tunnel:connect",
 *         "subject": "user_abc",
 *         "obtainedAt": "2026-05-10T08:21:11.000Z",
 *         "deviceLabel": "jeremy@laptop"
 *       }
 *     }
 *   }
 *
 * One file per *user*, multiple hosts under the same file. Hosts are
 * keyed by the URL the user passed to `agentproto auth login --host`,
 * stripped of trailing slash. `agentproto serve --connect <url>` looks
 * up the same key when no `--token` is passed.
 *
 * Storage location:
 *   - `$AGENTPROTO_HOME/credentials.json`, falling back to
 *   - `~/.agentproto/credentials.json`
 *
 * The file holds bearer tokens, so it's chmod'd 0600 on every write.
 * On Windows we rely on the per-user profile path being already
 * private and skip chmod. Never log the token contents.
 */

import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

export interface HostCredential {
  /** Bearer token. Bearer-form is the only one supported for v1. */
  token: string
  /** Always "Bearer" today; reserved for future schemes. */
  tokenType: "Bearer"
  /** ISO-8601. May be in the past — callers must check `isExpired`. Absent
   *  when the issuing host didn't report an `expires_in` — treated as a
   *  non-expiring credential. */
  expiresAt?: string
  /** OAuth 2.0 refresh token. Present when the host issues one. */
  refreshToken?: string
  /** Space-separated scopes the token was issued with. */
  scope?: string
  /** Human-readable subject — usually the user id, surfaced in `auth status`. */
  subject?: string
  /** ISO-8601 of when this credential was minted. */
  obtainedAt: string
  /** Friendly device label shown on the host's Machine-tokens page. */
  deviceLabel?: string
  /** Opaque revocation hint surfaced by the host (e.g. JTI). The CLI
   *  passes it back on `auth logout` so the host can revoke the right
   *  row server-side, not just delete the local copy. */
  revocationId?: string
}

interface CredentialsFile {
  version: 1
  hosts: Record<string, HostCredential>
}

const FILE_VERSION = 1 as const

export function credentialsPath(): string {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "credentials.json")
}

export function normaliseHost(host: string): string {
  return host.replace(/\/+$/, "")
}

export async function loadCredentials(): Promise<CredentialsFile> {
  const path = credentialsPath()
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as CredentialsFile
    if (parsed.version !== FILE_VERSION) {
      throw new Error(
        `credentials.json: unknown version ${parsed.version}; expected ${FILE_VERSION}. ` +
          `Delete the file and re-run \`agentproto auth login\`.`
      )
    }
    return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: FILE_VERSION, hosts: {} }
    }
    throw err
  }
}

export async function saveCredentials(file: CredentialsFile): Promise<void> {
  const path = credentialsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(file, null, 2))
  await chmod(path, 0o600).catch(() => {
    // Windows + some sandboxed FSes (e.g. WSL on a Windows mount) don't
    // honour chmod. The file lives under the user profile in those
    // cases, which is already user-private; not worth refusing.
  })
}

export async function readHost(host: string): Promise<HostCredential | null> {
  const f = await loadCredentials()
  return f.hosts[normaliseHost(host)] ?? null
}

export async function writeHost(
  host: string,
  cred: HostCredential
): Promise<void> {
  const f = await loadCredentials()
  f.hosts[normaliseHost(host)] = cred
  await saveCredentials(f)
}

export async function deleteHost(host: string): Promise<HostCredential | null> {
  const f = await loadCredentials()
  const key = normaliseHost(host)
  const prev = f.hosts[key] ?? null
  if (prev) {
    delete f.hosts[key]
    if (Object.keys(f.hosts).length === 0) {
      // Empty file is a valid state (`auth login` re-creates), but
      // unlinking is cleaner — `auth status` then prints "no credentials".
      await unlink(credentialsPath()).catch(() => {})
    } else {
      await saveCredentials(f)
    }
  }
  return prev
}

export function isExpired(cred: HostCredential, gracePeriodMs = 30_000): boolean {
  if (!cred.expiresAt) return false // no expiry reported → treat as durable
  const exp = Date.parse(cred.expiresAt)
  if (!Number.isFinite(exp)) return false // unparseable expiry → trust the host
  return exp - gracePeriodMs <= Date.now()
}

export function formatExpiry(cred: HostCredential): string {
  if (!cred.expiresAt) return "no expiry reported"
  const exp = new Date(cred.expiresAt)
  if (Number.isNaN(exp.getTime())) return "unknown"
  const ms = exp.getTime() - Date.now()
  if (ms < 0) return `expired ${formatRelative(-ms)} ago`
  return `expires in ${formatRelative(ms)}`
}

function formatRelative(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}
