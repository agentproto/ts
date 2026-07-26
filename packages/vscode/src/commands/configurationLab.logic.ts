/**
 * Pure logic for the Agentproto Configuration Lab panel. No `vscode` import,
 * so it is directly unit-testable. The webview provider (configurationLabPanel.ts)
 * fetches canonical metadata from the daemon and calls {@link buildConfigurationLabSnapshot}
 * to produce the serializable state the webview renders.
 *
 * Reuses the same resolvers as the spawn wizard and per-session config picker:
 *   - model/menu normalization from spawn.logic.ts
 *   - route/access/posture/effort resolution from sessionConfig.logic.ts
 * This keeps the Lab aligned with the live pickers rather than forking the rules.
 */

import {
  resolveEffectiveRoute,
  serviceableModelRoutes,
} from "@agentproto/runtime/catalog-models"
import type {
  AdapterInfo,
  AuthProfileSummary,
  CatalogModelsResponse,
  ConfigurationLabAxisOptions,
  ConfigurationLabEffectiveField,
  ConfigurationLabIssue,
  ConfigurationLabRawData,
  ConfigurationLabSelectionInput,
  ConfigurationLabSnapshot,
  EffortLevel,
  HarnessCapabilities,
  ProviderPresetEntry,
} from "../client/types.js"
import {
  modelEntriesOf,
  type SpawnAdapterInfo,
} from "./spawn.logic.js"
import {
  resolveAccessRows,
  resolveEfforts,
  resolvePostureRows,
  resolveRouteRows,
  type AuthProfileRow,
  type CapabilityResolutionInput,
  type CatalogModelsResult,
  type CatalogProductRow,
  type CatalogRouteRow,
  type HarnessMode,
  type PostureRow,
  type RouteRow,
} from "./sessionConfig.logic.js"

/** Default effort ceiling used when the harness advertises nothing. */
const DEFAULT_EFFORTS: readonly string[] = ["low", "medium", "high"]

/** AdapterInfo is close enough to SpawnAdapterInfo for modelEntriesOf; the Lab
 *  only reads the model-list fields, never the spawn-wizard-only hints. */
function asSpawnAdapter(adapter: AdapterInfo): SpawnAdapterInfo {
  return adapter as SpawnAdapterInfo
}

/** Find an adapter by slug in the raw daemon listing. */
export function findAdapter(
  adapters: AdapterInfo[],
  slug: string | undefined,
): AdapterInfo | undefined {
  if (!slug) return undefined
  return adapters.find(a => a.slug === slug)
}

/** Find the capabilities snapshot for a selected adapter. */
export function findHarnessCapabilities(
  capabilities: HarnessCapabilities[],
  slug: string | undefined,
): HarnessCapabilities | undefined {
  if (!slug) return undefined
  return capabilities.find(c => c.adapter === slug)
}

/** Build the harness layer shown in section (A) of the panel. */
function buildHarnessLayer(
  adapter: AdapterInfo | undefined,
  capabilities: HarnessCapabilities | undefined,
): ConfigurationLabSnapshot["harness"] {
  if (!adapter) return null
  return {
    slug: adapter.slug,
    name: adapter.name,
    version: adapter.version,
    protocol: adapter.protocol,
    modes: adapter.modes,
    capabilities,
  }
}

/** Convert daemon auth profiles to the row shape sessionConfig.logic.ts expects. */
function toAuthProfileRows(profiles: AuthProfileSummary[]): AuthProfileRow[] {
  return profiles.map(p => ({
    id: p.id,
    endpoint: p.endpoint,
    method: p.method,
    label: p.label,
  }))
}

/** Strip a model id to its bare product (drop a `vendor/` prefix, a `:pin`, an
 *  `@route`) so it can be matched against a catalog `product`. Mirror of the
 *  helper in sessionConfig.logic.ts. */
function productOf(model: string): string {
  const afterVendor = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model
  return afterVendor.split("@")[0]!.split(":")[0]!
}

/** The catalog product entry for `model`, searched across every vendor.
 *  Mirror of the helper in sessionConfig.logic.ts. Handles router-prefixed ids
 *  (`openrouter/vendor/product`) by matching the remaining `vendor/product`
 *  against the catalog's vendor/product tree. */
