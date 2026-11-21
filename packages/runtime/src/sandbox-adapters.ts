/**
 * Sandbox family on top of `@agentproto/provider-kit` — mirrors
 * `tunnel-adapters.ts`. This module is the entire bridge between the
 * generic kit and `@agentproto/sandbox`'s `SandboxProvider` concept: it
 * contributes nothing the kit already owns (catalog/status/creds/ledger/
 * list/MCP-tool plumbing); it only supplies the sandbox-family `TInfo`
 * (`SandboxAdapterInfo`), the static `SANDBOX_CATALOG`, and the resolver
 * that maps a catalog slug to a concrete {@link SandboxProviderHandle}
 * (`./sandbox-providers/registry.js`).
 *
 * Built on `makeProviderFamily` (`@agentproto/provider-kit`), which owns the
 * creds store, the setup ledger, the catalog listing, the resolver, the
 * setup schema and the `list_sandbox_providers` / `setup_sandbox_provider`
 * tools. `legacySetup` keeps the setup semantics this module had before it
 * moved onto the factory (optional-unless-`required:true`, replace-not-merge,
 * store errors propagate).
 *
 * This is pure additive plumbing (introspection + setup) — it does NOT wire
 * a `sandbox` field into `agent_start`. That lands in a follow-up PR; the
 * `resolveSandboxProvider`/`listSandboxProviders` overrides below exist now
 * so that later wiring can inject the same resolver/lister this module
 * builds by default, mirroring `resolveAgentAdapter`/`listAgentAdapters`.
 *
 * Security: `toSandboxInfo` exposes only `capabilities` — never a cred
 * value (Appendix B). The setup tool's fields are marked SENSITIVE and the
 * result NEVER echoes any field value back.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  makeCredsStore,
  makeSetupLedger,
  makeListTool,
  makeMemorySetupLedger,
  makeProviderFamily,
  type AdapterCatalog,
  type AdapterLister,
  type AdapterResolver,
  type CredsStore,
  type ProviderFamily,
  type SetupLedger,
} from "@agentproto/provider-kit"

import {
  resolveSandboxProvider,
  type SandboxCreds,
} from "./sandbox-providers/registry.js"
import type {
  SandboxProviderCapabilities,
  SandboxProviderHandle,
} from "./sandbox-providers/types.js"

export type { SandboxProviderHandle, SandboxProviderCapabilities }

/** Creds-store / ledger family key → `~/.agentproto/sandbox-creds/`. */
export const SANDBOX_FAMILY = "sandbox"

/**
 * Family descriptor (`TInfo`). Pure metadata surfaced in
 * `list_sandbox_providers`. The kit's `AdapterEntry` already carries
 * slug/name/description/status/version, so the only sandbox-specific field
 * is the declared capability set. NEVER carries a cred value.
 */
export interface SandboxAdapterInfo {
  capabilities: SandboxProviderCapabilities
}

/** Resolve a sandbox provider slug to a handle, or null when unavailable. */
export type SandboxProviderResolver = AdapterResolver<SandboxProviderHandle>

/** List every sandbox provider with its live status + capabilities. */
export type SandboxProviderLister = AdapterLister<SandboxAdapterInfo>

