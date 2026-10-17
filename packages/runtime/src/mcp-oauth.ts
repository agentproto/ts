/**
 * Generic OAuth 2.1 for imported MCP servers (RFC 9728 discovery, RFC 7591
 * dynamic client registration, PKCE). Works for any remote MCP that answers
 * 401 + `WWW-Authenticate: Bearer resource_metadata=…`.
 *
 * Two modes share one provider:
 *   - daemon (default): reads the stored client + tokens, refreshes them
 *     through the SDK's `auth()`, and NEVER starts an interactive flow — when
 *     credentials are missing/revoked it throws `McpOAuthLoginRequiredError`
 *     naming `agentproto mcp login <alias>`.
 *   - interactive (`loginMcpOAuth`, used by `agentproto mcp login`): runs the
 *     browser consent on a loopback redirect and stores the result.
 *
 * Everything (DCR client, tokens, PKCE verifier) lives in ONE keychain item
 * per import (`mcpOAuthRef`), reached through the same `resolveMcpSecret` /
 * `storeMcpSecret` seam as header secrets — nothing secret is written to
 * `imported-mcps.json`, logs or errors.
 */

import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { getMcpCredentialDeps } from "./mcp-credential-deps.js"

export const MCP_OAUTH_CLIENT_NAME = "agentproto"

/** Placeholder `redirect_uri` for daemon mode, where no flow ever starts. */
const DAEMON_REDIRECT_URL = "http://127.0.0.1/callback"

/** Keychain ref of an import's OAuth state (same `<path>#<account>` shape as
 *  `mcpSecretRef`). */
export function mcpOAuthRef(importId: string): string {
  return `agentproto/mcp-import/${importId}#oauth:state`
}

/** What a connection config carries to opt into OAuth. Serializable on
 *  purpose: `mcpConfigKey` hashes the whole config. */
export interface McpOAuthConfig {
  importId: string
  alias: string
  scope?: string
}

export interface McpOAuthState {
  /** Origin the credentials were obtained from. Never presented elsewhere. */
  serverOrigin: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  state?: string
}

export interface McpOAuthSecretIO {
  read(ref: string): Promise<string | undefined>
  write(ref: string, value: string): Promise<void>
}

export class McpOAuthLoginRequiredError extends Error {
  constructor(alias: string, reason?: string) {
    super(
      `oauth login required for import "${alias}"${reason ? ` (${reason})` : ""} — run: agentproto mcp login ${alias}`
    )
    this.name = "McpOAuthLoginRequiredError"
  }
}

export interface McpOAuthProviderOptions {
  importId: string
  alias: string
  serverUrl: string
  scope?: string
  io: McpOAuthSecretIO
  /** Present only for the interactive login; absent = daemon mode. */
  interactive?: {
    redirectUrl: string
    onAuthorize: (url: URL) => void | Promise<void>
  }
}

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly ref: string
  private readonly origin: string
  private cache: McpOAuthState | undefined
  private loaded = false

  constructor(private readonly opts: McpOAuthProviderOptions) {
    this.ref = mcpOAuthRef(opts.importId)
    this.origin = new URL(opts.serverUrl).origin
  }

  get redirectUrl(): string {
    return this.opts.interactive?.redirectUrl ?? DAEMON_REDIRECT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: MCP_OAUTH_CLIENT_NAME,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    }
  }

  /** Current stored state, or undefined when absent or bound to another origin. */
  private async load(): Promise<McpOAuthState | undefined> {
    if (!this.loaded) {
      this.loaded = true
      this.cache = undefined
      const raw = await this.opts.io.read(this.ref).catch(() => undefined)
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as McpOAuthState
          if (parsed && typeof parsed === "object" && parsed.serverOrigin === this.origin) {
            this.cache = parsed
          }
        } catch {
          // corrupt blob → treated as absent
        }
      }
    }
    return this.cache
  }

  private async update(patch: Partial<McpOAuthState>): Promise<void> {
    const next: McpOAuthState = { ...(await this.load()), serverOrigin: this.origin, ...patch }
    for (const k of Object.keys(next) as (keyof McpOAuthState)[]) {
      if (next[k] === undefined) delete next[k]
    }
    await this.opts.io.write(this.ref, JSON.stringify(next))
    this.cache = next
    this.loaded = true
  }

  /** Drop everything stored for this import (fresh login starts here). */
  async reset(): Promise<void> {
    await this.opts.io.write(this.ref, JSON.stringify({ serverOrigin: this.origin }))
    this.cache = { serverOrigin: this.origin }
    this.loaded = true
  }

  async expectedState(): Promise<string | undefined> {
    return (await this.load())?.state
  }

  async state(): Promise<string> {
    const state = randomBytes(24).toString("base64url")
    await this.update({ state })
    return state
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const info = (await this.load())?.clientInformation
    if (info) return info
    if (!this.opts.interactive) {
      throw new McpOAuthLoginRequiredError(this.opts.alias, "no stored client")
    }
    return undefined
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.update({ clientInformation: info })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load())?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update({ tokens })
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.interactive) {
      throw new McpOAuthLoginRequiredError(this.opts.alias, "authorization expired or revoked")
    }
    await this.opts.interactive.onAuthorize(url)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update({ codeVerifier })
  }

  async codeVerifier(): Promise<string> {
    const v = (await this.load())?.codeVerifier
    if (!v) throw new Error("oauth: no PKCE code verifier saved — restart the login")
    return v
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery"
  ): Promise<void> {
    if (scope === "discovery") return
    if (scope === "all") return this.reset()
    const patch: Partial<McpOAuthState> =
      scope === "client"
        ? { clientInformation: undefined }
        : scope === "tokens"
          ? { tokens: undefined }
          : { codeVerifier: undefined }
    await this.update(patch)
  }
}

