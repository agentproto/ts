/**
 * Sentinel family on top of `@agentproto/provider-kit` — mirrors
 * `tunnel-adapters.ts` exactly (the kit's pilot consumer). Contributes
 * nothing the kit already owns (catalog/status/creds/ledger/list/MCP-tool
 * plumbing); it only supplies the sentinel-family `TInfo`
 * (`SentinelAdapterInfo`), the (empty, for step 2 — see
 * `sentinel-providers/registry.ts`) `SENTINEL_CATALOG`, and the resolver
 * that maps a catalog slug to a concrete {@link SentinelProviderHandle}.
 *
 * Kit primitives used:
 *   - `makeCredsStore`      -> per-slug 0600 creds under `~/.agentproto/sentinel-creds/`
 *   - `makeSetupLedger`     -> `~/.agentproto/setup/<slug>.json`
 *   - `makeAdapterResolver` -> wraps the throwing `load` into null-on-miss
 *   - `makeAdapterLister`   -> catalog -> status-classified `AdapterEntry[]`
 *   - `makeListTool`        -> registers `list_sentinel_adapters`
 *   - `makeSetupTool`       -> registers `setup_sentinel_provider`
 *
 * Security: `toSentinelInfo` exposes only `capabilities` — never a cred
 * value (Appendix B). The setup tool's fields are marked SENSITIVE and the
 * result NEVER echoes any field value back.
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

import {
  resolveSentinelProvider,
  discoverSentinelHandles,
  BUILTIN_SENTINEL_PROVIDERS,
  BUILTIN_SENTINEL_SLUGS,
  type SentinelCreds,
} from "./sentinel-providers/registry.js"
import { LOCAL_GH_SLUG } from "./sentinel-providers/local-gh.js"
import { WEBHOOK_SLUG } from "./sentinel-providers/webhook.js"
import type {
  SentinelProviderHandle,
  SentinelProviderCapabilities,
  SentinelProviderReadiness,
} from "./sentinel-providers/types.js"

/** Creds-store / ledger family key -> `~/.agentproto/sentinel-creds/`. */
export const SENTINEL_FAMILY = "sentinel"

/** Family descriptor (`TInfo`). Pure metadata surfaced in
 *  `list_sentinel_adapters`. NEVER carries a cred value. */
export interface SentinelAdapterInfo {
  capabilities: SentinelProviderCapabilities
  /** Present for providers that can be installed-but-not-operational (the
   *  `webhook` provider without a public URL / hook scope). `ready:false`
   *  carries the actionable `reason`, and the entry's status is downgraded
   *  to `available`. */
  readiness?: SentinelProviderReadiness
}

/** Static catalog of built-in providers. `agentpush` lands in a later step
 *  (design §12). A third-party `agentproto/adapter-<slug>` package
 *  still lists via `discoverExtras` below. */
export const SENTINEL_CATALOG: AdapterCatalog = [
  {
    slug: LOCAL_GH_SLUG,
    name: "Local GitHub CLI",
    description:
      "Zero-infra PR watcher over the host's authenticated `gh` CLI. No " +
      "credentials, no webhook — diffs successive snapshots on a poll timer.",
    packageName: "@agentproto/runtime",
    hint: "github · zero-infra",
  },
  {
    slug: WEBHOOK_SLUG,
    name: "GitHub Webhook",
    description:
      "Push-based PR/repo watcher over a GitHub repository webhook — " +
      "near-real-time, one shared hook per repo. Needs a public daemon URL " +
      "(named tunnel or AGENTPROTO_PUBLIC_URL) and a gh token with admin:repo_hook.",
    packageName: "@agentproto/runtime",
    hint: "github · push · needs public URL",
  },
]

/** Extract the safe descriptor from a resolved handle. No secrets. */
export function toSentinelInfo(handle: SentinelProviderHandle): SentinelAdapterInfo {
  return { capabilities: handle.capabilities }
}

/** Build the sentinel-family creds store (per-slug, 0600). */
export function makeSentinelCredsStore(home?: string): CredsStore<SentinelCreds> {
  return makeCredsStore<SentinelCreds>({
    family: SENTINEL_FAMILY,
    ...(home ? { home } : {}),
  })
}

/**
 * Resolve a catalog slug to a concrete handle via the provider registry —
 * built-ins in-process, third-party packages dynamic-imported. Throws on an
 * unknown slug so the kit's resolver wraps it to `null` ("supported but not
 * installed").
 */
export function makeSentinelResolver(credsStore: CredsStore<SentinelCreds>) {
  return makeAdapterResolver<SentinelProviderHandle>({
    load: async (slug: string): Promise<SentinelProviderHandle> => {
      const creds = await credsStore.read(slug)
      const handle = await resolveSentinelProvider(slug, { creds })
      if (!handle) throw new Error(`unknown sentinel adapter slug: ${slug}`)
      return handle
    },
  })
}

/** Build the family lister: catalog -> status-classified entries, plus any
 *  third-party providers discovered on disk. */
