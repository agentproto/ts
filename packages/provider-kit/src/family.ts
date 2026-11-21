/**
 * `makeProviderFamily`: the glue every provider family used to copy.
 *
 * The sandbox and tunnel families each carried ~400 lines in
 * `runtime/src/{sandbox,tunnel}-adapters.ts` that did the same five things:
 * hold a static catalog, classify entries `supported | available | ready`,
 * resolve a catalog slug to a provider (built-in, or a dynamic import of the
 * provider's package), union the setup fields of every configurable
 * provider, and register a `list_*` and a `setup_*` MCP tool. This module is
 * that glue, parameterised by the parts that really differ per family: the
 * catalog, the `TInfo` descriptor, and how a slug becomes a handle.
 *
 * A family stays a thin file: it declares its catalog, its handle shape and
 * its tool names, and keeps any extra tool (the tunnel `login`) beside it.
 *
 * No daemon and no home directory are required: pass `credsStore` and
 * `ledger` (for example {@link makeEnvCredsStore} and
 * {@link makeMemorySetupLedger}) and nothing reads `~/.agentproto`. The file
 * stores are only built, lazily, when the caller supplies none.
 *
 * Security: same contract as the rest of the kit. `toInfo` must never carry
 * a creds value; the setup result and hint never echo a field value.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { makeCredsStore, type CredsStore } from "./creds-store.js"
import { makeSetupLedger, type SetupLedger } from "./ledger.js"
import { makeAdapterLister, makeAdapterResolver } from "./list-resolve.js"
import { makeListTool, makeSetupTool, type SetupField } from "./mcp-tools.js"
import type {
  AdapterCatalog,
  AdapterCatalogEntry,
  AdapterHandle,
  AdapterLister,
  AdapterResolver,
} from "./types.js"

/** Creds are a flat map of field name to string, as the setup tool stores them. */
export type FamilyCreds = Record<string, string>

/**
 * A handle that can also declare setup fields. Everything optional here is
 * what `setup_*` reads; a handle with no `setupFields` is "not configurable".
 */
export interface FamilyHandle extends AdapterHandle {
  /** Fields the `setup_*` tool collects for this provider. */
  readonly setupFields?: readonly SetupField[]
  /** Throws (message becomes the hint) when the submitted fields are invalid. */
  validateSetup?(fields: Record<string, string>): void
}

/** What a family's `load` receives for one slug. */
export interface FamilyLoadContext {
  /** The catalog entry for the slug. Absent only for a slug outside the
   *  catalog that a `load` override chose to resolve (a composite slug). */
  entry?: AdapterCatalogEntry
  /** Stored creds for the slug, or null. Read per call, never cached. */
  creds: FamilyCreds | null
  /** Read another provider's creds (a composite provider that nests others). */
  credsFor: (slug: string) => Promise<FamilyCreds | null>
  /** Import a provider package. Default: native dynamic `import()`. */
  importPackage: (packageName: string) => Promise<Record<string, unknown>>
}

export interface MakeProviderFamilyOpts<THandle extends FamilyHandle, TInfo> {
  /** Family key, e.g. "sandbox", "billing". Names the file store directory. */
  family: string
  /** Static catalog. A slug outside it never resolves. */
  catalog: AdapterCatalog
  /** Safe descriptor from a resolved handle. MUST NOT include creds values. */
  toInfo: (handle: THandle) => TInfo
  /**
   * Providers that resolve in-process, with no import, keyed by slug.
   * Tried before `load` / the package import.
   */
  builtins?: Readonly<Record<string, (creds: FamilyCreds | null) => THandle>>
  /**
   * Turn an imported provider package into a handle, or null when the module
   * does not carry one. Used for catalog slugs that are not built in: the
   * family imports `entry.packageName` and hands the module here. A package
   * that cannot be imported resolves to null ("supported", not installed).
   */
  fromModule?: (
    module: Record<string, unknown>,
    ctx: FamilyLoadContext,
  ) => THandle | null
  /**
   * Full override of how a slug becomes a handle, for families whose
   * resolution is not "built-in or one package import" (a composite slug,
   * a bounded probe cache). Throw or return null for "not available".
   * When set, `builtins` and `fromModule` are ignored, and `load` is called
   * for any slug, including one outside the catalog (`ctx.entry` is then
   * undefined); it must return null or throw for slugs it does not know.
   */
  load?: (slug: string, ctx: FamilyLoadContext) => Promise<THandle | null>
  /** Import seam. Default: native dynamic `import()`. Inject in tests. */
  importPackage?: (packageName: string) => Promise<Record<string, unknown>>
  /** Creds store. Default: file-backed under `<home>/<family>-creds/` (0600). */
  credsStore?: CredsStore<FamilyCreds>
  /** Setup ledger. Default: file-backed under `<home>/setup/`. */
  ledger?: SetupLedger
  /** Home override for the file-backed defaults only. */
  home?: string
  /** Resolve whether an `authRequired` handle has a credential (see lister). */
  authProbe?: (handle: THandle) => Promise<boolean>
  /** Providers found outside the catalog (a node_modules walk). */
  discoverExtras?: () => Promise<THandle[]>
  /** Call `handle.check()` while listing. Default false. */
  checkDuringListing?: boolean
  /**
   * Reproduce the setup semantics sandbox and tunnels had before this
   * factory, for a family migrating onto it with no behavior change. Three
   * differences from the default (documented contract) behavior:
   *   - a field that omits `required` is OPTIONAL (default: required, as
   *     `SetupField` documents and `makeSetupTool` enforces);
   *   - the stored creds record is REPLACED by the submitted fields
   *     (default: merged over what is already stored);
   *   - an error thrown by the creds store or the ledger propagates
   *     (default: returned as `{ ok: false, hint }`).
   * Default false. New families should leave it off.
   */
  legacySetup?: boolean
  /**
   * Message returned by a successful setup. Never include a field value.
   * Default: `<slug> configured, status is now ready`.
   */
  setupHint?: (slug: string) => string
}

