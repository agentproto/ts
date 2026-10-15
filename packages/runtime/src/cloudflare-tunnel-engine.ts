/**
 * Public entry for the Cloudflare tunnel engine, for services that provision
 * tunnels on behalf of users (the `cloudflare-provisioned` provider's
 * server side): desired-state reconcile / destroy / hostname removal over
 * the Cloudflare API, with the same ownership marking the daemon's own
 * `cloudflare-managed` provider uses.
 *
 * `@agentproto/runtime/cloudflare-tunnel-engine`
 */

export {
  ManagedTunnelEngine,
  managedTunnelName,
  tunnelCnameTarget,
  buildIngress,
  MANAGED_TUNNEL_PREFIX,
  MANAGED_DNS_COMMENT,
  TUNNEL_CNAME_DOMAIN,
  type ManagedEngineOptions,
  type ManagedTunnelSpec,
  type ReconcileResult,
} from "./remote-providers/cloudflare-managed-engine.js"
export {
  CloudflareApi,
  CloudflareApiError,
  isNotFound,
  type FetchLike,
  type CfDnsRecord,
  type CfIngressRule,
  type CfTunnel,
} from "./remote-providers/cloudflare-api.js"
export {
  makeTokenResolver,
  normalizeHost,
  parseManagedZones,
  resolveZoneForHostname,
  type ManagedZoneConfig,
  type TokenResolver,
} from "./remote-providers/cloudflare-managed-config.js"