function findCatalogProduct(
  catalog: CatalogModelsResult | undefined,
  model: string | undefined,
): { vendor: string; product: CatalogProductRow } | undefined {
  if (!catalog || !model) return undefined
  const product = productOf(model)
  for (const vendor of catalog.vendors) {
    const match = vendor.products.find(p => p.product === product || p.product === model)
    if (match) return { vendor: vendor.vendor, product: match }
    // Router-prefixed ids (`openrouter/vendor/product`) yield `product =
    // vendor/product`; try matching that split explicitly.
    const slash = product.indexOf("/")
    if (slash !== -1) {
      const productVendor = product.slice(0, slash)
      const productName = product.slice(slash + 1)
      if (productVendor === vendor.vendor) {
        const splitMatch = vendor.products.find(p => p.product === productName)
        if (splitMatch) return { vendor: vendor.vendor, product: splitMatch }
      }
    }
  }
  return undefined
}

/** Look up the canonical catalog route row for a model + route id. */
function catalogRouteFor(
  catalog: CatalogModelsResult,
  model: string | undefined,
  route: string,
): CatalogRouteRow | undefined {
  return findCatalogProduct(catalog, model)?.product.routes.find(r => r.route === route)
}

/** The canonical billing route for a model id, falling back from a parseable
 *  ref to the first serviceable route for bare/legacy ids. */
function routeForModel(
  model: string | undefined,
  catalog: CatalogModelsResult,
): string | undefined {
  if (!model) return undefined
  const effective = resolveEffectiveRoute(model, undefined)
  if (effective) return effective
  return serviceableModelRoutes(model)[0]
}

/** Build a canonical catalog-style ref for a model. Parseable refs are returned
 *  as-is; bare ids are prefixed with their resolved route. */
function canonicalModelRef(model: string | undefined, route: string | undefined): string | undefined {
  if (!model) return undefined
  if (model.includes("/")) return model
  if (route) return `${route}/${model}`
  return model
}

/** Pick the default route from a non-empty row list: prefer runnable, fall back
 *  to the first row. */
function defaultRouteFrom(rows: RouteRow[]): string {
  return (rows.find(r => r.runnable) ?? rows[0]!).value
}
function prettyProvider(route: string): string {
  if (route === "openai") return "OpenAI"
  if (route === "anthropic") return "Anthropic"
  return route.charAt(0).toUpperCase() + route.slice(1)
}

/** Build the model option list from the adapter's declared models, scoped by
 *  selected route for multi-route (`derived-from-model`) adapters. */
function buildModelOptions(
  adapter: AdapterInfo | undefined,
  catalog: CatalogModelsResult,
  selectedRoute: string | undefined,
): ConfigurationLabAxisOptions["models"] {
  if (!adapter) return []
  const entries = modelEntriesOf(asSpawnAdapter(adapter)).map(entry => ({
    ...entry,
    resolvedRoute: routeForModel(entry.id, catalog),
  }))

  const filtered =
    adapter.routeSelection === "derived-from-model" && selectedRoute
      ? entries.filter(e => e.resolvedRoute === selectedRoute)
      : entries

  const distinctProviders = new Set(
    filtered.map(e => e.provider ?? e.resolvedRoute).filter(Boolean),
  )
  const showProvider = distinctProviders.size > 1

  return filtered.map(entry => ({
    id: entry.id,
    ...(showProvider || entry.provider ? { provider: entry.provider ?? entry.resolvedRoute } : {}),
    ...(entry.mode ? { mode: entry.mode } : {}),
  }))
}

/** Filter catalog route rows by adapter route-selection semantics. */
function adapterCompatibleRoutes(
  rows: RouteRow[],
  adapter: AdapterInfo,
  catalog: CatalogModelsResult,
  model: string | undefined,
): RouteRow[] {
  if (adapter.routeSelection === "free") return rows
  if (adapter.routeSelection === "derived-from-model") {
    return rows.filter(r => catalogRouteFor(catalog, model, r.value)?.adapters.includes(adapter.slug))
  }
  // Fixed single-provider adapter: keep direct vendor routes or routes explicitly
  // contributed by this adapter.
  const modelRoute = routeForModel(model, catalog)
  return rows.filter(r => r.value === modelRoute || catalogRouteFor(catalog, model, r.value)?.adapters.includes(adapter.slug))
}

/** Build route rows via sessionConfig.logic.ts's canonical resolver, then fall
 *  back to a deterministic native route for fixed adapters when the catalog is
 *  sparse. */
