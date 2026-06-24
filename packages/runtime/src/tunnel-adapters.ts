/**
 * Tunnel family on top of `@agentproto/adapter-kit` — the PILOT consumer.
 *
 * This module is the entire bridge between the generic kit and the two
 * concrete Cloudflare tunnel providers. It contributes nothing the kit
 * already owns (catalog/status/creds/ledger/list/MCP-tool plumbing); it
 * only supplies the tunnel-family `TInfo` (`TunnelAdapterInfo`), the
 * static `TUNNEL_CATALOG`, and the resolver that maps a catalog slug to a
 * concrete {@link TunnelProviderHandle}.
 *
 * Kit primitives used:
 *   - `makeCredsStore`      → per-slug 0600 creds under `~/.agentproto/tunnel-creds/`
 *   - `makeSetupLedger`     → `~/.agentproto/setup/<slug>.json`
 *   - `makeAdapterResolver` → wraps the throwing `load` into null-on-miss
 *   - `makeAdapterLister`   → catalog → status-classified `AdapterEntry[]`
 *   - `makeListTool`        → registers `list_tunnel_adapters`
 *   - `makeSetupTool`       → registers `setup_tunnel_provider` (multi-field form:
 *                             hostname + tunnelId + credentialsFile?, all sensitive)
 *
 * Security: `toTunnelInfo` exposes only `capabilities` — never a cred value
 * (Appendix B). The setup tool's fields are marked SENSITIVE and the result
 * NEVER echoes any field value back.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  makeCredsStore,
  makeSetupLedger,
  makeAdapterResolver,
  makeAdapterLister,
  makeListTool,
  makeSetupTool,
  type AdapterCatalog,
  type AdapterLister,
  type CredsStore,
  type SetupField,
  type SetupLedger,
} from "@agentproto/adapter-kit"

import {
  quickTunnelProvider,
  CLOUDFLARE_QUICK_SLUG,
} from "./remote-providers/quick.js"
import {
  namedTunnelProvider,
  CLOUDFLARE_NAMED_SLUG,
} from "./remote-providers/named.js"
import {
  ngrokTunnelProvider,
  NGROK_SLUG,
  type TunnelNgrokCreds,
} from "./remote-providers/ngrok.js"
import type {
  TunnelProviderHandle,
  TunnelProviderCapabilities,
} from "./remote-providers/types.js"

/** Creds-store / ledger family key → `~/.agentproto/tunnel-creds/`. */
export const TUNNEL_FAMILY = "tunnel"

/**
 * Family descriptor (`TInfo`). Pure metadata surfaced in
 * `list_tunnel_adapters`. The kit's `AdapterEntry` already carries
 * slug/name/description/status/version, so the only tunnel-specific field
 * is the declared capability set. NEVER carries a cred value.
 */
export interface TunnelAdapterInfo {
  capabilities: TunnelProviderCapabilities
}

/**
 * Structured credentials for `cloudflare-named`. Collected from the
 * multi-field setup tool (hostname + tunnelId + credentialsFile?).
 */
export interface TunnelNamedCreds {
  hostname: string
  tunnelId: string
  credentialsFile?: string
}

/** Union of all tunnel-family credential shapes (per-slug). */
export type TunnelProviderCreds = TunnelNamedCreds | TunnelNgrokCreds

/** Static catalog of the three providers. */
export const TUNNEL_CATALOG: AdapterCatalog = [
  {
    slug: CLOUDFLARE_QUICK_SLUG,
    name: "Cloudflare Quick Tunnel",
    description:
      "Zero-credential Cloudflare tunnel. Ephemeral *.trycloudflare.com URL, fresh each run.",
    packageName: "@agentproto/runtime",
    hint: "cloudflare · ephemeral",
  },
  {
    slug: CLOUDFLARE_NAMED_SLUG,
    name: "Cloudflare Named Tunnel",
    description:
      "Persistent Cloudflare tunnel bound to a stable hostname you control (BYO credentials).",
    packageName: "@agentproto/runtime",
    hint: "cloudflare · stable",
  },
  {
    slug: NGROK_SLUG,
    name: "Ngrok Tunnel",
    description:
      "Ngrok tunnel with optional static domain support. Requires a free authtoken.",
    packageName: "@agentproto/runtime",
    hint: "ngrok · stable",
  },
]

/** Extract the safe descriptor from a resolved handle. No secrets. */
export function toTunnelInfo(handle: TunnelProviderHandle): TunnelAdapterInfo {
  return { capabilities: handle.capabilities }
}

/** Build the tunnel-family creds store (per-slug, 0600). */
export function makeTunnelCredsStore(
  home?: string,
): CredsStore<TunnelProviderCreds> {
  return makeCredsStore<TunnelProviderCreds>({
    family: TUNNEL_FAMILY,
    ...(home ? { home } : {}),
  })
}

/**
 * Resolve a catalog slug to a concrete handle. All three providers live
 * in-process, so resolution never fails for a known slug — `quick` needs no
 * config; `named` and `ngrok` are built from stored creds when present, else a
 * descriptor-only handle (its `start()` asserts before use, but listing
 * never calls `start()` — per OQ-5 it never calls `check()` either).
 */