/** Static catalog: the built-in `local` provider plus the AIP-36 day-1 cloud ids. */
export const SANDBOX_CATALOG: AdapterCatalog = [
  {
    slug: "local",
    name: "Local",
    description:
      "Boots a real agentproto daemon on 127.0.0.1 in a temp workspace — no cloud credentials needed.",
    packageName: "@agentproto/runtime",
    hint: "local · zero-credential",
  },
  {
    slug: "e2b",
    name: "e2b",
    description:
      /* sync-templates:start */
      "Runs the agentproto daemon inside an e2b Firecracker microVM (agentproto-workstation template, baked @agentproto/cli 1.31.0).",
      /* sync-templates:end */
    packageName: "@agentproto/sandbox-e2b",
    hint: "e2b · cloud",
  },
  {
    slug: "computer",
    name: "Computer",
    description:
      "Runs the agentproto daemon on a self-hosted microVM computer via its controller API (pause/suspend, resume, shared sessions).",
    packageName: "@agentproto/sandbox-computer",
    hint: "computer · self-hosted",
  },
  {
    slug: "box",
    name: "Box",
    description:
      "Runs the agentproto daemon on an ascii.dev Box cloud computer, behind an always-on systemd unit.",
    packageName: "@agentproto/sandbox-box",
    hint: "box · cloud",
  },
  {
    slug: "instabox",
    name: "InstaBox",
    description:
      "Runs the agentproto daemon inside an InstaBox VM, behind an always-on systemd unit on the account's public edge.",
    packageName: "@agentproto/sandbox-instabox",
    hint: "instabox · cloud",
  },
  {
    slug: "modal",
    name: "Modal",
    description: "Modal sandbox backend. Catalog placeholder — no package published yet.",
    packageName: "@agentproto/sandbox-modal",
    hint: "modal · cloud (not yet published)",
  },
  {
    slug: "daytona",
    name: "Daytona",
    description: "Daytona sandbox backend. Catalog placeholder — no package published yet.",
    packageName: "@agentproto/sandbox-daytona",
    hint: "daytona · cloud (not yet published)",
  },
]

/** Slugs of the concrete box-owning providers, in catalog order. `local` is a
 *  same-filesystem passthrough with no control plane to enumerate, and `auto`
 *  is a selector rather than an owner, so neither is ever swept or listed by
 *  default. Placeholders still resolve to null and are reported as not
 *  scanned by the caller. */
export const DEFAULT_SANDBOX_PROVIDER_SLUGS: readonly string[] = SANDBOX_CATALOG.map(
  entry => entry.slug,
).filter(slug => slug !== "local" && slug !== "auto")

/** Providers a bare `sandbox_gc` sweeps. Only the `computer` controller
 *  scopes its boxes to this daemon's tenant, so only it can be swept by
 *  default: a shared account (e2b) holds boxes from other daemons, machines,
 *  CI and tools, and every one of those would look like an orphan here.
 *  `sandbox_list` still defaults to every concrete provider because reading
 *  is safe; sweeping is not. */
export const DEFAULT_SANDBOX_GC_PROVIDER_SLUGS: readonly string[] = ["computer"]

/** Extract the safe descriptor from a resolved handle. No secrets. */
export function toSandboxInfo(handle: SandboxProviderHandle): SandboxAdapterInfo {
  return { capabilities: handle.capabilities }
}

/**
 * Adapter slug → EXTRA npm packages the adapter needs installed inside a
 * sandbox box, on top of `@agentproto/adapter-<slug>` itself. Mirrors the
 * CI-side `sandboxRefFor` (`.github/agentproto-workflows/lib/sandbox-agent.mjs`)
 * so the runtime injects the same set the CI harness does.
 */
export const SANDBOX_ADAPTER_BOOT_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["@anthropic-ai/claude-code"],
}

/** Package-name part of an npm spec: `@org/pkg@1.2.3` → `@org/pkg`, `pkg` → `pkg`. */
export function npmPackageName(npmSpec: string): string {
  const at = npmSpec.lastIndexOf("@")
  return at > 0 ? npmSpec.slice(0, at) : npmSpec
}

/**
 * Packages to PREPEND to a sandbox spec's `config.installPackages` so the
 * adapter about to be spawned survives the box's boot-time CLI update (the
 * `npm i -g @agentproto/cli` that replaces the global install and loses the
 * template-baked adapters — see `@agentproto/sandbox-e2b`'s provider doc for
 * `installPackages`). `adapter` is injected as `@agentproto/adapter-<slug>@latest`
 * plus this module's `SANDBOX_ADAPTER_BOOT_PACKAGES` extras. Purely additive:
 * a caller who already declared an entry for a wanted package (any version —
 * a pin wins) suppresses the `@latest` injection for it, and the result is
 * deduped.
 */
