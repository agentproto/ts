/**
 * Provisioned Cloudflare Tunnel provider — `cloudflare-provisioned`.
 *
 * For daemons that must NOT hold a Cloudflare API token (an end user's
 * machine): a remote provisioning service owns the Cloudflare account and
 * the zone, and the daemon only ever receives the connector token of its
 * own tunnel. The daemon authenticates to that service as the user via OIDC
 * device login (`tunnel_login`), so the service can check who is asking
 * (and whether they are entitled to a tunnel) before creating anything.
 *
 * ## Provisioner contract (v1)
 *
 * All calls carry `Authorization: Bearer <OIDC access token>`.
 *
 *   PUT    {provisionerUrl}/v1/tunnels/{key}
 *          body  { service: "http://127.0.0.1:<port>" | null, hostnames: string[] }
 *          200   { tunnelId, hostnames: string[], token }
 *   DELETE {provisionerUrl}/v1/tunnels/{key}            → 2xx | 404
 *
 * - `key` is the daemon's stable tunnel identity; the service namespaces it
 *   per user, so two users' keys never collide.
 * - `hostnames` is a request (primary first). Empty = "assign me one". The
 *   service decides what is allowed and returns what it actually routed.
 * - `service: null` = the tunnel isn't running here; keep the current origin.
 * - PUT is idempotent and replayed on every start, like the managed engine.
 * - Errors: JSON `{ error, message, checkoutUrl? }`. 401 → the daemon
 *   refreshes its token once, then asks for `tunnel_login`; 402 → payment
 *   required, `checkoutUrl` is surfaced to the user; 409 → hostname taken.
 *
 * Everything after the PUT — supervised `cloudflared`, token in env only,
 * health probes — is the shared {@link CloudflaredRunner}.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { FetchLike } from "./cloudflare-api.js"
import { normalizeHost } from "./cloudflare-managed-config.js"
import { managedTunnelName } from "./cloudflare-managed-engine.js"
import {
  CloudflaredRunner,
  cloudflaredOnPath,
  type CloudflaredRunnerDeps,
} from "./cloudflared-runner.js"
import {
  OidcDeviceClient,
  OidcError,
  type OidcSession,
  type OidcSessionStore,
} from "./oidc-device.js"
import type {
  ProviderStartOptions,
  ProviderStartResult,
  RemoteProvider,
  TunnelHealth,
  TunnelIdentity,
  TunnelProviderHandle,
} from "./types.js"

export const CLOUDFLARE_PROVISIONED_SLUG = "cloudflare-provisioned"

export const PROVISIONED_CAPABILITIES = {
  stableUrl: true,
  autostart: true,
  customDomain: true,
  requiresAuth: true,
  hasApi: true,
} as const

export const PROVISIONED_SETUP_FIELDS = [
  {
    name: "provisionerUrl",
    description:
      "cloudflare-provisioned: base URL of the tunnel provisioning service (e.g. https://api.example.com/tunnels).",
    required: true,
    sensitive: false,
  },
  {
    name: "oidcIssuer",
    description:
      "cloudflare-provisioned: OIDC issuer the provisioning service trusts (e.g. https://auth.example.com). Must support the Device Code grant.",
    required: true,
    sensitive: false,
  },
  {
    name: "oidcClientId",
    description:
      "cloudflare-provisioned: public (native) OIDC client id used for device login — not a secret.",
    required: true,
    sensitive: false,
  },
  {
    name: "oidcScopes",
    description:
      'cloudflare-provisioned: optional space-separated scopes (default "openid profile email offline_access").',
    required: false,
    sensitive: false,
  },
] as const

interface ProvisionedConfig {
  provisionerUrl: string
  oidcIssuer: string
  oidcClientId: string
  oidcScopes?: string
}

function parseConfig(creds: Record<string, string> | null | undefined): ProvisionedConfig {
  const need = (k: keyof ProvisionedConfig): string => {
    const v = creds?.[k]
    if (!v) {
      throw new Error(
        `cloudflare-provisioned is not configured: run setup_tunnel_provider with ${k} ` +
          "(provisionerUrl, oidcIssuer, oidcClientId)",
      )
    }
    return v
  }
  const cfg: ProvisionedConfig = {
    provisionerUrl: need("provisionerUrl").replace(/\/$/, ""),
    oidcIssuer: need("oidcIssuer").replace(/\/$/, ""),
    oidcClientId: need("oidcClientId"),
    ...(creds?.oidcScopes ? { oidcScopes: creds.oidcScopes } : {}),
  }
  for (const k of ["provisionerUrl", "oidcIssuer"] as const) {
    let u: URL
    try {
      u = new URL(cfg[k])
    } catch {
      throw new Error(`cloudflare-provisioned: ${k} must be a URL`)
    }
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]"
    if (u.protocol !== "https:" && !loopback) {
      throw new Error(`cloudflare-provisioned: ${k} must use https (bearer tokens travel on it)`)
    }
  }
  return cfg
}

/** Owner-only JSON file holding the OIDC session for one provider slug. */
export function fileSessionStore(path: string): OidcSessionStore {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, "utf8")) as OidcSession
      } catch {
        return null
      }
    },
    async write(session) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(session), { mode: 0o600 })
      await chmod(path, 0o600).catch(() => {})
    },
    async clear() {
      await rm(path, { force: true })
    },
  }
}

