/**
 * Tunnel family on top of `@agentproto/provider-kit` — the PILOT consumer.
 *
 * This module is the entire bridge between the generic kit and the two
 * concrete Cloudflare tunnel providers. It contributes nothing the kit
 * already owns (catalog/status/creds/ledger/list/MCP-tool plumbing); it
 * only supplies the tunnel-family `TInfo` (`TunnelAdapterInfo`), the
 * static `TUNNEL_CATALOG`, and the resolver that maps a catalog slug to a
 * concrete {@link TunnelProviderHandle}.
 *
 * Built on `makeProviderFamily` (`@agentproto/provider-kit`), which owns the
 * creds store, the setup ledger, the catalog listing, the resolver, the
 * setup schema and the `list_tunnel_adapters` / `setup_tunnel_provider`
 * tools. `legacySetup` keeps the setup semantics this module had before it
 * moved onto the factory (optional-unless-`required:true`, replace-not-merge,
 * store errors propagate).
 *
 * Security: `toTunnelInfo` exposes only `capabilities` — never a cred value
 * (Appendix B). The setup tool's fields are marked SENSITIVE and the result
 * NEVER echoes any field value back.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  makeCredsStore,
  makeSetupLedger,
  makeMemorySetupLedger,
  makeProviderFamily,
  type AdapterCatalog,
  type AdapterLister,
  type CredsStore,
  type ProviderFamily,
  type SetupLedger,
} from "@agentproto/provider-kit"

import { CLOUDFLARE_QUICK_SLUG } from "./remote-providers/quick.js"
import { CLOUDFLARE_NAMED_SLUG } from "./remote-providers/named.js"
import { NGROK_SLUG, type TunnelNgrokCreds } from "./remote-providers/ngrok.js"
import { CLOUDFLARE_MANAGED_SLUG } from "./remote-providers/cloudflare-managed.js"
import { CLOUDFLARE_PROVISIONED_SLUG } from "./remote-providers/cloudflare-provisioned.js"
import { z } from "zod"
import {
  resolveTunnelProvider,
  discoverTunnelHandles,
  BUILTIN_TUNNEL_PROVIDERS,
  BUILTIN_TUNNEL_SLUGS,
  type TunnelCreds,
} from "./remote-providers/registry.js"
import type {
  TunnelProviderHandle,
  TunnelProviderCapabilities,
} from "./remote-providers/types.js"
import type { DeviceLoginState } from "./remote-providers/oidc-device.js"

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

/**
 * Stored config for `cloudflare-managed` — both JSON strings, see
 * `remote-providers/cloudflare-managed-config.ts`.
 */
export interface TunnelManagedCreds {
  zones: string
  zoneTokens?: string
}

/** Union of all tunnel-family credential shapes (per-slug). */
export type TunnelProviderCreds = TunnelNamedCreds | TunnelNgrokCreds | TunnelManagedCreds

