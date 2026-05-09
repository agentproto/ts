/**
 * RemoteController — owns the gateway's "publish to the internet" state.
 *
 * One singleton per gateway. Holds:
 *   - the current tunnel provider's child process (cloudflared, …)
 *   - the bearer token gating /mcp once the tunnel is up
 *   - persisted state in `<workspace>/.agentproto/remote.json`
 *
 * The controller is the *only* component that mutates auth at runtime.
 * The HTTP server reads auth via a getter (see `AuthSource` in
 * http-server.ts), so flipping `enable() / disable()` here takes effect
 * on the next request — no restart, no race.
 *
 * ## Provider model
 *
 * Each provider implements `RemoteProvider` (start / stop / status).
 * v1 ships only `quick` (Cloudflare Quick Tunnel — no API key, no DNS,
 * ephemeral `*.trycloudflare.com` URL). Named CF Tunnel and Tailscale
 * land as additional implementations.
 *
 * ## Token model
 *
 * On enable we generate a 32-byte random bearer token, return it once
 * to the caller, and persist only its sha256 hash to disk. Same model
 * as a Stripe API key — losing the plaintext means rotating, not
 * recovering. This keeps `.agentproto/remote.json` safe to commit by
 * accident (it leaks the URL, not the credential).
 *
 * ## Security note
 *
 * The CF API token (when used by named-tunnel provider) is *never*
 * accepted as MCP tool input. The controller reads it from
 * `~/.config/agentproto/cloudflare.json` or `$CLOUDFLARE_API_TOKEN`.
 * Otherwise a remote agent could exfiltrate it through `remote_enable`.
 */