function defaultSessionPath(home?: string): string {
  const base = home ?? process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "tunnel-sessions", `${CLOUDFLARE_PROVISIONED_SLUG}.json`)
}

/**
 * Device clients outlive provider handles (handles are rebuilt per call),
 * so an in-flight login keeps polling and its prompt stays retrievable.
 */
const deviceClients = new Map<string, OidcDeviceClient>()

export class ProvisionerError extends Error {
  readonly status: number
  readonly code: string
  readonly checkoutUrl?: string
  constructor(status: number, code: string, message: string, checkoutUrl?: string) {
    super(message)
    this.name = "ProvisionerError"
    this.status = status
    this.code = code
    if (checkoutUrl) this.checkoutUrl = checkoutUrl
  }
}

interface PutResult {
  tunnelId: string
  hostnames: string[]
  token: string
}

export interface CloudflareProvisionedDeps extends CloudflaredRunnerDeps {
  /** Provisioner + OIDC fetch (also the probe fetch unless `probeFetch` is set). */
  fetch?: FetchLike
  /** OIDC session store. Defaults to ~/.agentproto/tunnel-sessions/<slug>.json (0600). */
  sessionStore?: OidcSessionStore
  /** Home dir for the default session store (tests). */
  home?: string
  /** OIDC sleep seam (tests). */
  sleep?: (ms: number) => Promise<void>
}

type ProvisionedProvider = RemoteProvider &
  TunnelProviderHandle & {
    health(): TunnelHealth | null
    probeNow(): Promise<TunnelHealth | null>
  }

