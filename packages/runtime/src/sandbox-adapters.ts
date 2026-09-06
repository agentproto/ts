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
 * Kit primitives used:
 *   - `makeCredsStore`      → per-slug 0600 creds under `~/.agentproto/sandbox-creds/`
 *   - `makeSetupLedger`     → `~/.agentproto/setup/<slug>.json`
 *   - `makeAdapterResolver` → wraps the throwing `load` into null-on-miss
 *   - `makeAdapterLister`   → catalog → status-classified `AdapterEntry[]`
 *   - `makeListTool`        → registers `list_sandbox_providers`
 *   - `makeSetupTool`       → registers `setup_sandbox_provider` (multi-field
 *                             form: e2b's `apiKey`, sensitive)
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
  makeAdapterResolver,
  makeAdapterLister,
  makeListTool,
  makeSetupTool,
  type AdapterCatalog,
  type AdapterLister,
  type AdapterResolver,
  type CredsStore,
  type SetupField,
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
      "Runs the agentproto daemon inside an e2b Firecracker microVM (agentproto-workstation template, baked @agentproto/cli 0.17.0).",
      /* sync-templates:end */
    packageName: "@agentproto/sandbox-e2b",
    hint: "e2b · cloud",
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

/** Extract the safe descriptor from a resolved handle. No secrets. */
export function toSandboxInfo(handle: SandboxProviderHandle): SandboxAdapterInfo {
  return { capabilities: handle.capabilities }
}

/** Build the sandbox-family creds store (per-slug, 0600). */
export function makeSandboxCredsStore(home?: string): CredsStore<SandboxCreds> {
  return makeCredsStore<SandboxCreds>({
    family: SANDBOX_FAMILY,
    ...(home ? { home } : {}),
  })
}

/**
 * Resolve a catalog slug to a concrete handle via the provider registry —
 * `local` in-process, `e2b`/`modal`/`daytona` dynamic-imported. Reads
 * stored creds first so `e2b` (and any future catalog entry) resolves
 * configured when possible; unconfigured slugs resolve to a descriptor-only
 * handle (listing never calls `start()`/`check()`). Throws on an unknown
 * slug so the kit's resolver wraps it to `null` ("supported but not
 * installed").
 */
export function makeSandboxResolver(
  credsStore: CredsStore<SandboxCreds>,
  opts?: {
    /** Injectable for tests — defaults to a real dynamic `import()`. */
    importPackage?: (packageName: string) => Promise<Record<string, unknown>>
  },
): SandboxProviderResolver {
  return makeAdapterResolver<SandboxProviderHandle>({
    load: async (slug: string): Promise<SandboxProviderHandle> => {
      const creds = await credsStore.read(slug)
      const handle = await resolveSandboxProvider(slug, {
        creds,
        ...(opts?.importPackage ? { importPackage: opts.importPackage } : {}),
      })
      if (!handle) throw new Error(`unknown sandbox adapter slug: ${slug}`)
      return handle
    },
  })
}

/** Build the family lister: catalog → status-classified entries. */
export function makeSandboxLister(opts: {
  credsStore: CredsStore<SandboxCreds>
  ledger: SetupLedger
  resolver?: SandboxProviderResolver
}): SandboxProviderLister {
  return makeAdapterLister<SandboxProviderHandle, SandboxAdapterInfo>({
    catalog: SANDBOX_CATALOG,
    resolver: opts.resolver ?? makeSandboxResolver(opts.credsStore),
    ledger: opts.ledger,
    credsStore: opts.credsStore,
    toInfo: toSandboxInfo,
  })
}

/**
 * Resolve every catalog slug and union the `setupFields` of whichever
 * resolve with a non-empty declaration, for the `setup_sandbox_provider`
 * tool. Because one tool spans providers with disjoint fields, the unioned
 * shape is relaxed to all-optional at the zod layer (`required: false`);
 * the genuine per-provider required-ness is enforced in `onSetup` against
 * the chosen provider's handle.
 */
async function collectSetupSchema(
  resolver: SandboxProviderResolver,
): Promise<{ validSlugs: string[]; fields: SetupField[] }> {
  const handles: SandboxProviderHandle[] = []
  for (const entry of SANDBOX_CATALOG) {
    const handle = await resolver(entry.slug)
    if (handle) handles.push(handle)
  }
  const setupHandles = handles.filter(
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

export interface RegisterSandboxAdapterToolsOptions {
  /** Home dir override (tests). Defaults to `AGENTPROTO_HOME ?? ~/.agentproto`. */
  home?: string
  /** Override the family's default resolver — mirrors `resolveAgentAdapter`
   *  injection. Defaults to `makeSandboxResolver(credsStore)`. */
  resolveSandboxProvider?: SandboxProviderResolver
  /** Override the family's default lister — mirrors `listAgentAdapters`
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
  const resolver = opts.resolveSandboxProvider ?? makeSandboxResolver(credsStore)
  const lister =
    opts.listSandboxProviders ?? makeSandboxLister({ credsStore, ledger, resolver })

  makeListTool<SandboxAdapterInfo>({
    server,
    toolName: "list_sandbox_providers",
    description:
      "List known sandbox providers with their status (supported/available/" +
      "ready), version, and declared capabilities (networkEgress, mounts, " +
      "lifecyclePause, readOnly). Credentials are never returned. Use " +
      "`setup_sandbox_provider` to configure a provider that needs creds.",
    lister,
  })

  const { validSlugs, fields } = await collectSetupSchema(resolver)

  makeSetupTool({
    server,
    toolName: "setup_sandbox_provider",
    description:
      "Configure a sandbox provider that requires credentials (e.g. e2b). " +
      "Each field is SENSITIVE — stored 0600 and never echoed back in tool " +
      "results. Only the fields a given provider declares are stored.",
    validSlugs,
    fields,
    onSetup: async (slug: string, fieldValues: Record<string, string>) => {
      // Resolve the chosen provider so its OWN setupFields drive
      // validation — works for built-ins and third-party providers alike.
      const handle = await resolver(slug)
      const declared = handle?.setupFields
      if (!handle || !declared || declared.length === 0) {
        return { ok: false, hint: `provider '${slug}' is not configurable` }
      }

      const missing = declared
        .filter((f) => f.required === true)
        .map((f) => f.name)
        .filter((name) => {
          const v = fieldValues[name]
          return v === undefined || v.length === 0
        })
      if (missing.length > 0) {
        return {
          ok: false,
          hint: `missing required field(s): ${missing.join(", ")}`,
        }
      }

      // Persist only the provider's declared, non-empty fields.
      const creds: SandboxCreds = {}
      for (const f of declared) {
        const v = fieldValues[f.name]
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
