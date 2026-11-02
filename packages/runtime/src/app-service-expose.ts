/**
 * AIP-53 `services[].expose`: a service an app declares can ask the host for
 * a public URL through an AIP-73 tunnel.
 *
 *   services:
 *     - name: miniapp
 *       command: node
 *       args: [dist/miniapp.js]
 *       port: 8788
 *       expose:
 *         auth: service           # guard (default) | service
 *         hostname: session-chat  # optional request
 *
 * One tunnel per exposed service, through the daemon's {@link TunnelRegistry},
 * keyed `app.<a>.<s>.<h>` (`appServiceTunnelKey`, `ensureKeyed`), so a reinstall or a daemon boot
 * gets the SAME tunnel back and the provisioned provider PUTs the same key.
 * The provider is HOST config (`defaults.apps.exposeProvider`), never the
 * app's. The tunnel is ensured BEFORE the process spawns and its bare origin
 * goes to the process as `AGENTPROTO_PUBLIC_URL`; the guard's entry link
 * (with its access token) never does. A failed tunnel is reported per
 * service and never blocks the install nor the process.
 *
 * Out of scope here: AIP-53 Exposure rule 8 (a service running inside an
 * AIP-36 sandbox, connector-token handoff).
 */

import { createHash } from "node:crypto"

import type { AppService, AppServiceExpose } from "@agentproto/app"

import { resolveRegisteredTunnelConfig } from "./app-tunnel-tools.js"
import { parseManagedZones } from "./remote-providers/cloudflare-managed-config.js"
import { CLOUDFLARE_MANAGED_SLUG } from "./remote-providers/cloudflare-managed.js"
import { CLOUDFLARE_PROVISIONED_SLUG } from "./remote-providers/cloudflare-provisioned.js"
import { builtinProviderCapabilities, normalizeProviderSlug } from "./remote-providers/registry.js"
import type { TunnelDescriptor, TunnelRegistry, TunnelStatus } from "./tunnel-registry.js"

/** Env var carrying the public origin to an exposed service's process. */
export const APP_SERVICE_PUBLIC_URL_ENV = "AGENTPROTO_PUBLIC_URL"

/** Fallback provider when no stable one is registered (not `stableUrl`). */
export const APP_SERVICE_EXPOSE_FALLBACK_PROVIDER = "cloudflare-quick"

/** A service that declares `expose` (and therefore, by validation, `port`). */
export type ExposedAppService = AppService & { readonly port: number; readonly expose: AppServiceExpose }

export function isExposedService(service: AppService): service is ExposedAppService {
  return service.expose !== undefined && service.port !== undefined
}

/**
 * The AIP-73 tunnel key of one exposed service (AIP-53 Exposure rule 2,
 * "Tunnel key"): `app.<a>.<s>.<h>`. `<a>` is the app id lowercased, every run
 * outside `[a-z0-9-]` replaced by `-`, edge `-` trimmed, cut to 24; `<s>` the
 * service name cut to 24; `<h>` the first 8 hex of sha256(`<appId>:<name>`)
 * over the ORIGINAL id. Always matches the provisioner key alphabet
 * `^[a-z0-9][a-z0-9._-]{0,62}$`. Derived exactly so another host of the same
 * user finds the same tunnel.
 */
export function appServiceTunnelKey(appId: string, name: string): string {
  const a = appId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  const s = name.slice(0, 24)
  const h = createHash("sha256").update(`${appId}:${name}`, "utf8").digest("hex").slice(0, 8)
  return `app.${a}.${s}.${h}`
}

/** Per-service exposure report (AIP-53 Exposure rule 6). */
export interface AppServiceExposure {
  name: string
  auth: "guard" | "service"
  /** False when the provider has no stable URL (the quick fallback). */
  stable: boolean
  /** Tunnel state; `error` when the tunnel could not be created. */
  state: TunnelStatus
  /** Public origin, `https://<host>`: no path, never an access token. */
  publicUrl?: string
  /** Registry tunnel id (`tunnel_status` / `tunnel_revoke` take it). */
  tunnelId?: string
  provider?: string
  /** Why the tunnel is not up, when it failed. */
  error?: string
}

/** Tunnel seam the service launcher drives. Tests inject a fake. */
export interface AppServiceExposer {
  /** Create or reuse the tunnel of one exposed service. Never throws: a
   *  failure comes back as `state: "error"` with `error`. */
  ensure(appId: string, service: ExposedAppService): Promise<AppServiceExposure>
  /** Current exposure of a service, without touching the tunnel. */
  status(appId: string, service: ExposedAppService): AppServiceExposure | undefined
  /** Names of the app's services that currently hold a tunnel. */
  list(appId: string): string[]
  /** Stop the connector and delete the tunnel (AIP-73 `delete`). */
  remove(appId: string, name: string): Promise<void>
}

export type ReadTunnelCreds = (slug: string) => Promise<Record<string, string> | null>

function registered(creds: Record<string, string> | null): boolean {
  return creds !== null && Object.values(creds).some(v => typeof v === "string" && v !== "")
}

/**
 * The provider an exposed service gets: the configured
 * `defaults.apps.exposeProvider` when set, else `cloudflare-provisioned` when
 * its creds are registered, else `cloudflare-managed` when registered, else
 * `cloudflare-quick`.
 */