function buildRouteRows(
  adapter: AdapterInfo | undefined,
  catalog: CatalogModelsResponse,
  model: string | undefined,
  profiles: AuthProfileSummary[],
): RouteRow[] {
  if (!adapter) return []

  // For derived-from-model adapters with no model selected yet, union routes
  // across all declared models so the user can pick a vendor first.
  if (adapter.routeSelection === "derived-from-model" && !model) {
    const seen = new Map<string, RouteRow>()
    for (const entry of modelEntriesOf(asSpawnAdapter(adapter))) {
      const rows = resolveRouteRows(catalog as CatalogModelsResult, entry.id)
      for (const row of rows) {
        if (!seen.has(row.value)) seen.set(row.value, row)
      }
    }
    return [...seen.values()]
  }

  const rows = resolveRouteRows(catalog as CatalogModelsResult, model)
  const filtered = adapterCompatibleRoutes(rows, adapter, catalog as CatalogModelsResult, model)
  if (filtered.length > 0) return filtered

  // Fixed-native adapter with no catalog match: synthesize a single native route.
  if (!adapter.routeSelection && model) {
    const route = routeForModel(model, catalog as CatalogModelsResult) ?? "unknown"
    const eligibleProfiles = profiles
      .filter(p => p.endpoint === route)
      .map(p => p.id)
    return [{
      value: route,
      label: `${prettyProvider(route)} (native route)`,
      baseUrl: null,
      runnable: eligibleProfiles.length > 0,
      curated: true,
      eligibleProfiles,
      fixed: true,
      ref: canonicalModelRef(model, route),
    }]
  }

  return []
}

/** Build posture rows via sessionConfig.logic.ts's canonical resolver. */
function buildPostureRows(
  adapter: AdapterInfo | undefined,
): ConfigurationLabAxisOptions["postures"] {
  const modes: HarnessMode[] = (adapter?.modes ?? []).map(m => ({
    id: m.id,
    ...(m.status_note ? { description: m.status_note } : {}),
  }))
  return resolvePostureRows(modes)
}

/** Build effort options via sessionConfig.logic.ts's canonical resolver. */
function buildEffortRows(
  adapter: AdapterInfo | undefined,
  capabilities: HarnessCapabilities | undefined,
  model: string | undefined,
): ConfigurationLabAxisOptions["efforts"] {
  const input: CapabilityResolutionInput = {
    adapter: asSpawnAdapter(adapter ?? { slug: "unknown" }),
    model,
    defaultEfforts: DEFAULT_EFFORTS as readonly EffortLevel[],
  }
  return resolveEfforts(input)
}

/** Build access/profile rows for the currently selected route. */
function buildProfileRows(
  routeRows: RouteRow[],
  profiles: AuthProfileSummary[],
  selectedRoute: string | undefined,
): ConfigurationLabAxisOptions["profiles"] {
  const currentRoute = routeRows.find(r => r.value === selectedRoute)
  const { rows } = resolveAccessRows({
    currentRoute,
    profiles: toAuthProfileRows(profiles),
  })
  return rows.map(r => ({
    value: r.value,
    label: r.label,
    description: r.description,
    addProfile: r.addProfile,
  }))
}

/** Resolve the effective value for a field, tagging it explicit/default/unset. */
function effectiveField(
  key: string,
  options: {
    explicit?: string
    defaultValue?: string
    detail?: string
  },
): ConfigurationLabEffectiveField {
  if (options.explicit) {
    return { key, value: options.explicit, source: "explicit", detail: options.detail }
  }
  if (options.defaultValue) {
    return { key, value: options.defaultValue, source: "default", detail: options.detail }
  }
  return { key, source: "unset" }
}