import { randomBytes, createHash } from "node:crypto"
import { mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

import type { AuthOptions } from "./http-server.js"
import { quickTunnelProvider } from "./remote-providers/quick.js"

export interface RemoteState {
  provider: "quick"
  publicUrl: string
  bearerTokenHash: string
  createdAt: string
  /** PID of the supervised tunnel child process, if any. */
  pid: number | null
  /** Local target the tunnel forwards to (host + port). */
  target: { host: string; port: number }
  /**
   * Whether the tunnel exposes the gateway itself (true) or some other
   * local service (false). Bearer auth + loopback bypass only matter
   * for the gateway path; arbitrary-target tunnels are pure passthrough
   * and the daemon does not gate them.
   */
  exposesGateway: boolean
}

export interface EnableInput {
  provider?: "quick"
  /**
   * Local port to expose. Defaults to the gateway's own port — i.e.
   * "publish this MCP server." Pass any other port to expose a
   * different local service (Supabase 54371, a Vite dev server, …)
   * without spinning up a separate tunnel manager.
   */
  targetPort?: number
  /**
   * Host the tunnel forwards to. Defaults to `127.0.0.1`. Setting it
   * to `localhost` resolves through DNS (IPv6 first on most systems);
   * keep `127.0.0.1` unless the target is explicitly IPv6-bound.
   */
  targetHost?: string
}

export interface EnableResult {
  publicUrl: string
  /**
   * Bearer token issued by this gateway. Only meaningful when the
   * tunnel exposes the gateway itself (default). For arbitrary-target
   * tunnels (`targetPort != gateway.port`) the daemon does not gate
   * the proxied service, and this is omitted.
   */
  bearerToken?: string
  /**
   * `<publicUrl>/mcp`. Only emitted when exposing the gateway.
   */
  mcpEndpoint?: string
  /**
   * Paste-ready `.mcp.json` snippet. Only emitted when exposing the
   * gateway.
   */
  mcpConfigSnippet?: string
  provider: "quick"
  target: { host: string; port: number }
  exposesGateway: boolean
}

export interface RemoteStatus {
  enabled: boolean
  provider?: "quick"
  publicUrl?: string
  pid?: number | null
  createdAt?: string
  target?: { host: string; port: number }
  exposesGateway?: boolean
  /** Last error from the provider, if any (since last enable). */
  lastError?: string
}

/**
 * A pluggable tunnel provider.
 *
 * `start` returns the public URL once the upstream tunnel is ready
 * (e.g. for cloudflared, after parsing the trycloudflare.com URL out of
 * its stderr). `stop` is idempotent — calling it twice or on an
 * already-dead child must not throw.
 */
export interface RemoteProvider {
  readonly id: "quick"
  start(opts: ProviderStartOptions): Promise<ProviderStartResult>
  stop(): Promise<void>
}

export interface ProviderStartOptions {
  /** Local target the tunnel forwards to. */
  target: { host: string; port: number }
  /** Workspace path — for log / state files. */
  workspace: string
  /** Called whenever the provider has a status update worth logging. */
  onLog?: (line: string) => void
}

export interface ProviderStartResult {
  publicUrl: string
  pid: number | null
}

export interface RemoteControllerOptions {
  workspace: string
  port: number
  /** Hook for surfacing provider logs through RuntimeEvents. */
  onLog?: (line: string) => void
}

const STATE_FILE_REL = ".agentproto/remote.json"

export class RemoteController {
  private state: RemoteState | null = null
  private bearerToken: string | null = null
  private provider: RemoteProvider | null = null
  private lastError: string | undefined
  private readonly opts: RemoteControllerOptions

  constructor(opts: RemoteControllerOptions) {
    this.opts = opts
  }

  /**
   * Auth getter handed to startHttpServer. The HTTP server calls this
   * on every request so flipping enable/disable is effective without
   * a restart.
   */
  readonly readAuth = (): AuthOptions => {
    if (this.bearerToken === null) return { mode: "none" }
    return { mode: "bearer", token: this.bearerToken }
  }

  status(): RemoteStatus {
    if (!this.state) {
      return { enabled: false, lastError: this.lastError }
    }
    return {
      enabled: true,
      provider: this.state.provider,
      publicUrl: this.state.publicUrl,
      pid: this.state.pid,
      createdAt: this.state.createdAt,
      target: this.state.target,
      exposesGateway: this.state.exposesGateway,
      lastError: this.lastError,
    }
  }

  async enable(input: EnableInput): Promise<EnableResult> {
    if (this.state) {
      // Idempotent: returning the existing config would leak the
      // bearer token (we only have the hash). Force teardown first so
      // re-enable always rotates the token. Surface this in the docs.
      throw new Error(
        "remote tunnel already active — call remote_disable first to rotate",
      )
    }
    const providerId = input.provider ?? "quick"
    const provider = pickProvider(providerId)
    this.lastError = undefined

    const target = {
      host: input.targetHost ?? "127.0.0.1",
      port: input.targetPort ?? this.opts.port,
    }
    const exposesGateway =
      target.host === "127.0.0.1" && target.port === this.opts.port

    let started: ProviderStartResult
    try {
      started = await provider.start({
        target,
        workspace: this.opts.workspace,
        onLog: line => {
          this.opts.onLog?.(line)
        },
      })
    } catch (err) {
      this.lastError = errToMessage(err)
      throw err
    }

    // Bearer auth + token issuance only matter when the tunnel exposes
    // *this* gateway. For arbitrary-target tunnels (e.g. Supabase on
    // 54371) the daemon is just provisioning a public passthrough; the
    // proxied service does its own authn.
    let bearerToken: string | null = null
    let bearerTokenHash = ""
    if (exposesGateway) {
      bearerToken = randomBytes(32).toString("base64url")
      bearerTokenHash = sha256(bearerToken)
    }

    const state: RemoteState = {
      provider: providerId,
      publicUrl: started.publicUrl,
      bearerTokenHash,
      createdAt: new Date().toISOString(),
      pid: started.pid,
      target,
      exposesGateway,
    }

    this.state = state
    this.bearerToken = bearerToken
    this.provider = provider

    await persistState(this.opts.workspace, state)

    const result: EnableResult = {
      provider: providerId,
      publicUrl: started.publicUrl,
      target,
      exposesGateway,
    }
    if (exposesGateway && bearerToken) {
      const mcpEndpoint = `${started.publicUrl}/mcp`
      result.bearerToken = bearerToken
      result.mcpEndpoint = mcpEndpoint
      result.mcpConfigSnippet = buildMcpConfigSnippet(mcpEndpoint, bearerToken)
    }
    return result
  }

  async disable(): Promise<{ disabled: boolean }> {
    if (!this.state) return { disabled: false }
    const provider = this.provider
    this.state = null
    this.bearerToken = null
    this.provider = null
    if (provider) {
      try {
        await provider.stop()
      } catch (err) {
        this.lastError = errToMessage(err)
      }
    }
    await clearState(this.opts.workspace)
    return { disabled: true }
  }

  /**
   * Stop the provider on gateway shutdown. Does NOT clear persisted
   * state — that survives across restarts so the user can `remote_status`
   * after rebooting and see "stale state, run remote_enable to refresh".
   * (Stale-recovery semantics land in v2; today we just leave the file.)
   */
  async shutdown(): Promise<void> {
    if (this.provider) {
      try {
        await this.provider.stop()
      } catch {
        /* swallow — gateway is shutting down anyway */
      }
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function pickProvider(id: "quick"): RemoteProvider {
  if (id === "quick") return quickTunnelProvider()
  // Exhaustive guard — adding "named-cf" / "tailscale" later forces this
  // switch to be updated, otherwise TS will yell.
  const _exhaustive: never = id
  throw new Error(`unknown remote provider: ${String(_exhaustive)}`)
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function errToMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function persistState(workspace: string, state: RemoteState): Promise<void> {
  const dir = join(workspace, ".agentproto")
  await mkdir(dir, { recursive: true })
  const file = join(dir, "remote.json")
  await writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8")
  // mode 0600 — even though we only persist the hash, the URL itself
  // is sensitive (knowing it lets an attacker brute-force the token).
  try {
    await chmod(file, 0o600)
  } catch {
    /* best-effort on platforms where chmod is a noop */
  }
}

async function clearState(workspace: string): Promise<void> {
  const file = join(workspace, ".agentproto/remote.json")
  if (!existsSync(file)) return
  await rm(file, { force: true })
}

/**
 * Best-effort load of persisted state on boot. We don't restore the
 * bearer token from this — the hash is one-way — so a rebooted gateway
 * that finds a stale `remote.json` will surface it via `remote_status`
 * and require a fresh `remote_enable` to mint a new token.
 *
 * Exposed mostly for diagnostics; not used by the controller today.
 */
export async function loadPersistedState(
  workspace: string,
): Promise<RemoteState | null> {
  const file = join(workspace, STATE_FILE_REL)
  if (!existsSync(file)) return null
  try {
    const raw = await readFile(file, "utf8")
    return JSON.parse(raw) as RemoteState
  } catch {
    return null
  }
}

function buildMcpConfigSnippet(endpoint: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "agentproto-remote": {
          transport: "http",
          url: endpoint,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )
}