export async function selectExposeProvider(opts: {
  configured?: string | undefined
  readCreds: ReadTunnelCreds
}): Promise<string> {
  if (opts.configured !== undefined && opts.configured.trim() !== "") return opts.configured.trim()
  const safeRead = async (slug: string) => {
    try {
      return await opts.readCreds(slug)
    } catch {
      return null
    }
  }
  if (registered(await safeRead(CLOUDFLARE_PROVISIONED_SLUG))) return CLOUDFLARE_PROVISIONED_SLUG
  if (registered(await safeRead(CLOUDFLARE_MANAGED_SLUG))) return CLOUDFLARE_MANAGED_SLUG
  return APP_SERVICE_EXPOSE_FALLBACK_PROVIDER
}

/** Whether a provider slug yields a URL that survives a restart. Unknown
 *  (third-party) providers are taken at their word: stable. */
export function isStableExposeProvider(slug: string): boolean {
  return builtinProviderCapabilities(slug)?.stableUrl ?? true
}

function slugLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "")
}

/**
 * The hostname request handed to the provider. `cloudflare-managed` needs a
 * full name on a configured zone, so a bare label (or none) is placed under
 * the first registered zone. A quick tunnel takes no hostname at all. Every
 * other provider receives the request as declared (it may assign another).
 */
async function hostnameFor(
  provider: string,
  appId: string,
  service: ExposedAppService,
  readCreds: ReadTunnelCreds,
): Promise<string | undefined> {
  const slug = normalizeProviderSlug(provider)
  const requested = service.expose.hostname
  if (slug === APP_SERVICE_EXPOSE_FALLBACK_PROVIDER) return undefined
  if (slug !== CLOUDFLARE_MANAGED_SLUG) return requested
  if (requested !== undefined && requested.includes(".")) return requested
  const zone = parseManagedZones((await readCreds(CLOUDFLARE_MANAGED_SLUG))?.["zones"])[0]!.zone
  const label = requested ?? (slugLabel(`${service.name}-${appId}`) || service.name)
  return `${label}.${zone}`
}

function originOf(url: string): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.origin === "null" ? undefined : u.origin
  } catch {
    return undefined
  }
}

function exposureOf(service: ExposedAppService, desc: TunnelDescriptor): AppServiceExposure {
  const publicUrl = desc.status === "active" ? originOf(desc.publicUrl) : undefined
  return {
    name: service.name,
    auth: service.expose.auth ?? "guard",
    stable: isStableExposeProvider(desc.provider),
    state: desc.status,
    ...(publicUrl !== undefined ? { publicUrl } : {}),
    tunnelId: desc.id,
    provider: desc.provider,
    ...(desc.status === "error" && desc.lastError !== undefined ? { error: desc.lastError } : {}),
  }
}

/** The service's process env addition: the bare origin, only when the
 *  tunnel is up. */
export function exposureEnv(exposure: AppServiceExposure | undefined): Record<string, string> {
  return exposure?.publicUrl !== undefined ? { [APP_SERVICE_PUBLIC_URL_ENV]: exposure.publicUrl } : {}
}

/** Build the daemon's exposer on top of its {@link TunnelRegistry}. */
export function createTunnelRegistryExposer(opts: {
  registry: TunnelRegistry
  readCreds: ReadTunnelCreds
  /** `defaults.apps.exposeProvider`, read on every ensure (hot config). */
  configuredProvider?: () => Promise<string | undefined>
}): AppServiceExposer {
  const { registry, readCreds } = opts
  /** The app's keyed tunnels, found by the owner stamped on the descriptor
   *  (the derived key is lossy and cannot be parsed back). */
  const owned = (appId: string): TunnelDescriptor[] =>
    registry.list().filter(d => d.key !== undefined && d.owner?.appId === appId)
  return {
    async ensure(appId, service) {
      const key = appServiceTunnelKey(appId, service.name)
      const auth = service.expose.auth ?? "guard"
      let provider: string | undefined
      try {
        let configured: string | undefined
        try {
          configured = await opts.configuredProvider?.()
        } catch {
          configured = undefined
        }
        provider = await selectExposeProvider({ configured, readCreds })
        const hostname = await hostnameFor(provider, appId, service, readCreds)
        const named = await resolveRegisteredTunnelConfig(provider, readCreds)
        const desc = await registry.ensureKeyed({
          key,
          owner: { appId, service: service.name },
          provider,
          targetHost: "127.0.0.1",
          targetPort: service.port,
          label: `app ${appId} service ${service.name}`,
          ...(hostname !== undefined ? { hostname } : {}),
          ...named,
          ...(auth === "service" ? { public: true } : {}),
        })
        return exposureOf(service, desc)
      } catch (err) {
        const desc = registry.findByKey(key)
        return {
          name: service.name,
          auth,
          stable: provider !== undefined ? isStableExposeProvider(provider) : false,
          state: "error",
          ...(desc !== undefined ? { tunnelId: desc.id } : {}),
          ...(provider !== undefined ? { provider } : {}),
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
    status(appId, service) {
      const desc = registry.findByKey(appServiceTunnelKey(appId, service.name))
      return desc !== undefined ? exposureOf(service, desc) : undefined
    },
    list(appId) {
      return [...new Set(owned(appId).map(d => d.owner!.service))]
    },
    async remove(appId, name) {
      const key = appServiceTunnelKey(appId, name)
      for (const desc of owned(appId)) {
        if (desc.owner!.service === name || desc.key === key) await registry.delete(desc.id)
      }
      const stray = registry.findByKey(key)
      if (stray !== undefined) await registry.delete(stray.id)
    },
  }
}