/** Static catalog of the built-in providers. */
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
    slug: CLOUDFLARE_MANAGED_SLUG,
    name: "Cloudflare Managed Tunnel",
    description:
      "Cloudflare tunnel created, routed (DNS) and deleted through the Cloudflare API — stable hostname on your zones.",
    packageName: "@agentproto/runtime",
    hint: "cloudflare · stable · api",
  },
  {
    slug: CLOUDFLARE_PROVISIONED_SLUG,
    name: "Cloudflare Provisioned Tunnel",
    description:
      "Cloudflare tunnel provisioned for you by a remote service after OIDC device login — no Cloudflare token on this machine.",
    packageName: "@agentproto/runtime",
    hint: "cloudflare · stable · login",
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

/**
 * Build the tunnel-family creds store (per-slug, 0600). Stored as a plain
 * string map — the structured {@link TunnelNamedCreds}/{@link TunnelNgrokCreds}
 * shapes are typed *views* used by callers that read specific providers; the
 * generic store accepts any provider's declared fields (incl. third-party),
 * which is what makes setup pluggable.
 */
export function makeTunnelCredsStore(home?: string): CredsStore<TunnelCreds> {
  return makeCredsStore<TunnelCreds>({
    family: TUNNEL_FAMILY,
    ...(home ? { home } : {}),
  })
}

/** A creds store that reads as empty and writes through. Setup resolves
 *  providers with `creds = null` (it never read the stored creds to build its
 *  schema), so a corrupt creds file cannot hide a provider from setup. */
function withoutStoredCreds(store: CredsStore<TunnelCreds>): CredsStore<TunnelCreds> {
  return { ...store, read: async () => null }
}

/** Build the tunnel family on the kit's factory. `legacySetup` keeps the
 *  setup semantics this module had before it moved onto the factory. */
function makeTunnelFamily(opts: {
  credsStore: CredsStore<TunnelCreds>
  ledger: SetupLedger
}): ProviderFamily<TunnelProviderHandle, TunnelAdapterInfo> {
  return makeProviderFamily<TunnelProviderHandle, TunnelAdapterInfo>({
    family: TUNNEL_FAMILY,
    catalog: TUNNEL_CATALOG,
    toInfo: toTunnelInfo,
    credsStore: opts.credsStore,
    ledger: opts.ledger,
    legacySetup: true,
    setupHint: slug => `${slug} configured \u2014 status is now ready`,
    // Third-party providers discovered on disk resolve through the registry
    // too, so `load` is used for every slug, catalog or not.
    load: async (slug, ctx) => resolveTunnelProvider(slug, { creds: ctx.creds }),
    // Third-party providers discovered on disk (both naming conventions).
    discoverExtras: () =>
      discoverTunnelHandles(new Set(TUNNEL_CATALOG.map(c => c.slug))),
  })
}

/**
 * Resolve a catalog slug to a concrete handle via the provider registry:
 * built-ins in-process, third-party packages dynamic-imported. Reads stored
 * creds first so `named`/`ngrok` (and any third-party provider) are built
 * configured when possible; unconfigured slugs resolve to a descriptor-only
 * handle (listing never calls `start()`/`check()`, per OQ-5). An unknown
 * slug resolves to `null` ("supported but not installed").
 */
export function makeTunnelResolver(credsStore: CredsStore<TunnelCreds>) {
  return makeTunnelFamily({
    credsStore,
    ledger: makeMemorySetupLedger(), // resolver only: the ledger is never read
  }).resolve
}

/** Build the family lister: catalog to status-classified entries, plus any
 *  third-party providers discovered on disk (both naming conventions). */
export function makeTunnelLister(opts: {
  credsStore: CredsStore<TunnelCreds>
  ledger: SetupLedger
}): AdapterLister<TunnelAdapterInfo> {
  return makeTunnelFamily(opts).list
}

export interface RegisterTunnelAdapterToolsOptions {
  /** Home dir override (tests). Defaults to `AGENTPROTO_HOME ?? ~/.agentproto`. */
  home?: string
}

/**
 * Register the tunnel family's adapter-kit MCP tools on the server:
 *   - `list_tunnel_adapters`  (parameterless; status + capabilities, no creds)
 *   - `setup_tunnel_provider` (multi-field; fields are union of every
 *     configurable provider's declared `setupFields`, all SENSITIVE and never
 *     echoed). Async because the field schema is derived from resolved handles
 *     (incl. third-party providers discovered on disk).
 */
export async function registerTunnelAdapterTools(
  server: McpServer,
  opts: RegisterTunnelAdapterToolsOptions = {},
): Promise<void> {
  const credsStore = makeTunnelCredsStore(opts.home)
  const ledger = makeSetupLedger(opts.home ? { home: opts.home } : {})

  const family = makeTunnelFamily({ credsStore, ledger })

  await family.registerTools(server, {
    list: {
      name: "list_tunnel_adapters",
      description:
        "List known tunnel providers with their status (supported/available/" +
        "ready), version, and declared capabilities (stableUrl, autostart, " +
        "customDomain, requiresAuth, hasApi). Credentials are never returned. " +
        "Use `setup_tunnel_provider` to configure a provider that needs creds.",
    },
  })

  // The setup tool's schema is built from providers resolved with creds=null
  // (as before), so a corrupt stored-creds file cannot hide one from setup.
  const setupFamily = makeTunnelFamily({ credsStore: withoutStoredCreds(credsStore), ledger })
  await setupFamily.registerTools(server, {
    setup: {
      name: "setup_tunnel_provider",
      description:
        "Configure a tunnel provider that requires credentials (e.g. " +
        "cloudflare-named, cloudflare-managed or ngrok). Fields are stored 0600 " +
        "and never echoed back in tool results. Only the fields a given provider " +
        "declares are stored. cloudflare-managed takes `zones` (JSON array of " +
        "{zone, accountId, tokenRef, zoneId?, maxLabels?}; tokenRef = env:<VAR> | " +
        "file:<path> | keychain:<path> | stored:<key>) and optionally " +
        "`zoneTokens` (JSON {key: token}, for stored:<key> refs). " +
        "cloudflare-provisioned takes `provisionerUrl` and either " +
        "`apiKey` (service-to-service) or `oidcIssuer` + `oidcClientId` " +
        "(+ optional `oidcScopes`, then `tunnel_login`).",
    },
  })

  // ── tunnel_login ─────────────────────────────────────────────────
  // Providers that act on behalf of a user against a remote service (e.g.
  // cloudflare-provisioned) log in with the OIDC device flow: this returns a
  // short code + URL for the human, and the daemon keeps polling in the
  // background. Call again to read the state. Tokens are never returned.
  server.tool(
    "tunnel_login",
    "Log this daemon in to a tunnel provider that acts on your behalf " +
      "(e.g. `cloudflare-provisioned`) using the OIDC device flow. Returns " +
      "`{status:\"pending\", userCode, verificationUri, verificationUriComplete?, " +
      "expiresAt}` — show the human the URL and code; approval happens in " +
      "their browser and the daemon picks it up in the background. Call again " +
      "to read the state (`pending` | `logged_in` | `logged_out` | `failed`). " +
      "`logout:true` forgets the stored session. Tokens are never returned.",
    {
      slug: z.string().describe("Tunnel provider slug, e.g. cloudflare-provisioned"),
      logout: z.boolean().optional().describe("Forget the stored session instead of logging in."),
    },
    async (input: { slug: string; logout?: boolean }) => {
      const result = await tunnelLogin(input.slug, {
        credsStore,
        ...(input.logout ? { logout: true } : {}),
      })
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        ...("error" in result ? { isError: true } : {}),
      }
    },
  )
}