export function sandboxAdapterBootPackages(
  adapter: string,
  declared: readonly string[],
): string[] {
  const declaredNames = new Set(declared.map(npmPackageName))
  const wanted = [`@agentproto/adapter-${adapter}`]
  for (const extra of SANDBOX_ADAPTER_BOOT_PACKAGES[adapter] ?? []) wanted.push(extra)
  return wanted
    .filter(name => !declaredNames.has(name))
    .map(name => `${name}@latest`)
}

/**
 * Expand semantic `config.installHarnesses` slugs into concrete npm specs.
 * Each slug becomes `@agentproto/adapter-<slug>@latest` plus the
 * `SANDBOX_ADAPTER_BOOT_PACKAGES` extras that slug declares. A slug unknown
 * to the catalog still expands (the box's boot-time npm install is the
 * authority on resolvability) — deliberately no failure mode, per the
 * field's "semantic convenience, not a contract" shape. Deduped against
 * `declared` by npm package name, so a caller's `config.installPackages`
 * pin (any version, or a previously-injected `@latest`) always wins and
 * nothing is installed twice.
 */
export function sandboxInstallAdapterPackages(
  slugs: readonly string[],
  declared: readonly string[],
): string[] {
  const taken = new Set(declared.map(npmPackageName))
  const out: string[] = []
  for (const slug of slugs) {
    for (const name of [
      `@agentproto/adapter-${slug}`,
      ...(SANDBOX_ADAPTER_BOOT_PACKAGES[slug] ?? []),
    ]) {
      if (taken.has(name)) continue
      taken.add(name)
      out.push(`${name}@latest`)
    }
  }
  return out
}

/** Build the sandbox-family creds store (per-slug, 0600). */
export function makeSandboxCredsStore(home?: string): CredsStore<SandboxCreds> {
  return makeCredsStore<SandboxCreds>({
    family: SANDBOX_FAMILY,
    ...(home ? { home } : {}),
  })
}

/** Build the sandbox family on the kit's factory. `legacySetup` keeps the
 *  setup semantics this module had before it moved onto the factory. */
function makeSandboxFamily(opts: {
  credsStore: CredsStore<SandboxCreds>
  ledger: SetupLedger
  /** Replaces the registry resolution (tests, injected resolvers). */
  resolver?: SandboxProviderResolver
  importPackage?: (packageName: string) => Promise<Record<string, unknown>>
}): ProviderFamily<SandboxProviderHandle, SandboxAdapterInfo> {
  return makeProviderFamily<SandboxProviderHandle, SandboxAdapterInfo>({
    family: SANDBOX_FAMILY,
    catalog: SANDBOX_CATALOG,
    toInfo: toSandboxInfo,
    credsStore: opts.credsStore,
    ledger: opts.ledger,
    legacySetup: true,
    setupHint: slug => `${slug} configured \u2014 status is now ready`,
    // Called for any slug, catalog or not: `auto` is a composite slug that is
    // deliberately not in the catalog.
    load: async (slug, ctx) => {
      if (opts.resolver) return opts.resolver(slug)
      return resolveSandboxProvider(slug, {
        creds: ctx.creds,
        // A composite slug (`auto`) resolves its nested providers with THEIR
        // own creds rows, not the composite's (which has none).
        credsFor: nested => ctx.credsFor(nested),
        ...(opts.importPackage ? { importPackage: opts.importPackage } : {}),
      })
    },
  })
}

/**
 * Resolve a catalog slug to a concrete handle via the provider registry,
 * `local` in-process, `e2b`/`modal`/`daytona` dynamic-imported. Reads
 * stored creds first so `e2b` (and any future catalog entry) resolves
 * configured when possible; unconfigured slugs resolve to a descriptor-only
 * handle (listing never calls `start()`/`check()`). An unknown slug
 * resolves to `null` ("supported but not installed").
 */