/** The daemon-mode provider for a connection config, backed by the keychain
 *  seam the daemon registered via `setMcpCredentialDeps`. */
export function createDaemonOAuthProvider(
  oauth: McpOAuthConfig,
  serverUrl: string
): McpOAuthProvider {
  const deps = getMcpCredentialDeps()
  if (!deps.resolveMcpSecret || !deps.storeMcpSecret) {
    throw new Error(
      `import "${oauth.alias}" uses oauth but no keychain secret store is configured`
    )
  }
  return new McpOAuthProvider({
    importId: oauth.importId,
    alias: oauth.alias,
    serverUrl,
    ...(oauth.scope ? { scope: oauth.scope } : {}),
    io: { read: deps.resolveMcpSecret, write: deps.storeMcpSecret },
  })
}

export interface McpOAuthLoginOptions {
  importId: string
  alias: string
  serverUrl: string
  scope?: string
  io: McpOAuthSecretIO
  /** Called with the consent URL once discovery + registration are done;
   *  print and/or open it. The scope being requested is in `url.searchParams`. */
  onAuthorizationUrl: (url: URL) => void | Promise<void>
  timeoutMs?: number
}

export interface McpOAuthLoginResult {
  /** Scope string the server actually granted, when it reports one. */
  grantedScope?: string
}

/**
 * Interactive login: fresh DCR + PKCE consent on a one-shot loopback
 * listener (127.0.0.1, ephemeral port, `state`-checked). Starts from a clean
 * slate so the registered `redirect_uri` always matches the listener.
 */
export async function loginMcpOAuth(opts: McpOAuthLoginOptions): Promise<McpOAuthLoginResult> {
  let provider: McpOAuthProvider | undefined
  const callback = await listenForCallback(
    opts.timeoutMs ?? 5 * 60_000,
    async s => {
      const expected = await provider?.expectedState()
      return expected !== undefined && expected === s
    }
  )
  try {
    provider = new McpOAuthProvider({
      importId: opts.importId,
      alias: opts.alias,
      serverUrl: opts.serverUrl,
      ...(opts.scope ? { scope: opts.scope } : {}),
      io: opts.io,
      interactive: { redirectUrl: callback.redirectUrl, onAuthorize: opts.onAuthorizationUrl },
    })
    await provider.reset()
    const authOpts = { serverUrl: opts.serverUrl, ...(opts.scope ? { scope: opts.scope } : {}) }
    const first = await auth(provider, authOpts)
    if (first === "AUTHORIZED") return await grantedOf(provider)
    const { code } = await callback.result
    const second = await auth(provider, { ...authOpts, authorizationCode: code })
    if (second !== "AUTHORIZED") throw new Error("oauth: authorization code exchange did not complete")
    return await grantedOf(provider)
  } finally {
    callback.close()
  }
}

async function grantedOf(provider: McpOAuthProvider): Promise<McpOAuthLoginResult> {
  const scope = (await provider.tokens())?.scope
  return scope ? { grantedScope: scope } : {}
}

interface CallbackListener {
  redirectUrl: string
  /** Settles on the first valid callback; rejects on denial or timeout. */
  result: Promise<{ code: string; state: string }>
  close(): void
}

/** The listener (and its result promise) exist before the consent URL is
 *  shown, so a fast callback can never race ahead of the waiter. */
async function listenForCallback(
  timeoutMs: number,
  stateOk: (state: string) => Promise<boolean>
): Promise<CallbackListener> {
  let settle!: { resolve: (v: { code: string; state: string }) => void; reject: (e: Error) => void }
  const result = new Promise<{ code: string; state: string }>((resolve, reject) => {
    settle = { resolve, reject }
  })
  result.catch(() => {})
  const timer = setTimeout(
    () => settle.reject(new Error(`oauth: no authorization response within ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs
  )
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/callback") {
      res.writeHead(404).end()
      return
    }
    void (async () => {
      const q = url.searchParams
      const error = q.get("error")
      if (error) {
        settle.reject(new Error(`oauth: authorization denied (${error})`))
        res.writeHead(400, { "content-type": "text/plain" }).end("authorization denied")
        return
      }
      const code = q.get("code")
      const state = q.get("state")
      if (!code || !state || !(await stateOk(state))) {
        res.writeHead(400, { "content-type": "text/plain" }).end("invalid authorization response")
        return
      }
      settle.resolve({ code, state })
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<p>agentproto: authorization received. You can close this tab.</p>")
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    result,
    close() {
      clearTimeout(timer)
      server.close()
      server.closeAllConnections?.()
    },
  }
}
