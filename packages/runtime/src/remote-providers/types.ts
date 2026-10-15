/**
 * Shared types for pluggable tunnel providers.
 *
 * Extracted here so both `RemoteController` (single-gateway tunnel) and
 * `TunnelRegistry` (multi-tunnel general surface) can share the same
 * provider contract without creating a circular dep.
 *
 * The tunnel family is the FIRST consumer of `@agentproto/provider-kit`:
 * {@link TunnelProviderHandle} extends the kit's generic `AdapterHandle`
 * (slug/name/version/description/requiresSetup/check) with the
 * tunnel-specific `capabilities` + the existing `start`/`stop` lifecycle.
 */

import type { AdapterHandle, SetupField } from "@agentproto/provider-kit"

export interface ProviderStartOptions {
  /** Local target the tunnel forwards to. */
  target: { host: string; port: number }
  /** Workspace path — for log / state files. */
  workspace: string
  /** Called whenever the provider has a status update worth logging. */
  onLog?: (line: string) => void
  /**
   * The tunnel's stable identity + desired hostnames, for providers that
   * own remote state (e.g. `cloudflare-managed`). Ignored by the others.
   */
  tunnel?: TunnelIdentity
  /** Health updates from providers that monitor themselves. */
  onHealth?: (health: TunnelHealth) => void
}

/** Stable identity of a registry tunnel, as seen by a stateful provider. */
export interface TunnelIdentity {
  /** Survives daemon restarts — the registry passes `name ?? id`. */
  key: string
  /** Hostnames routed to the tunnel, primary first. */
  hostnames: string[]
}

export type TunnelHealthState = "active" | "degraded" | "error"

/** Live health of a self-monitoring tunnel (surfaced in `tunnel_status`). */
export interface TunnelHealth {
  state: TunnelHealthState
  reason?: string
  checkedAt: string
  /** Per-hostname probe result (all hostnames during a swap overlap). */
  hostnames?: Array<{ hostname: string; ok: boolean; reason?: string }>
}

export interface ProviderStartResult {
  publicUrl: string
  pid: number | null
  /** Provider-side tunnel id, when the provider created/looked one up. */
  tunnelId?: string
}

/**
 * A pluggable tunnel provider.
 *
 * `start` returns the public URL once the upstream tunnel is ready.
 * `stop` is idempotent — calling it twice or on an already-dead child
 * must not throw.
 *
 * Providers that own remote state may also implement the optional
 * `destroy` (delete everything they created) and `addHostname` /
 * `removeHostname` (hostname swap with overlap). All three work whether or
 * not the tunnel is currently running.
 */
export interface RemoteProvider {
  readonly id: string
  start(opts: ProviderStartOptions): Promise<ProviderStartResult>
  stop(): Promise<void>
  destroy?(tunnel: TunnelIdentity): Promise<void>
  addHostname?(tunnel: TunnelIdentity, hostname: string): Promise<void>
  removeHostname?(tunnel: TunnelIdentity, hostname: string): Promise<void>
}

/**
 * Declared capabilities of a tunnel provider — pure metadata, surfaced in
 * the adapter listing (`list_tunnel_adapters`). Never carries secrets.
 */
export interface TunnelProviderCapabilities {
  /** Public URL is stable across restarts (fixed hostname). */
  stableUrl: boolean
  /** Supports autostart on daemon boot. */
  autostart: boolean
  /** Supports custom domains (not just *.trycloudflare.com). */
  customDomain: boolean
  /** Requires credentials (API token, tunnel creds file, …). */
  requiresAuth: boolean
  /** Can list/inspect live tunnels via an external API. */
  hasApi: boolean
}

/**
 * A tunnel provider as an adapter-kit handle. Rides on the kit's generic
 * {@link AdapterHandle} (slug/name/version/description/requiresSetup/check)
 * and adds the tunnel-specific `capabilities` plus the concrete `start`/
 * `stop` lifecycle the {@link RemoteProvider}/`TunnelRegistry` path already
 * drives. Quick/named providers satisfy `RemoteProvider & TunnelProviderHandle`
 * so the registry keeps working unchanged while the kit can list them.
 */
export interface TunnelProviderHandle extends AdapterHandle {
  readonly capabilities: TunnelProviderCapabilities
  /**
   * Credential fields this provider accepts via `setup_tunnel_provider`.
   * Each handle self-declares its own creds schema so the setup tool can
   * union them across built-in AND third-party providers with no central
   * field table. Omit (or empty) when the provider needs no credentials
   * (e.g. cloudflare-quick).
   */
  readonly setupFields?: readonly SetupField[]
  start(opts: ProviderStartOptions): Promise<ProviderStartResult>
  stop(): Promise<void>
  /**
   * Optional: validate this provider's stored setup fields before they are
   * persisted (throw with a message naming the bad field, never a value).
   */
  validateSetup?(fields: Record<string, string>): void
}