export function makeSandboxResolver(
  credsStore: CredsStore<SandboxCreds>,
  opts?: {
    /** Injectable for tests: a one-shot importer that bypasses the shared
     *  probe cache. Left unset (production), third-party imports run through
     *  `provider-probes.ts`: bounded, coalesced, and synchronously
     *  preflighted so an unpublished placeholder (`modal`/`daytona`) never
     *  enters Node's async loader. */
    importPackage?: (packageName: string) => Promise<Record<string, unknown>>
  },
): SandboxProviderResolver {
  return makeSandboxFamily({
    credsStore,
    ledger: makeMemorySetupLedger(), // resolver only: the ledger is never read
    ...(opts?.importPackage ? { importPackage: opts.importPackage } : {}),
  }).resolve
}

/** Build the family lister: catalog to status-classified entries. */
export function makeSandboxLister(opts: {
  credsStore: CredsStore<SandboxCreds>
  ledger: SetupLedger
  resolver?: SandboxProviderResolver
}): SandboxProviderLister {
  return makeSandboxFamily({
    credsStore: opts.credsStore,
    ledger: opts.ledger,
    ...(opts.resolver ? { resolver: opts.resolver } : {}),
  }).list
}

export interface RegisterSandboxAdapterToolsOptions {
  /** Home dir override (tests). Defaults to `AGENTPROTO_HOME ?? ~/.agentproto`. */
  home?: string
  /** Override the family's default resolver, mirrors `resolveAgentAdapter`
   *  injection. Defaults to `makeSandboxResolver(credsStore)`. */
  resolveSandboxProvider?: SandboxProviderResolver
  /** Override the family's default lister, mirrors `listAgentAdapters`
   *  injection. Defaults to a catalog-driven lister built off the resolver. */
  listSandboxProviders?: SandboxProviderLister
}

/**
 * Register the sandbox family's adapter-kit MCP tools on the server:
 *   - `list_sandbox_providers`  (parameterless; status + capabilities, no creds)
 *   - `setup_sandbox_provider`  (multi-field; fields are union of every
 *     configurable provider's declared `setupFields`, all SENSITIVE and
 *     never echoed). Async because the field schema is derived from
 *     resolved handles.
 */
export async function registerSandboxAdapterTools(
  server: McpServer,
  opts: RegisterSandboxAdapterToolsOptions = {},
): Promise<void> {
  const credsStore = makeSandboxCredsStore(opts.home)
  const ledger = makeSetupLedger(opts.home ? { home: opts.home } : {})
  const family = makeSandboxFamily({
    credsStore,
    ledger,
    ...(opts.resolveSandboxProvider ? { resolver: opts.resolveSandboxProvider } : {}),
  })

  const listSpec = {
    name: "list_sandbox_providers",
    description:
      "List known sandbox providers with their status (supported/available/" +
      "ready), version, and declared capabilities (networkEgress, mounts, " +
      "lifecyclePause, readOnly). Credentials are never returned. Use " +
      "`setup_sandbox_provider` to configure a provider that needs creds.",
  }
  // An injected lister replaces the family's own, so register it directly.
  if (opts.listSandboxProviders) {
    makeListTool<SandboxAdapterInfo>({
      server,
      toolName: listSpec.name,
      description: listSpec.description,
      lister: opts.listSandboxProviders,
    })
  }

  await family.registerTools(server, {
    ...(opts.listSandboxProviders ? {} : { list: listSpec }),
    setup: {
      name: "setup_sandbox_provider",
      description:
        "Configure a sandbox provider that requires credentials (e.g. e2b). " +
        "Each field is SENSITIVE \u2014 stored 0600 and never echoed back in tool " +
        "results. Only the fields a given provider declares are stored.",
    },
  })
}
