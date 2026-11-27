/**
 * The settlement provider registry, mounted with `makeProviderFamily()`
 * (@agentproto/provider-kit). A slug resolves to a `SettlementProvider` from a
 * provider registered in process (tests, a product that bundles one) or from a
 * dynamic import of `@agentproto/billing-<slug>`. No provider lives here: the
 * catalog only names the packages. A package that exports `createProvider`
 * is built through it (env, its options, lazy access to the other providers);
 * otherwise its `default`, `provider` or first provider-shaped export is used.
 */
import {
  makeEnvCredsStore,
  makeMemorySetupLedger,
  makeProviderFamily,
  type AdapterCatalog,
  type FamilyCreds,
  type FamilyHandle,
  type ProviderFamily,
} from "@agentproto/provider-kit"
import { defaultRailEnv, type SettlementCapabilities, type SettlementProvider } from "./settlement.js"

export const BILLING_CATALOG: AdapterCatalog = [
  { slug: "stripe", name: "Stripe", description: "Cards and invoices; the reference rail", packageName: "@agentproto/billing-stripe", hint: "payments · subscriptions · refunds" },
  { slug: "autumn", name: "Autumn", description: "Plans, credits and usage billing on top of Stripe", packageName: "@agentproto/billing-autumn", hint: "plans · credits" },
  { slug: "lemonsqueezy", name: "Lemon Squeezy", description: "Merchant of record that handles VAT", packageName: "@agentproto/billing-lemonsqueezy", hint: "payments · tax" },
]

/** Safe descriptor of a provider. Never carries a credential value. */
export interface BillingProviderInfo {
  slug: string
  secretKeyVariable: string
  webhookSecretVariable: string
  modeVariable: string
  canRefund: boolean
  canSyncCatalog: boolean
  /** What the rail declares it can do. */
  capabilities: SettlementCapabilities
}

/**
 * What a provider package's `createProvider` export receives. A package that
 * needs parameters (options, another provider it delegates to) exports it; a
 * package without parameters may still export a ready provider as `default`
 * or `provider`.
 */
export interface CreateProviderContext {
  /** The environment the registry reads (the provider reads its own variables from it). */
  env: Record<string, string | undefined>
  /** Resolve another provider by slug, lazily. A cycle throws instead of hanging. */
  providers: (slug: string) => Promise<SettlementProvider | null>
  /** `BillingRegistryOptions.providerOptions[slug]`. */
  options?: unknown
}

export type CreateProvider = (ctx: CreateProviderContext) => SettlementProvider | Promise<SettlementProvider>

export interface BillingHandleOfProvider extends FamilyHandle {
  readonly provider: SettlementProvider
}

export function toBillingHandle(provider: SettlementProvider): BillingHandleOfProvider {
  return {
    slug: provider.id,
    name: provider.name,
    version: "0.0.0",
    description: provider.name,
    requiresSetup: true,
    provider,
    setupFields: [
      { name: provider.env.secretKey, description: `${provider.name} secret key`, sensitive: true },
      { name: provider.env.webhookSecret, description: `${provider.name} webhook signing secret`, sensitive: true },
    ],
    async check() {
      if (typeof provider.check !== "function") return true
      try {
        return (await provider.check()).ok === true
      } catch {
        return false
      }
    },
  }
}

const isProvider = (v: unknown): v is SettlementProvider =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as SettlementProvider).id === "string" &&
  typeof (v as SettlementProvider).verifyWebhook === "function" &&
  typeof (v as SettlementProvider).charge === "function"

export interface BillingRegistryOptions {
  /** Providers registered in process, keyed by `id`. Tried before any import. */
  providers?: readonly SettlementProvider[]
  /** Environment to read credentials from. Default: `process.env`. */
  env?: Record<string, string | undefined>
  /** Import seam, for tests. Default: native dynamic `import()`. */
  importPackage?: (packageName: string) => Promise<Record<string, unknown>>
  /** Options passed to a package's `createProvider`, by slug. */
  providerOptions?: Record<string, unknown>
}

export interface BillingRegistry {
  readonly family: ProviderFamily<BillingHandleOfProvider, BillingProviderInfo>
  /** A provider by rail id (slug), or null. */
  provider(slug: string): Promise<SettlementProvider | null>
  /** Every provider that resolves. */
  all(): Promise<SettlementProvider[]>
}

export function makeBillingRegistry(opts: BillingRegistryOptions = {}): BillingRegistry {
  const env = opts.env ?? process.env
  const local = new Map((opts.providers ?? []).map(p => [p.id, p]))
  const slugs = [...new Set([...BILLING_CATALOG.map(e => e.slug), ...local.keys()])]
  const vars: Record<string, Record<string, string>> = {}
  for (const slug of slugs) {
    const names = local.get(slug)?.env ?? defaultRailEnv(slug)
    vars[slug] = { [names.secretKey]: names.secretKey, [names.webhookSecret]: names.webhookSecret }
  }
  const credsStore = makeEnvCredsStore({ env, vars })
  const entries = new Map(BILLING_CATALOG.map(e => [e.slug, e]))
  // `path` is the chain of slugs being built through `createProvider`: a slug met twice is a cycle.
  const loadProvider = async (
    slug: string,
    path: readonly string[],
    importPackage: (packageName: string) => Promise<Record<string, unknown>>,
  ): Promise<SettlementProvider | null> => {
    if (path.includes(slug)) throw new Error(`billing provider cycle: ${[...path, slug].join(" -> ")}`)
    const inProcess = local.get(slug)
    if (inProcess) return inProcess
    // A slug outside the catalog has no package name to import: it does not resolve.
    const entry = entries.get(slug)
    if (!entry) return null
    const mod = await importPackage(entry.packageName)
    if (typeof mod.createProvider === "function") {
      const created = await (mod.createProvider as CreateProvider)({
        env,
        providers: other => loadProvider(other, [...path, slug], importPackage),
        ...(opts.providerOptions?.[slug] !== undefined ? { options: opts.providerOptions[slug] } : {}),
      })
      return isProvider(created) ? created : null
    }
    const candidate = mod.default ?? mod.provider ?? Object.values(mod).find(isProvider)
    return isProvider(candidate) ? candidate : null
  }
  const family = makeProviderFamily<BillingHandleOfProvider, BillingProviderInfo>({
    family: "billing",
    catalog: [
      ...BILLING_CATALOG,
      ...[...local.values()]
        .filter(p => !BILLING_CATALOG.some(e => e.slug === p.id))
        .map(p => ({ slug: p.id, name: p.name, description: p.name, packageName: `@agentproto/billing-${p.id}` })),
    ],
    credsStore,
    ledger: makeMemorySetupLedger(),
    toInfo: h => ({
      slug: h.slug,
      secretKeyVariable: h.provider.env.secretKey,
      webhookSecretVariable: h.provider.env.webhookSecret,
      modeVariable: h.provider.env.mode,
      canRefund: typeof h.provider.refund === "function",
      canSyncCatalog: typeof h.provider.syncCatalog === "function",
      capabilities: h.provider.capabilities,
    }),
    load: async (slug, ctx) => {
      const p = await loadProvider(slug, [], ctx.importPackage)
      return p ? toBillingHandle(p) : null
    },
    ...(opts.importPackage ? { importPackage: opts.importPackage } : {}),
  })
  const provider = async (slug: string) => (await family.resolve(slug))?.provider ?? null
  const all = async () => {
    const out: SettlementProvider[] = []
    for (const e of family.catalog) {
      const p = await provider(e.slug)
      if (p) out.push(p)
    }
    return out
  }
  return { family, provider, all }
}

export type { FamilyCreds }
