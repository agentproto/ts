/**
 * Thin client for the undocumented Claude Code cloud sessions API
 * (AIP-66 Appendix A). Base https://api.anthropic.com; requests carry
 * `Authorization: Bearer <claude.ai OAuth access token>`,
 * `anthropic-version: 2023-06-01` and `x-organization-uuid`.
 *
 * The credential is the user's claude.ai login, owned by the claude CLI
 * (AIP-66 §8): this module never logs it, never persists it, and never
 * writes it anywhere — it lives only in request headers for the lifetime
 * of a call. Before a request, an expired token (or one expiring within
 * {@link EXPIRY_SKEW_MS}) triggers the injected login refresh, then the
 * source cache is invalidated and re-read. On 401 the same refresh +
 * invalidate + re-read happens once, then the call fails with a message
 * that tells the user how to log in.
 *
 * All network access goes through an injectable `fetch` so tests can drive
 * the client from fixtures — no live Anthropic call is ever made from here.
 */

import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** A claude.ai OAuth credential. `accessToken` is the bearer the API wants;
 *  `orgUuid` is the `x-organization-uuid` header (from `~/.claude.json`'s
 *  `.oauthAccount.organizationUuid`). `expiresAt` is the token's expiry in
 *  epoch milliseconds (the keychain's `.claudeAiOauth.expiresAt`), when the
 *  source knows it. NEVER logged or persisted. */
export interface CloudCredential {
  accessToken: string
  orgUuid?: string
  expiresAt?: number
}

/** A token expiring within this window is treated as expired: refresh it
 *  before sending rather than racing a request against the expiry. */
export const EXPIRY_SKEW_MS = 5 * 60_000

/** Where the host reads the vendor login from (AIP-66 §8). Implementations
 *  must not cache a token across an explicit {@link CredentialSource.invalidate}
 *  — a refresh or a 401 re-read has to be able to observe a fresh login. */
export interface CredentialSource {
  get(): Promise<CloudCredential>
  /** Drop any cached credential so the next {@link get} re-reads the
   *  underlying store (the keychain may have been refreshed out-of-band). */
  invalidate(): void
}

const KEYCHAIN_SERVICE = "Claude Code-credentials"

/** macOS keychain credential: `security find-generic-password -s "Claude
 *  Code-credentials" -w` returns JSON whose `.claudeAiOauth.accessToken` is
 *  the bearer; the org uuid comes from `~/.claude.json`. `execFile` and the
 *  file reader are injectable for tests; the token never leaves this module
 *  except as a request header. */
export function keychainCredentialSource(
  deps: {
    execFileImpl?: (
      cmd: string,
      args: string[],
    ) => Promise<{ stdout: string }>
    readFileSyncImpl?: (path: string) => Promise<string>
    homedir?: () => string
  } = {},
): CredentialSource {
  const execFileImpl =
    deps.execFileImpl ??
    (async (cmd: string, args: string[]) => {
      const { stdout } = await execFileAsync(cmd, args, {
        // `security` writes the secret to stdout only; maxBuffer covers a
        // long JSON blob. Never `echo` it anywhere else.
        maxBuffer: 1 << 20,
      })
      return { stdout }
    })
  const readFileSyncImpl =
    deps.readFileSyncImpl ??
    ((path: string) => readFile(path, "utf8"))
  const home = deps.homedir ?? homedir

  let cached: CloudCredential | null = null

  return {
    async get(): Promise<CloudCredential> {
      if (cached) return cached
      const { stdout } = await execFileImpl("security", [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ])
      const keychain = JSON.parse(stdout) as {
        claudeAiOauth?: { accessToken?: string; expiresAt?: number }
      }
      const accessToken = keychain.claudeAiOauth?.accessToken
      if (!accessToken) {
        throw new Error(
          "claude code cloud: no claudeAiOauth.accessToken in the Claude Code " +
            "keychain entry — run `claude auth login`",
        )
      }
      let orgUuid: string | undefined
      try {
        const rc = JSON.parse(
          await readFileSyncImpl(join(home(), ".claude.json")),
        ) as { oauthAccount?: { organizationUuid?: string } }
        orgUuid = rc.oauthAccount?.organizationUuid
      } catch {
        // org header is best-effort; some CLI versions work without it.
      }
      const expiresAt = keychain.claudeAiOauth?.expiresAt
      cached = {
        accessToken,
        ...(orgUuid ? { orgUuid } : {}),
        ...(typeof expiresAt === "number" ? { expiresAt } : {}),
      }
      return cached
    },
    invalidate() {
      cached = null
    },
  }
}

/** Env credential for hosts/tests that inject the login themselves:
 *  CLAUDE_CLOUD_OAUTH_TOKEN (+ optional CLAUDE_CLOUD_ORG_UUID). */
export function envCredentialSource(
  env: Record<string, string | undefined> = process.env,
): CredentialSource {
  return {
    async get(): Promise<CloudCredential> {
      const accessToken = env.CLAUDE_CLOUD_OAUTH_TOKEN
      if (!accessToken) {
        throw new Error(
          "claude code cloud: CLAUDE_CLOUD_OAUTH_TOKEN is not set — run " +
            "`claude auth login` and use the keychain credential source, or " +
            "inject the token",
        )
      }
      const orgUuid = env.CLAUDE_CLOUD_ORG_UUID
      return { accessToken, ...(orgUuid ? { orgUuid } : {}) }
    },
    invalidate() {
      // The env source has no cache: nothing to drop.
    },
  }
}

// ── wire shapes (observed 2026-10-14, CLI 2.1.296–2.1.299) ──────────────────

/** One entry of GET /v1/code/sessions/{id}/events (newest first). The
 *  `payload` is the Claude Code stream-json SDK message for `user` /
 *  `assistant` / `result` events. */
export interface CloudSessionEvent {
  created_at: string
  event_id: string
  event_type: string
  /** A STRING of an integer, strictly increasing within the session. The
   *  ordering key: parse with `Number()` (see {@link eventSequence}). */
  sequence_num: string
  /** Who produced the event — "worker" (the vendor's harness) or "client". */
  source?: string
  payload: unknown
}

export interface CloudEventsPage {
  data: CloudSessionEvent[]
  /** The `sequence_num` of the OLDEST event on the page, present on the
   *  first (newest) page. Pass back as `?cursor=<n>` to fetch the NEXT
   *  OLDER page — the cursor pages BACKWARD in time, never forward. */
  resume_cursor?: string
  /** Alias for {@link resume_cursor}, seen on the first page only. */
  next_cursor?: string
}

/** Parse an event's `sequence_num` as a number, or null when absent /
 *  non-numeric (such an event cannot be ordered and is skipped). */
export function eventSequence(event: CloudSessionEvent): number | null {
  const raw = event.sequence_num
  if (typeof raw !== "string" || raw.trim() === "") return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** GET /v1/code/sessions/{id} — wrapped in `response_shape`. */
export interface CloudSessionState {
  id: string
  title: string
  status: string
  status_bucket?: string
  worker_status?: string
  connection_status?: string
  last_event_at?: string
  session_url?: string
  post_turn_summary?: string
  [key: string]: unknown
}

export interface CloudGetSessionResponse {
  response_shape: CloudSessionState
  [key: string]: unknown
}

/** One entry of GET /v1/code/sessions — id is spelled `cse_<suffix>`, the
 *  same suffix the CLI's `session_<suffix>` carries. */
export interface CloudSessionSummary {
  id: string
  title: string
  status: "active" | "archived" | string
  environment_kind?: "anthropic_cloud" | "bridge" | string
  config?: { model?: string; origin?: string; [key: string]: unknown }
  created_at?: string
  [key: string]: unknown
}

export interface CloudListSessionsResponse {
  data: CloudSessionSummary[]
  resume_token?: string
}

/**
 * Normalize a session id to the API's own `cse_<suffix>` spelling. Accepts
 * `session_<suffix>` (what the CLI prints and `--cloud` takes) and
 * `cse_<suffix>` (what the API listing returns); rejects anything else so a
 * malformed id can never be interpolated into a request path.
 */
export function normalizeSessionId(id: string): string {
  const trimmed = id.trim()
  if (trimmed.startsWith("session_")) return `cse_${trimmed.slice("session_".length)}`
  if (trimmed.startsWith("cse_")) return trimmed
  throw new Error(
    `claude code cloud: unrecognized session id ${JSON.stringify(id)} — ` +
      "expected session_<id> or cse_<id>",
  )
}

/** Normalize to the CLI's own `session_<suffix>` spelling (for `--cloud`,
 *  `--teleport`). Same acceptance set as {@link normalizeSessionId}. */
export function toCliSessionId(id: string): string {
  const normalized = normalizeSessionId(id)
  return `session_${normalized.slice("cse_".length)}`
}

export interface SessionsApiOptions {
  /** Credential source; invalidated + re-read when the token is expiring or
   *  a request comes back 401, then the call fails. */
  credentials: CredentialSource
  /** Refresh the vendor login before re-reading an expired credential and on
   *  a 401 (e.g. cli.ts's refreshLogin). Omit to skip refreshing. */
  refreshLogin?: () => Promise<void>
  /** Injectable fetch — tests pass a fixture router; default is globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Override for proxies/mirrors; default https://api.anthropic.com. */
  baseUrl?: string
}

const UNAUTHORIZED_HINT = "run `claude auth login`"

/** True when the token is already expired or expires within the skew window
 *  (or when the source reports no expiry, in which case we cannot know). */
export function isCredentialExpiring(
  credential: CloudCredential,
  now = Date.now(),
): boolean {
  return (
    credential.expiresAt !== undefined &&
    credential.expiresAt - now <= EXPIRY_SKEW_MS
  )
}

export class SessionsApi {
  readonly #credentials: CredentialSource
  readonly #refreshLogin?: () => Promise<void>
  readonly #fetch: typeof fetch
  readonly #baseUrl: string
  #credential: CloudCredential | null = null

  constructor(options: SessionsApiOptions) {
    this.#credentials = options.credentials
    this.#refreshLogin = options.refreshLogin
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.#baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")
  }

  /** GET /v1/code/sessions/{id} */
  async getSession(id: string): Promise<CloudGetSessionResponse> {
    return this.#request<CloudGetSessionResponse>(
      "GET",
      `/v1/code/sessions/${normalizeSessionId(id)}`,
    )
  }

  /**
   * GET /v1/code/sessions/{id}/events — newest first. With no `cursor` this
   * returns the NEWEST page; pass the page's `resume_cursor` (the oldest
   * event's `sequence_num`) as `cursor` to fetch the next OLDER page.
   */
  async listEvents(
    id: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<CloudEventsPage> {
    const params = new URLSearchParams()
    if (opts.cursor) params.set("cursor", opts.cursor)
    if (opts.limit !== undefined) params.set("limit", String(opts.limit))
    const qs = params.toString()
    return this.#request<CloudEventsPage>(
      "GET",
      `/v1/code/sessions/${normalizeSessionId(id)}/events${qs ? `?${qs}` : ""}`,
    )
  }

  /** GET /v1/code/sessions?limit=N */
  async listSessions(
    opts: { limit?: number } = {},
  ): Promise<CloudListSessionsResponse> {
    const qs = opts.limit !== undefined ? `?limit=${opts.limit}` : ""
    return this.#request<CloudListSessionsResponse>(
      "GET",
      `/v1/code/sessions${qs}`,
    )
  }

  async #credentialNow(): Promise<CloudCredential> {
    if (!this.#credential) this.#credential = await this.#credentials.get()
    return this.#credential
  }

  /** Refresh the login (when injected), drop the source cache, and re-read.
   *  A refresh failure is surfaced to the caller — better a clear "run
   *  `claude auth login`" than a request with a known-stale token. */
  async #refreshAndInvalidate(): Promise<void> {
    await this.#refreshLogin?.()
    this.#credentials.invalidate()
    this.#credential = null
  }

  /** The credential for the next request: refresh first when it is expired
   *  or expiring. Without an injected refresh the check is a no-op. */
  async #freshCredential(): Promise<CloudCredential> {
    const credential = await this.#credentialNow()
    if (this.#refreshLogin && isCredentialExpiring(credential)) {
      await this.#refreshAndInvalidate()
      return this.#credentialNow()
    }
    return credential
  }

  async #request<T>(method: string, path: string, retriedAuth = false): Promise<T> {
    // On the retry the refresh already ran; read the source directly so a
    // still-stale-looking `expiresAt` cannot start a second refresh.
    const credential = retriedAuth
      ? await this.#credentialNow()
      : await this.#freshCredential()
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.accessToken}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...(credential.orgUuid ? { "x-organization-uuid": credential.orgUuid } : {}),
    }
    const res = await this.#fetch(`${this.#baseUrl}${path}`, { method, headers })
    if (res.status === 401 && !retriedAuth) {
      // The token may have been refreshed out-of-band: refresh the login,
      // drop the source cache and re-read exactly once, then fail closed
      // with the login hint.
      await this.#refreshAndInvalidate()
      return this.#request<T>(method, path, true)
    }
    if (res.status === 401) {
      throw new Error(`claude code cloud: unauthorized (401) — ${UNAUTHORIZED_HINT}`)
    }
    if (!res.ok) {
      throw new Error(
        `claude code cloud: ${method} ${path} failed: HTTP ${res.status}`,
      )
    }
    return (await res.json()) as T
  }
}