/** Build the readable effective-config summary. */
function buildEffectiveConfig(
  selection: ConfigurationLabSelectionInput,
  adapter: AdapterInfo | undefined,
  capabilities: HarnessCapabilities | undefined,
  postureRows: PostureRow[],
  effortRows: string[],
  routeIsDefault: boolean,
  profileIsDefault: boolean,
  currentRoute: RouteRow | undefined,
): ConfigurationLabEffectiveField[] {
  const selectedPosture = postureRows.find(r => r.value === selection.posture)
  const selectedEffort = effortRows.find(e => e === selection.effort)

  const fields: ConfigurationLabEffectiveField[] = []
  fields.push(
    effectiveField("Harness", {
      explicit: selection.adapter,
      defaultValue: adapter?.slug,
    }),
  )
  fields.push(
    effectiveField("Model", {
      explicit: selection.model,
      defaultValue: capabilities?.models?.defaultModel,
    }),
  )
  fields.push(
    effectiveField("Route / gateway", {
      explicit: routeIsDefault ? undefined : selection.route,
      defaultValue: routeIsDefault ? selection.route : undefined,
      detail: currentRoute?.fixed
        ? "native route"
        : routeIsDefault
          ? "adapter default"
          : undefined,
    }),
  )
  fields.push(
    effectiveField("Auth profile", {
      explicit: profileIsDefault ? undefined : selection.profile,
      defaultValue: profileIsDefault ? selection.profile : undefined,
      detail: profileIsDefault ? "default eligible profile" : selection.profile ? undefined : "daemon resolves default wallet",
    }),
  )
  fields.push(
    effectiveField("Posture", {
      explicit: selection.posture,
      defaultValue: "default",
      detail: selectedPosture
        ? `${selectedPosture.enforcement}${selectedPosture.restartRequired ? " · restart required" : ""}`
        : undefined,
    }),
  )
  fields.push(
    effectiveField("Effort", {
      explicit: selection.effort,
      defaultValue: adapter?.slug.startsWith("claude")
        ? "high"
        : undefined,
      detail: selectedEffort ? undefined : "not offered for this model",
    }),
  )
  return fields
}

/** Run compatibility validation across the current selection. */
function validateSelection(
  selection: ConfigurationLabSelectionInput,
  adapter: AdapterInfo | undefined,
  capabilities: HarnessCapabilities | undefined,
  routeRows: RouteRow[],
  postureRows: PostureRow[],
  effortRows: string[],
  modelOptions: ConfigurationLabAxisOptions["models"],
): ConfigurationLabIssue[] {
  const issues: ConfigurationLabIssue[] = []

  if (!selection.adapter) {
    issues.push({
      severity: "info",
      axis: "harness",
      message: "Select a harness to see compatible models and routes.",
    })
    return issues
  }

  if (!adapter) {
    issues.push({
      severity: "error",
      axis: "harness",
      message: `Harness "${selection.adapter}" is not installed or not resolvable.`,
    })
    return issues
  }

  // Model validation.
  if (selection.model) {
    const declared = modelOptions.some(m => m.id === selection.model)
    if (!declared) {
      if (adapter.routeSelection === "derived-from-model") {
        issues.push({
          severity: "error",
          axis: "model",
          message: `${selection.model} is not available on the selected route for ${adapter.slug}.`,
        })
      } else {
        issues.push({
          severity: "warning",
          axis: "model",
          message: `${selection.model} is not in ${adapter.slug}'s declared model list; spawn may reject it.`,
        })
      }
    }
  } else {
    issues.push({
      severity: "info",
      axis: "model",
      message: `No model selected — ${adapter.slug} will use its default (${capabilities?.models?.defaultModel ?? "adapter default"}).`,
    })
  }

  // Route validation.
  if (selection.route) {
    const routeRow = routeRows.find(r => r.value === selection.route)
    if (!routeRow) {
      issues.push({
        severity: "error",
        axis: "route",
        message: `Route "${selection.route}" is not available for ${selection.model ?? "this model"}.`,
      })
    } else if (!routeRow.runnable) {
      issues.push({
        severity: "error",
        axis: "route",
        message: `Route "${selection.route}" has no eligible auth profile — add one to spawn this combination.`,
      })
    } else if (selection.profile && !routeRow.eligibleProfiles.includes(selection.profile)) {
      issues.push({
        severity: "error",
        axis: "profile",
        message: `Profile "${selection.profile}" is not eligible for route "${selection.route}".`,
      })
    }
  } else if (selection.model) {
    issues.push({
      severity: "error",
      axis: "route",
      message: `No route resolved for ${selection.model} — the spawn handoff cannot determine the billing endpoint.`,
    })
  }

  // Profile validation.
  if (selection.profile && !routeRows.some(r => r.eligibleProfiles.includes(selection.profile!))) {
    issues.push({
      severity: "warning",
      axis: "profile",
      message: `Profile "${selection.profile}" is not eligible for any route of ${selection.model ?? "this model"}.`,
    })
  }

  // Posture validation.
  if (selection.posture) {
    const postureRow = postureRows.find(r => r.value === selection.posture)
    if (!postureRow) {
      issues.push({
        severity: "warning",
        axis: "posture",
        message: `Posture "${selection.posture}" is not recognized by ${adapter.slug}.`,
      })
    } else if (postureRow.enforcement === "advisory") {
      issues.push({
        severity: "warning",
        axis: "posture",
        message: `${selection.posture} is advisory (prompt-injected) — not enforced by the harness.`,
      })
    }
  }

  // Effort validation.
  if (selection.effort && !effortRows.includes(selection.effort)) {
    issues.push({
      severity: "warning",
      axis: "effort",
      message: `Effort "${selection.effort}" is not offered for ${selection.model ?? "this model"}.`,
    })
  }

  return issues
}

