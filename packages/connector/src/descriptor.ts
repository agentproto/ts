/**
 * ConnectorMcpDescriptor — the portable, host-agnostic description of an MCP
 * connector: how its MCP server runs / is reached. Lifted out of guilde (where
 * it lived as a private flat-bag interface) so ANYONE — not just guilde — can
 * describe an MCP connector against the open standard.
 *
 * It is a discriminated union over `kind` so each kind carries only its valid
 * fields (the guilde original was a flat optional-bag where every field could
 * appear on any kind). The four kinds:
 *
 *   - `hosted`        — the platform runs the MCP server; creds passed in.
 *   - `sandbox`       — ephemeral per-install process spawned from a package /
 *                       entry point (DXT-parallel).
 *   - `external`      — the user points the platform at their own MCP URL.
 *   - `local-daemon`  — the MCP server runs on the user's own agentproto daemon
 *                       and is reached over a reverse tunnel. No URL / no creds
 *                       on the descriptor — dispatch is pinned to a daemon
 *                       identity and routed by `importAlias`.
 *
 * What does NOT live here: catalog/marketplace metadata (category, logo,
 * vendor, billing, auth-method UI), vault wiring, DB persistence, and any
 * host-specific resolution (e.g. guilde's bureau device-link). Those stay in
 * the consumer (guilde's `ConnectorProviderConfig` wraps this via its `mcp`
 * field). This type is just the runnable description.
 */

/** Fields common to every connector kind. */
interface ConnectorMcpBase {
  /** URL-safe slug used when assigning this connector to agents / operators. */
  slug: string
  /** Set when auth is delegated to an OAuth provider (provider slug). */
  oauthProvider?: string
}

/** The platform runs the MCP server at a known URL; credentials are injected. */
export interface HostedConnectorMcp extends ConnectorMcpBase {
  kind: "hosted"
  /**
   * MCP endpoint URL. A host MAY template this (e.g. guilde injects its
   * public base URL) — the descriptor carries the resolved-or-templated value.
   */
  serverUrl: string
}

/**
 * Ephemeral per-install process spawned from a package / entry point — the
 * DXT-parallel local-process model. Fields mirror a minimal process spec.
 */
export interface SandboxConnectorMcp extends ConnectorMcpBase {
  kind: "sandbox"
  /** Runtime the entry point targets. */
  runtime?: "node" | "python"
  /** Entry point (file / module) the runtime executes. */
  entryPoint?: string
  /** Extra arguments passed to the entry point. */
  args?: string[]
  /** Static (non-secret) environment for the spawned process. Secrets reach
   *  the process via the connector's credential requirements, not here. */
  env?: Record<string, string>
  /** npm/PyPI package the entry point lives in, when applicable. */
  packageName?: string
}

/** The user points the platform at their own already-running MCP server. */
export interface ExternalConnectorMcp extends ConnectorMcpBase {
  kind: "external"
  /** Optional default; usually supplied by the user at install time. */
  serverUrl?: string
}

/**
 * The MCP server runs on the user's own agentproto daemon and is reached over
 * a reverse tunnel. No URL / creds on the descriptor — dispatch is pinned to a
 * daemon identity and routed by `importAlias`.
 */
export interface LocalDaemonConnectorMcp extends ConnectorMcpBase {
  kind: "local-daemon"
  /** Alias the user's daemon imports this MCP under (e.g. "bureau"). */
  importAlias: string
  /**
   * Tunnel provider this connector rides on — referenced BY SLUG only (one of
   * `@agentproto/runtime`'s built-in tunnel slugs, e.g. `cloudflare-quick` /
   * `cloudflare-named` / `ngrok`, or any third-party
   * `@scope/agentproto-adapter-<slug>`). Resolution to a live provider is the
   * consumer's runtime concern (`resolveTunnelProvider`) — keeping this type
   * out of the runtime layer. Optional: hosts that run a single shared reverse
   * tunnel for all local-daemon connectors leave it unset.
   */
  tunnelProvider?: string
}

/** Discriminated union over the four connector kinds. */
export type ConnectorMcpDescriptor =
  | HostedConnectorMcp
  | SandboxConnectorMcp
  | ExternalConnectorMcp
  | LocalDaemonConnectorMcp

/** All connector kind discriminants. */
export type ConnectorMcpKind = ConnectorMcpDescriptor["kind"]