export function cloudflareProvisionedTunnelProvider(
  creds: Record<string, string> | null | undefined,
  deps: CloudflareProvisionedDeps = {},
): ProvisionedProvider {
  const fetchImpl: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike)
  let runner: CloudflaredRunner | null = null
  let service: string | null = null

  const oidc = (): OidcDeviceClient => {
    const cfg = parseConfig(creds)
    const sessionPath = defaultSessionPath(deps.home)
    const cacheKey = `${cfg.oidcIssuer}|${cfg.oidcClientId}|${deps.sessionStore ? "injected" : sessionPath}`
    // Injected stores (tests) are never cached across providers.
    const cached = deps.sessionStore ? undefined : deviceClients.get(cacheKey)
    if (cached) return cached
    const client = new OidcDeviceClient({
      config: {
        issuer: cfg.oidcIssuer,
        clientId: cfg.oidcClientId,
        ...(cfg.oidcScopes ? { scopes: cfg.oidcScopes } : {}),
      },
      store: deps.sessionStore ?? fileSessionStore(sessionPath),
      fetch: fetchImpl,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    })
    if (!deps.sessionStore) deviceClients.set(cacheKey, client)
    return client
  }

  /** One provisioner call with a single refresh-and-retry on 401. */
  const call = async (method: "PUT" | "DELETE", key: string, body?: unknown) => {
    const cfg = parseConfig(creds)
    const client = oidc()
    const url = `${cfg.provisionerUrl}/v1/tunnels/${encodeURIComponent(key)}`
    const send = async (token: string) =>
      fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    let res = await send(await client.accessToken())
    if (res.status === 401) res = await send(await client.accessToken({ forceRefresh: true }))
    return res
  }

  const failure = async (res: Awaited<ReturnType<FetchLike>>, what: string): Promise<ProvisionerError> => {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string
      message?: string
      checkoutUrl?: string
    }
    const code = body.error ?? `http_${res.status}`
    let msg = `cloudflare-provisioned: ${what} failed (${res.status})${body.message ? `: ${body.message}` : ""}`
    if (res.status === 401) msg += " — run tunnel_login again"
    if (res.status === 402) {
      msg += body.checkoutUrl ? ` — subscribe at ${body.checkoutUrl}` : " — a subscription is required"
    }
    return new ProvisionerError(res.status, code, msg, body.checkoutUrl)
  }

  const put = async (key: string, hostnames: string[], svc: string | null): Promise<PutResult> => {
    const res = await call("PUT", key, { service: svc, hostnames })
    if (!res.ok) throw await failure(res, "provision")
    const body = (await res.json()) as Partial<PutResult>
    if (!body.tunnelId || !body.token || !Array.isArray(body.hostnames) || body.hostnames.length === 0) {
      throw new ProvisionerError(502, "bad_response", "cloudflare-provisioned: provisioner returned an incomplete tunnel")
    }
    return { tunnelId: body.tunnelId, token: body.token, hostnames: body.hostnames.map(normalizeHost) }
  }

  return {
    id: "provisioned",
    slug: CLOUDFLARE_PROVISIONED_SLUG,
    name: "Cloudflare Provisioned Tunnel",
    version: "builtin",
    description:
      "Cloudflare tunnel provisioned for you by a remote service after OIDC device login — no Cloudflare token on this machine.",
    requiresSetup: true,
    capabilities: { ...PROVISIONED_CAPABILITIES },
    setupFields: PROVISIONED_SETUP_FIELDS,

    validateSetup(fields: Record<string, string>): void {
      parseConfig(fields)
    },

    async check(): Promise<boolean> {
      try {
        parseConfig(creds)
      } catch {
        return false
      }
      return deps.checkBinary ? deps.checkBinary() : cloudflaredOnPath()
    },

    auth: {
      begin: async () => oidc().beginLogin(),
      state: async () => oidc().state(),
      logout: async () => oidc().logout(),
    },

    async start(opts: ProviderStartOptions): Promise<ProviderStartResult> {
      const tunnel = opts.tunnel
      if (!tunnel) throw new Error("cloudflare-provisioned: missing tunnel identity")
      if (runner) throw new Error("cloudflare-provisioned: provider already started")
      parseConfig(creds)
      const r = new CloudflaredRunner({
        ...deps,
        ...(deps.probeFetch || deps.fetch ? { probeFetch: deps.probeFetch ?? fetchImpl } : {}),
      })
      await r.preflight()

      service = `http://${opts.target.host}:${opts.target.port}`
      let rec: PutResult
      try {
        rec = await put(tunnel.key, tunnel.hostnames.map(normalizeHost), service)
      } catch (err) {
        service = null
        if (err instanceof OidcError) throw new Error(`cloudflare-provisioned: ${err.message}`)
        throw err
      }
      runner = r
      try {
        r.start({
          token: rec.token,
          hostnames: rec.hostnames,
          workspace: opts.workspace,
          label: managedTunnelName(tunnel.key),
          ...(opts.onLog ? { onLog: opts.onLog } : {}),
          ...(opts.onHealth ? { onHealth: opts.onHealth } : {}),
        })
      } catch (err) {
        runner = null
        throw new Error(`cloudflare-provisioned: ${err instanceof Error ? err.message : String(err)}`)
      }
      return {
        publicUrl: `https://${rec.hostnames[0]}`,
        pid: r.pid,
        tunnelId: rec.tunnelId,
        hostnames: rec.hostnames,
      }
    },

    async stop(): Promise<void> {
      const r = runner
      runner = null
      service = null
      if (r) await r.stop()
    },

    async destroy(tunnel: TunnelIdentity): Promise<void> {
      const res = await call("DELETE", tunnel.key)
      if (!res.ok && res.status !== 404) throw await failure(res, "delete")
    },

    async addHostname(tunnel: TunnelIdentity, hostname: string): Promise<void> {
      const h = normalizeHost(hostname)
      const next = [h, ...tunnel.hostnames.map(normalizeHost).filter(x => x !== h)]
      const rec = await put(tunnel.key, next, service)
      runner?.setHostnames(rec.hostnames)
    },

    async removeHostname(tunnel: TunnelIdentity, hostname: string): Promise<void> {
      const h = normalizeHost(hostname)
      const rest = tunnel.hostnames.map(normalizeHost).filter(x => x !== h)
      const rec = await put(tunnel.key, rest, service)
      runner?.setHostnames(rec.hostnames)
    },

    health: () => runner?.health() ?? null,
    probeNow: async () => (runner ? runner.probeNow() : null),
  }
}