export function makeSentinelLister(opts: {
  credsStore: CredsStore<SentinelCreds>
  ledger: SetupLedger
}): AdapterLister<SentinelAdapterInfo> {
  const resolver = makeSentinelResolver(opts.credsStore)
  const base = makeAdapterLister<SentinelProviderHandle, SentinelAdapterInfo>({
    catalog: SENTINEL_CATALOG,
    resolver,
    ledger: opts.ledger,
    credsStore: opts.credsStore,
    toInfo: toSentinelInfo,
    discoverExtras: () =>
      discoverSentinelHandles(new Set(SENTINEL_CATALOG.map(c => c.slug))),
  })

  // The kit's status engine is I/O-free (installed + setup only) and has no
  // reason field, so operational readiness (public URL, hook scope) is layered
  // on here: a provider that declares `readiness()` and fails it is listed as
  // `available` with the reason in `info.readiness` — never a false `ready`.
  return async () => {
    const entries = await base()
    return Promise.all(
      entries.map(async entry => {
        if (entry.status === "supported" || !entry.info) return entry
        const handle = await resolver(entry.slug)
        if (!handle?.readiness) return entry
        let readiness: SentinelProviderReadiness
        try {
          readiness = await handle.readiness()
        } catch (err) {
          readiness = { ready: false, reason: err instanceof Error ? err.message : String(err) }
        }
        return {
          ...entry,
          ...(readiness.ready ? {} : { status: "available" as const }),
          info: { ...entry.info, readiness },
        }
      }),
    )
  }
}

/**
 * Resolve every provider that declares creds (built-in + third-party) and
 * union their `setupFields` for the `setup_sentinel_provider` tool. Same
 * cross-provider union + all-optional relaxation as `tunnel-adapters.ts`'s
 * `collectSetupSchema` — genuine per-provider required-ness is enforced in
 * `onSetup` against the chosen provider's own handle.
 */
async function collectSetupSchema(): Promise<{
  validSlugs: string[]
  fields: SetupField[]
}> {
  const builtinHandles = Object.values(BUILTIN_SENTINEL_PROVIDERS).map(f => f(null))
  const extraHandles = await discoverSentinelHandles(new Set(BUILTIN_SENTINEL_SLUGS))
  const setupHandles = [...builtinHandles, ...extraHandles].filter(
    h => h.setupFields && h.setupFields.length > 0,
  )

  const validSlugs = setupHandles.map(h => h.slug)
  const fieldByName = new Map<string, SetupField>()
  for (const h of setupHandles) {
    for (const f of h.setupFields ?? []) {
      if (!fieldByName.has(f.name)) {
        fieldByName.set(f.name, { ...f, required: false })
      }
    }
  }
  return { validSlugs, fields: [...fieldByName.values()] }
}

export interface RegisterSentinelAdapterToolsOptions {
  /** Home dir override (tests). Defaults to `AGENTPROTO_HOME ?? ~/.agentproto`. */
  home?: string
}

/**
 * Register the sentinel family's adapter-kit MCP tools on the server:
 *   - `list_sentinel_adapters`  (parameterless; status + capabilities, no creds)
 *   - `setup_sentinel_provider` (multi-field; fields are union of every
 *     configurable provider's declared `setupFields`, all SENSITIVE and
 *     never echoed). With no built-in providers in step 2, both tools start
 *     out listing/accepting only whatever third-party packages are
 *     installed — never a hard error, just an empty catalog until step 3
 *     (`local-gh`) or a third-party package lands.
 */
export async function registerSentinelAdapterTools(
  server: McpServer,
  opts: RegisterSentinelAdapterToolsOptions = {},
): Promise<void> {
  const credsStore = makeSentinelCredsStore(opts.home)
  const ledger = makeSetupLedger(opts.home ? { home: opts.home } : {})

  makeListTool<SentinelAdapterInfo>({
    server,
    toolName: "list_sentinel_adapters",
    description:
      "List known sentinel providers with their status (supported/available/" +
      "ready), version, and declared capabilities (subjects, push, poll, " +
      "durable, needsPublicUrl, requiresAuth, typicalLatencyMs). Credentials " +
      "are never returned. Use `setup_sentinel_provider` to configure a " +
      "provider that needs creds.",
    lister: makeSentinelLister({ credsStore, ledger }),
  })

  const { validSlugs, fields } = await collectSetupSchema()

  makeSetupTool({
    server,
    toolName: "setup_sentinel_provider",
    description:
      "Configure a sentinel provider that requires credentials. Each field " +
      "is SENSITIVE — stored 0600 and never echoed back in tool results. " +
      "Only the fields a given provider declares are stored.",
    validSlugs,
    fields,
    onSetup: async (slug: string, fields: Record<string, string>) => {
      const handle = await resolveSentinelProvider(slug)
      const declared = handle?.setupFields
      if (!handle || !declared || declared.length === 0) {
        return { ok: false, hint: `provider '${slug}' is not configurable` }
      }

      const missing = declared
        .filter(f => f.required === true)
        .map(f => f.name)
        .filter(name => {
          const v = fields[name]
          return v === undefined || v.length === 0
        })
      if (missing.length > 0) {
        return {
          ok: false,
          hint: `missing required field(s): ${missing.join(", ")}`,
        }
      }

      const creds: SentinelCreds = {}
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