/** Default selection to apply when the user picks a harness but nothing else. */
function defaultSelectionForAdapter(
  adapter: AdapterInfo | undefined,
  capabilities: HarnessCapabilities | undefined,
): Partial<ConfigurationLabSelectionInput> {
  if (!adapter) return {}
  return {
    adapter: adapter.slug,
    model: capabilities?.models?.defaultModel,
  }
}

/** The main entry point: turn raw daemon data + current selection into the
 *  full Lab snapshot. */
export function buildConfigurationLabSnapshot(
  data: ConfigurationLabRawData,
  input: ConfigurationLabSelectionInput,
): ConfigurationLabSnapshot {
  const adapter = findAdapter(data.adapters, input.adapter)
  const capabilities = findHarnessCapabilities(data.capabilities, input.adapter)

  let selection: ConfigurationLabSelectionInput = { ...input }

  // When the user just picked a harness, seed the model default so the panel
  // isn't blank.
  if (!selection.model && !selection.route && !selection.profile) {
    selection = { ...selection, ...defaultSelectionForAdapter(adapter, capabilities) }
  }

  // First pass: build route rows from the current model (or union all models
  // for derived-from-model adapters with no model yet).
  let routeRows = buildRouteRows(adapter, data.catalog, selection.model, data.profiles)

  // The catalog cast is needed by route/model resolution below.
  const catalog = data.catalog as CatalogModelsResult

  // Resolve default route when none was explicitly selected. For
  // derived-from-model adapters, the model id's own prefix/pin is the
  // authoritative route — picking the first runnable catalog row would
  // override an explicit `openrouter/...` selection with the direct-vendor
  // route.
  let resolvedRoute = selection.route
  let routeIsDefault = false
  if (!resolvedRoute && routeRows.length > 0) {
    if (adapter?.routeSelection === "derived-from-model" && selection.model) {
      resolvedRoute = routeForModel(selection.model, catalog) ?? defaultRouteFrom(routeRows)
    } else {
      resolvedRoute = defaultRouteFrom(routeRows)
    }
    routeIsDefault = true
  }

  // Build model options, scoped by resolved route for derived-from-model adapters.
  let modelOptions = buildModelOptions(adapter, catalog, resolvedRoute)

  // For derived-from-model adapters, ensure the selected model is compatible
  // with the resolved route; otherwise pick the first available model.
  if (adapter?.routeSelection === "derived-from-model" && selection.model && !modelOptions.some(m => m.id === selection.model)) {
    if (modelOptions.length > 0) {
      selection = { ...selection, model: modelOptions[0]!.id }
      routeRows = buildRouteRows(adapter, data.catalog, selection.model, data.profiles)
      if (routeIsDefault && routeRows.length > 0) {
        resolvedRoute = defaultRouteFrom(routeRows)
      }
      modelOptions = buildModelOptions(adapter, catalog, resolvedRoute)
    }
  }

  // If model is still unset after route resolution, seed from scoped options.
  if (!selection.model && modelOptions.length > 0) {
    selection = { ...selection, model: modelOptions[0]!.id }
    routeRows = buildRouteRows(adapter, data.catalog, selection.model, data.profiles)
    if (routeIsDefault && routeRows.length > 0) {
      resolvedRoute = defaultRouteFrom(routeRows)
    }
    modelOptions = buildModelOptions(adapter, catalog, resolvedRoute)
  }

  const currentRoute = routeRows.find(r => r.value === resolvedRoute)

  // Resolve default profile when none was explicitly selected.
  let resolvedProfile = selection.profile
  let profileIsDefault = false
  if (!resolvedProfile && currentRoute && currentRoute.eligibleProfiles.length > 0) {
    resolvedProfile = currentRoute.eligibleProfiles[0]
    profileIsDefault = true
  }

  const finalSelection: ConfigurationLabSelectionInput = {
    ...selection,
    route: resolvedRoute,
    profile: resolvedProfile,
  }

  const postureRows = buildPostureRows(adapter)
  const effortRows = buildEffortRows(adapter, capabilities, finalSelection.model)

  const axes: ConfigurationLabAxisOptions = {
    models: modelOptions,
    routes: routeRows.map(r => ({
      value: r.value,
      label: r.label,
      runnable: r.runnable,
      curated: r.curated,
      eligibleProfiles: r.eligibleProfiles,
      fixed: r.fixed,
      ref: r.ref,
    })),
    profiles: buildProfileRows(routeRows, data.profiles, resolvedRoute),
    postures: postureRows.map(r => ({
      value: r.value,
      label: r.label,
      enforcement: r.enforcement,
      restartRequired: r.restartRequired,
    })),
    efforts: effortRows,
  }

  const issues = validateSelection(
    finalSelection,
    adapter,
    capabilities,
    routeRows,
    postureRows,
    effortRows,
    modelOptions,
  )

  const effective = buildEffectiveConfig(
    finalSelection,
    adapter,
    capabilities,
    postureRows,
    effortRows,
    routeIsDefault,
    profileIsDefault,
    currentRoute,
  )

  return {
    selection: {
      adapter: finalSelection.adapter,
      model: finalSelection.model,
      route: finalSelection.route,
      profile: finalSelection.profile,
      posture: finalSelection.posture,
      effort: finalSelection.effort,
      options: finalSelection.options,
    },
    adapters: data.adapters,
    harness: buildHarnessLayer(adapter, capabilities),
    axes,
    effective,
    issues,
  }
}

