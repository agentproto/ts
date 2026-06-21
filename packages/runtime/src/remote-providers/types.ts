/**
 * Shared types for pluggable tunnel providers.
 *
 * Extracted here so both `RemoteController` (single-gateway tunnel) and
 * `TunnelRegistry` (multi-tunnel general surface) can share the same
 * provider contract without creating a circular dep.
 */

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
  readonly id: "quick"
  start(opts: ProviderStartOptions): Promise<ProviderStartResult>
  stop(): Promise<void>
}