export interface FamilyToolSpec {
  /** MCP tool name, e.g. "list_sandbox_providers". */
  name: string
  description: string
}

export interface RegisterFamilyToolsOpts {
  /** Omit when the host registers its own list tool (an injected lister). */
  list?: FamilyToolSpec
  /** Omit for a family with no setup tool. */
  setup?: FamilyToolSpec
}

export interface ProviderFamily<THandle extends FamilyHandle, TInfo> {
  readonly family: string
  readonly catalog: AdapterCatalog
  readonly credsStore: CredsStore<FamilyCreds>
  readonly ledger: SetupLedger
  /** Slug to handle, or null when unknown, not importable, or it threw. */
  resolve: AdapterResolver<THandle>
  /** Catalog to status-classified entries (supported / available / ready). */
  list: AdapterLister<TInfo>
  /**
   * Union of the setup fields of every resolvable configurable provider,
   * relaxed to optional (one tool spans providers with disjoint fields).
   * Per-provider required-ness is enforced by {@link ProviderFamily.setup}.
   *
   * Cost: this resolves every catalog slug, importing each provider package.
   * {@link ProviderFamily.registerTools} calls it once at registration, so a
   * host that only exposes `list_*` still pays that import for the setup tool.
   */
  setupSchema: () => Promise<{ validSlugs: string[]; fields: SetupField[] }>
  /**
   * Validate and store one provider's declared, non-empty fields, then write
   * the ledger. The result never echoes a field value.
   */
  setup: (
    slug: string,
    fields: Record<string, string>,
  ) => Promise<{ ok: boolean; hint?: string }>
  /** Register the `list_*` tool and, when asked, the `setup_*` tool. */
  registerTools: (server: McpServer, tools: RegisterFamilyToolsOpts) => Promise<void>
}

const nativeImport = (packageName: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ packageName) as Promise<Record<string, unknown>>

