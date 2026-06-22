/**
 * Shared types for pluggable tunnel providers.
 *
 * Extracted here so both `RemoteController` (single-gateway tunnel) and
 * `TunnelRegistry` (multi-tunnel general surface) can share the same
 * provider contract without creating a circular dep.
 *
 * The tunnel family is the FIRST consumer of `@agentproto/adapter-kit`:
 * {@link TunnelProviderHandle} extends the kit's generic `AdapterHandle`
 * (slug/name/version/description/requiresSetup/check) with the
 * tunnel-specific `capabilities` + the existing `start`/`stop` lifecycle.
 */

import type { AdapterHandle } from "@agentproto/adapter-kit"

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

/**
 * A pluggable tunnel provider.
 *
 * `start` returns the public URL once the upstream tunnel is ready.
 * `stop` is idempotent — calling it twice or on an already-dead child
 * must not throw.
 */
export interface RemoteProvider {
  readonly id: "quick" | "named"
  start(opts: ProviderStartOptions): Promise<ProviderStartResult>
  stop(): Promise<void>
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
  start(opts: ProviderStartOptions): Promise<ProviderStartResult>
  stop(): Promise<void>
}