export type TunnelLoginResult = DeviceLoginState | { error: string }

/**
 * Shared by the `tunnel_login` MCP tool, `POST /tunnels/login` and
 * `agentproto tunnel login`: begin a device login (or return the pending /
 * logged-in state), or log out. Never returns a token.
 */
export async function tunnelLogin(
  slug: string,
  opts: { logout?: boolean; credsStore?: CredsStore<TunnelCreds>; home?: string } = {},
): Promise<TunnelLoginResult> {
  try {
    const credsStore = opts.credsStore ?? makeTunnelCredsStore(opts.home)
    const creds = await credsStore.read(slug)
    const handle = await resolveTunnelProvider(slug, { creds })
    if (!handle?.auth) return { error: `provider '${slug}' has no login` }
    if (opts.logout) {
      await handle.auth.logout()
      return { status: "logged_out" }
    }
    const state = await handle.auth.state()
    if (state.status === "logged_in" || state.status === "pending") return state
    const prompt = await handle.auth.begin()
    return { status: "pending", ...prompt }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
/**
 * Validate + store a provider's setup fields (0600 creds store + setup
 * ledger). Shared by the `setup_tunnel_provider` MCP tool and
 * `PUT /tunnels/providers/:slug`. The hint never echoes a field value.
 */
export async function setupTunnelProvider(
  slug: string,
  fields: Record<string, string>,
  opts: { credsStore?: CredsStore<TunnelCreds>; ledger?: SetupLedger; home?: string } = {},
): Promise<{ ok: boolean; hint?: string }> {
  const credsStore = opts.credsStore ?? makeTunnelCredsStore(opts.home)
  const ledger = opts.ledger ?? makeSetupLedger(opts.home ? { home: opts.home } : {})
  // The family resolves the chosen provider so its OWN setupFields (and
  // `validateSetup`) drive validation, built-ins and third-party alike.
  // Setup resolves it with `creds = null`, as it always did: the family
  // reads stored creds only to resolve, so hide them here. Writes still go
  // to the real store.
  return makeTunnelFamily({ credsStore: withoutStoredCreds(credsStore), ledger }).setup(slug, fields)
}

/**
 * Read a provider's login state WITHOUT starting a login (unlike
 * {@link tunnelLogin}, which begins one when logged out).
 */
export async function tunnelLoginState(
  slug: string,
  opts: { credsStore?: CredsStore<TunnelCreds>; home?: string } = {},
): Promise<TunnelLoginResult> {
  try {
    const credsStore = opts.credsStore ?? makeTunnelCredsStore(opts.home)
    const handle = await resolveTunnelProvider(slug, { creds: await credsStore.read(slug) })
    if (!handle?.auth) return { error: `provider '${slug}' has no login` }
    return await handle.auth.state()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