export function makeTunnelResolver(credsStore: CredsStore<TunnelProviderCreds>) {
  return makeAdapterResolver<TunnelProviderHandle>({
    load: async (slug: string): Promise<TunnelProviderHandle> => {
      if (slug === CLOUDFLARE_QUICK_SLUG) return quickTunnelProvider()
      if (slug === CLOUDFLARE_NAMED_SLUG) {
        const creds = await credsStore.read(CLOUDFLARE_NAMED_SLUG) as TunnelNamedCreds | null
        // Descriptor-only fallback when unconfigured — only `start()`/`stop()`
        // depend on the config, and listing never invokes them.
        return namedTunnelProvider(creds ?? { hostname: "", tunnelId: "" })
      }
      if (slug === NGROK_SLUG) {
        const creds = await credsStore.read(NGROK_SLUG) as TunnelNgrokCreds | null
        return ngrokTunnelProvider(creds ?? undefined)
      }
      throw new Error(`unknown tunnel adapter slug: ${slug}`)
    },
  })
}

/** Build the family lister: catalog → status-classified entries. */
export function makeTunnelLister(opts: {
  credsStore: CredsStore<TunnelProviderCreds>
  ledger: SetupLedger
}): AdapterLister<TunnelAdapterInfo> {
  return makeAdapterLister<TunnelProviderHandle, TunnelAdapterInfo>({
    catalog: TUNNEL_CATALOG,
    resolver: makeTunnelResolver(opts.credsStore),
    ledger: opts.ledger,
    credsStore: opts.credsStore,
    toInfo: toTunnelInfo,
  })
}

/** Slugs that accept a `setup_tunnel_provider` pass (those with creds). */
const SETUP_SLUGS = [CLOUDFLARE_NAMED_SLUG, NGROK_SLUG] as const

/** Multi-field schema for tunnel provider setup (named + ngrok fields). */
const TUNNEL_SETUP_FIELDS: readonly SetupField[] = [
  // ── cloudflare-named fields ────────────────────────────────────
  {
    name: "hostname",
    description: "Cloudflare tunnel hostname (e.g. agent.example.com)",
    required: false,
    sensitive: true,
  },
  {
    name: "tunnelId",
    description: "Cloudflare tunnel UUID (e.g. 11111111-2222-3333-4444-555555555555)",
    required: false,
    sensitive: true,
  },
  {
    name: "credentialsFile",
    description: "Optional path to cloudflared credentials JSON file",
    required: false,
    sensitive: true,
  },
  // ── ngrok fields ──────────────────────────────────────────────
  {
    name: "authToken",
    description: "Ngrok authtoken (from dashboard.ngrok.com/get-started/your-authtoken)",
    required: false,
    sensitive: true,
  },
  {
    name: "domain",
    description: "Optional reserved ngrok static domain (requires paid plan)",
    required: false,
    sensitive: true,
  },
]

export interface RegisterTunnelAdapterToolsOptions {
  /** Home dir override (tests). Defaults to `AGENTPROTO_HOME ?? ~/.agentproto`. */
  home?: string
}

/**
 * Register the tunnel family's adapter-kit MCP tools on the server:
 *   - `list_tunnel_adapters`  (parameterless; status + capabilities, no creds)
 *   - `setup_tunnel_provider` (multi-field: slug + hostname + tunnelId + credentialsFile?;
 *     all field values marked SENSITIVE and never echoed)
 */
export function registerTunnelAdapterTools(
  server: McpServer,
  opts: RegisterTunnelAdapterToolsOptions = {},
): void {
  const credsStore = makeTunnelCredsStore(opts.home)
  const ledger = makeSetupLedger(opts.home ? { home: opts.home } : {})

  makeListTool<TunnelAdapterInfo>({
    server,
    toolName: "list_tunnel_adapters",
    description:
      "List known tunnel providers with their status (supported/available/" +
      "ready), version, and declared capabilities (stableUrl, autostart, " +
      "customDomain, requiresAuth, hasApi). Credentials are never returned. " +
      "Use `setup_tunnel_provider` to configure a provider that needs creds.",
    lister: makeTunnelLister({ credsStore, ledger }),
  })

  makeSetupTool({
    server,
    toolName: "setup_tunnel_provider",
    description:
      "Configure a tunnel provider that requires credentials (e.g. " +
      "cloudflare-named or ngrok). Each field is SENSITIVE — stored 0600 and " +
      "never echoed back in tool results.",
    validSlugs: SETUP_SLUGS,
    fields: TUNNEL_SETUP_FIELDS,
    onSetup: async (slug: string, fields: Record<string, string>) => {
      if (slug === CLOUDFLARE_NAMED_SLUG) {
        if (!fields.hostname || !fields.tunnelId) {
          return { ok: false, hint: "hostname and tunnelId are required" }
        }
        const creds: TunnelNamedCreds = {
          hostname: fields.hostname,
          tunnelId: fields.tunnelId,
          ...(fields.credentialsFile
            ? { credentialsFile: fields.credentialsFile }
            : {}),
        }
        await credsStore.write(slug, creds)
      } else if (slug === NGROK_SLUG) {
        if (!fields.authToken) {
          return { ok: false, hint: "authToken is required" }
        }
        const creds: TunnelNgrokCreds = {
          authToken: fields.authToken,
          ...(fields.domain && fields.domain.length > 0
            ? { domain: fields.domain }
            : {}),
        }
        await credsStore.write(slug, creds)
      } else {
        return { ok: false, hint: `unknown slug: ${slug}` }
      }
      const now = new Date().toISOString()
      await ledger.write(slug, {
        slug,
        completedAt: now,
        steps: [{ id: "creds", completedAt: now }],
      })
      return { ok: true, hint: `${slug} configured — status is now ready` }
    },
  })
}