/** Async fetch helper used by the webview provider: gather the canonical
 *  metadata the Lab needs. Errors are caught and returned as empty data so the
 *  panel degrades gracefully when the daemon is unreachable. */
export async function fetchConfigurationLabData(
  fetchers: {
    listAdapters: () => Promise<AdapterInfo[]>
    harnessCapabilities: (adapter?: string) => Promise<HarnessCapabilities[]>
    catalogModels: () => Promise<CatalogModelsResponse>
    listAuthProfiles: () => Promise<AuthProfileSummary[]>
    listProviderPresets: () => Promise<ProviderPresetEntry[]>
  },
  selectedAdapter?: string,
): Promise<ConfigurationLabRawData> {
  const [adapters, capabilities, catalog, profiles, presets] = await Promise.all([
    fetchers.listAdapters().catch(() => [] as AdapterInfo[]),
    fetchers.harnessCapabilities(selectedAdapter).catch(() => [] as HarnessCapabilities[]),
    fetchers.catalogModels().catch(() => ({ vendors: [] }) as CatalogModelsResponse),
    fetchers.listAuthProfiles().catch(() => [] as AuthProfileSummary[]),
    fetchers.listProviderPresets().catch(() => [] as ProviderPresetEntry[]),
  ])
  return { adapters, capabilities, catalog, profiles, presets }
}

/** Convert the current Lab selection into the minimal spawn-options shape the
 *  existing `agentproto.spawnAgent` command accepts, so the panel can hand off
 *  to the wizard without duplicating spawn logic.
 *
 *  For `derived-from-model` adapters (opencode, hermes, …) the model id's own
 *  prefix/pin is the route selector, so the original selected id is preserved
 *  rather than replaced by the catalog's canonical `@route` ref. That keeps
 *  `openrouter/vendor/product` ids intact on the wire, matching what the
 *  adapter's CLI actually resolves. Fixed / free adapters still get the
 *  canonical catalog ref so gateway/base_url routing stays consistent. */
export function labSelectionToSpawnArgs(
  snapshot: ConfigurationLabSnapshot,
): {
  adapter: string
  model?: string
  route?: { gateway: string }
  access?: { profileRef?: string }
  posture?: string
  effort?: string
} {
  const selection = snapshot.selection
  const routeRow = snapshot.axes.routes.find(r => r.value === selection.route)
  const adapterInfo = snapshot.adapters.find(a => a.slug === selection.adapter)
  const preserveModelId = adapterInfo?.routeSelection === "derived-from-model"
  const ref = preserveModelId
    ? selection.model
    : (routeRow?.ref ?? canonicalModelRef(selection.model, selection.route))

  return {
    adapter: selection.adapter!,
    ...(ref ? { model: ref } : {}),
    ...(selection.route ? { route: { gateway: selection.route } } : {}),
    ...(selection.profile ? { access: { profileRef: selection.profile } } : {}),
    ...(selection.posture ? { posture: selection.posture } : {}),
    ...(selection.effort ? { effort: selection.effort } : {}),
  }
}