export function makeProviderFamily<THandle extends FamilyHandle, TInfo>(
  opts: MakeProviderFamilyOpts<THandle, TInfo>,
): ProviderFamily<THandle, TInfo> {
  const { family, catalog } = opts
  const credsStore =
    opts.credsStore ??
    makeCredsStore<FamilyCreds>({
      family,
      ...(opts.home ? { home: opts.home } : {}),
    })
  const ledger =
    opts.ledger ?? makeSetupLedger(opts.home ? { home: opts.home } : {})
  const importPackage = opts.importPackage ?? nativeImport
  const bySlug = new Map(catalog.map(e => [e.slug, e]))

  const loadOne = async (slug: string): Promise<THandle> => {
    const entry = bySlug.get(slug)
    if (!entry && !opts.load) {
      throw new Error(`unknown ${family} provider slug: ${slug}`)
    }
    const ctx: FamilyLoadContext = {
      ...(entry ? { entry } : {}),
      creds: await credsStore.read(slug),
      credsFor: nested => credsStore.read(nested),
      importPackage,
    }
    if (opts.load) {
      const handle = await opts.load(slug, ctx)
      if (!handle) throw new Error(`${family} provider '${slug}' is not available`)
      return handle
    }
    const builtin = opts.builtins?.[slug]
    if (builtin) return builtin(ctx.creds)
    if (!opts.fromModule || !entry) {
      throw new Error(`${family} provider '${slug}' has no loader`)
    }
    const handle = opts.fromModule(await importPackage(entry.packageName), ctx)
    if (!handle) {
      throw new Error(`${entry.packageName} does not export a ${family} provider`)
    }
    return handle
  }

  const resolve = makeAdapterResolver<THandle>({ load: loadOne })

  const list = makeAdapterLister<THandle, TInfo>({
    catalog,
    resolver: resolve,
    ledger,
    credsStore,
    toInfo: opts.toInfo,
    ...(opts.authProbe ? { authProbe: opts.authProbe } : {}),
    ...(opts.discoverExtras ? { discoverExtras: opts.discoverExtras } : {}),
    ...(opts.checkDuringListing ? { checkDuringListing: true } : {}),
  })

  const setupSchema = async (): Promise<{
    validSlugs: string[]
    fields: SetupField[]
  }> => {
    const handles: THandle[] = []
    for (const entry of catalog) {
      const h = await resolve(entry.slug)
      if (h) handles.push(h)
    }
    if (opts.discoverExtras) {
      const known = new Set(handles.map(h => h.slug))
      for (const h of await opts.discoverExtras()) {
        if (!known.has(h.slug)) handles.push(h)
      }
    }
    const configurable = handles.filter(
      h => h.setupFields && h.setupFields.length > 0,
    )
    const fieldByName = new Map<string, SetupField>()
    for (const h of configurable) {
      for (const f of h.setupFields ?? []) {
        // First declaration wins; relaxed to optional for the cross-provider tool.
        if (!fieldByName.has(f.name)) {
          fieldByName.set(f.name, { ...f, required: false })
        }
      }
    }
    return {
      validSlugs: configurable.map(h => h.slug),
      fields: [...fieldByName.values()],
    }
  }

  const setup = async (
    slug: string,
    fields: Record<string, string>,
  ): Promise<{ ok: boolean; hint?: string }> => {
    const handle = await resolve(slug)
    const declared = handle?.setupFields
    if (!handle || !declared || declared.length === 0) {
      return { ok: false, hint: `provider '${slug}' is not configurable` }
    }
    const missing = declared
      .filter(f => (opts.legacySetup ? f.required === true : f.required !== false))
      .map(f => f.name)
      .filter(name => {
        const v = fields[name]
        return v === undefined || v.length === 0
      })
    if (missing.length > 0) {
      return { ok: false, hint: `missing required field(s): ${missing.join(", ")}` }
    }
    if (handle.validateSetup) {
      try {
        handle.validateSetup(fields)
      } catch (err) {
        return { ok: false, hint: err instanceof Error ? err.message : String(err) }
      }
    }
    const now = new Date().toISOString()
    const persist = async (): Promise<void> => {
      // Default: the write REPLACES the stored record, so start from what is
      // already there and merge over it (re-setup keeps optional creds).
      // Legacy: persist only the submitted declared, non-empty fields.
      const existing = opts.legacySetup ? null : await credsStore.read(slug)
      const creds: FamilyCreds = { ...(existing ?? {}) }
      for (const f of declared) {
        const v = fields[f.name]
        if (v !== undefined && v.length > 0) creds[f.name] = v
      }
      await credsStore.write(slug, creds)
      await ledger.write(slug, {
        slug,
        completedAt: now,
        steps: [{ id: "creds", completedAt: now }],
      })
    }
    if (opts.legacySetup) {
      await persist()
    } else {
      try {
        await persist()
      } catch (err) {
        return { ok: false, hint: err instanceof Error ? err.message : String(err) }
      }
    }
    return {
      ok: true,
      hint: opts.setupHint?.(slug) ?? `${slug} configured, status is now ready`,
    }
  }

  const registerTools = async (
    server: McpServer,
    tools: RegisterFamilyToolsOpts,
  ): Promise<void> => {
    if (tools.list) {
      makeListTool<TInfo>({
        server,
        toolName: tools.list.name,
        description: tools.list.description,
        lister: list,
      })
    }
    if (!tools.setup) return
    const { validSlugs, fields } = await setupSchema()
    makeSetupTool({
      server,
      toolName: tools.setup.name,
      description: tools.setup.description,
      validSlugs,
      fields,
      onSetup: setup,
    })
  }

  return { family, catalog, credsStore, ledger, resolve, list, setupSchema, setup, registerTools }
}
