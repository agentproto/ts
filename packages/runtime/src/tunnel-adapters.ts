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
} from "@agentproto/provider-kit"

import { CLOUDFLARE_QUICK_SLUG } from "./remote-providers/quick.js"
import { CLOUDFLARE_NAMED_SLUG } from "./remote-providers/named.js"
import { NGROK_SLUG, type TunnelNgrokCreds } from "./remote-providers/ngrok.js"
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

/**
 * Resolve a catalog slug to a concrete handle via the provider registry —
 * built-ins in-process, third-party packages dynamic-imported. Reads stored
 * creds first so `named`/`ngrok` (and any third-party provider) are built
 * configured when possible; unconfigured slugs resolve to a descriptor-only
 * handle (listing never calls `start()`/`check()` — per OQ-5). Throws on an
 * unknown slug so the kit's resolver wraps it to `null` ("supported but not
 * installed").
 */
export function makeTunnelResolver(credsStore: CredsStore<TunnelCreds>) {
  return makeAdapterResolver<TunnelProviderHandle>({
    load: async (slug: string): Promise<TunnelProviderHandle> => {
      const creds = await credsStore.read(slug)
      const handle = await resolveTunnelProvider(slug, { creds })
      if (!handle) throw new Error(`unknown tunnel adapter slug: ${slug}`)
      return handle
    },
  })
}

/** Build the family lister: catalog → status-classified entries, plus any
 *  third-party providers discovered on disk (both naming conventions). */
export function makeTunnelLister(opts: {
  credsStore: CredsStore<TunnelCreds>
  ledger: SetupLedger
}): AdapterLister<TunnelAdapterInfo> {
  return makeAdapterLister<TunnelProviderHandle, TunnelAdapterInfo>({
    catalog: TUNNEL_CATALOG,
    resolver: makeTunnelResolver(opts.credsStore),
    ledger: opts.ledger,
    credsStore: opts.credsStore,
    toInfo: toTunnelInfo,
    discoverExtras: () =>
      discoverTunnelHandles(new Set(TUNNEL_CATALOG.map((c) => c.slug))),
  })
}

/**
 * Resolve every provider that declares creds (built-in + third-party) and
 * union their `setupFields` for the `setup_tunnel_provider` tool. Because one
 * tool spans many providers with disjoint fields, the unioned shape is relaxed
 * to all-optional at the zod layer (`required: false`); the genuine per-provider
 * required-ness is enforced in `onSetup` against the chosen provider's handle.
 */
async function collectSetupSchema(): Promise<{
  validSlugs: string[]
  fields: SetupField[]
}> {
  const builtinHandles = Object.values(BUILTIN_TUNNEL_PROVIDERS).map((f) =>
    f(null),
  )
  const extraHandles = await discoverTunnelHandles(new Set(BUILTIN_TUNNEL_SLUGS))
  const setupHandles = [...builtinHandles, ...extraHandles].filter(
    (h) => h.setupFields && h.setupFields.length > 0,
  )

  const validSlugs = setupHandles.map((h) => h.slug)
  const fieldByName = new Map<string, SetupField>()
  for (const h of setupHandles) {
    for (const f of h.setupFields ?? []) {
      // First declaration wins; relax to optional for the cross-provider tool.
      if (!fieldByName.has(f.name)) {
        fieldByName.set(f.name, { ...f, required: false })
      }
    }
  }
  return { validSlugs, fields: [...fieldByName.values()] }
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

  const { validSlugs, fields } = await collectSetupSchema()

  makeSetupTool({
    server,
    toolName: "setup_tunnel_provider",
    description:
      "Configure a tunnel provider that requires credentials (e.g. " +
      "cloudflare-named or ngrok). Each field is SENSITIVE — stored 0600 and " +
      "never echoed back in tool results. Only the fields a given provider " +
      "declares are stored.",
    validSlugs,
    fields,
    onSetup: async (slug: string, fields: Record<string, string>) => {
      // Resolve the chosen provider so its OWN setupFields drive validation —
      // works for built-ins and third-party providers alike.
      const handle = await resolveTunnelProvider(slug)
      const declared = handle?.setupFields
      if (!handle || !declared || declared.length === 0) {
        return { ok: false, hint: `provider '${slug}' is not configurable` }
      }

      const missing = declared
        .filter((f) => f.required === true)
        .map((f) => f.name)
        .filter((name) => {
          const v = fields[name]
          return v === undefined || v.length === 0
        })
      if (missing.length > 0) {
        return {
          ok: false,
          hint: `missing required field(s): ${missing.join(", ")}`,
        }
      }

      // Persist only the provider's declared, non-empty fields.
      const creds: TunnelCreds = {}
      for (const f of declared) {
        const v = fields[f.name]
        if (v !== undefined && v.length > 0) creds[f.name] = v
      }
      await credsStore.write(slug, creds)

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