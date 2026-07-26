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

/** Build the model option list from the adapter's declared models. */
function buildModelOptions(adapter: AdapterInfo | undefined): ConfigurationLabAxisOptions["models"] {
  if (!adapter) return []
  return modelEntriesOf(asSpawnAdapter(adapter)).map(entry => ({
    id: entry.id,
    ...(entry.provider ? { provider: entry.provider } : {}),
    ...(entry.mode ? { mode: entry.mode } : {}),
  }))
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

/** Build route rows via sessionConfig.logic.ts's canonical resolver. */
function buildRouteRows(
  catalog: CatalogModelsResponse,
  model: string | undefined,
): RouteRow[] {
  return resolveRouteRows(catalog as CatalogModelsResult, model)
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
      explicit: selection.route,
      detail: selection.route ? undefined : "adapter default",
    }),
  )
  fields.push(
    effectiveField("Auth profile", {
      explicit: selection.profile,
      detail: selection.profile ? undefined : "daemon resolves default wallet",
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
      issues.push({
        severity: "warning",
        axis: "model",
        message: `${selection.model} is not in ${adapter.slug}'s declared model list; spawn may reject it.`,
      })
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
        severity: "warning",
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
  const modelOptions = buildModelOptions(adapter)
  return {
    adapter: adapter.slug,
    model: capabilities?.models?.defaultModel ?? modelOptions[0]?.id,
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

  // When the user just picked a harness, seed the model default so the panel
  // isn't blank.
  const seededDefaults = !input.model && !input.route && !input.profile
    ? defaultSelectionForAdapter(adapter, capabilities)
    : {}
  const selection: ConfigurationLabSelectionInput = {
    ...input,
    ...seededDefaults,
  }

  const modelOptions = buildModelOptions(adapter)
  const routeRows = buildRouteRows(data.catalog, selection.model)
  const postureRows = buildPostureRows(adapter)
  const effortRows = buildEffortRows(adapter, capabilities, selection.model)

  const axes: ConfigurationLabAxisOptions = {
    models: modelOptions,
    routes: routeRows.map(r => ({
      value: r.value,
      label: r.label,
      runnable: r.runnable,
      curated: r.curated,
      eligibleProfiles: r.eligibleProfiles,
    })),
    profiles: buildProfileRows(routeRows, data.profiles, selection.route),
    postures: postureRows.map(r => ({
      value: r.value,
      label: r.label,
      enforcement: r.enforcement,
      restartRequired: r.restartRequired,
    })),
    efforts: effortRows,
  }

  const issues = validateSelection(
    selection,
    adapter,
    capabilities,
    routeRows,
    postureRows,
    effortRows,
    modelOptions,
  )

  const effective = buildEffectiveConfig(
    selection,
    adapter,
    capabilities,
    postureRows,
    effortRows,
  )

  return {
    selection: {
      adapter: selection.adapter,
      model: selection.model,
      route: selection.route,
      profile: selection.profile,
      posture: selection.posture,
      effort: selection.effort,
      options: selection.options,
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
 *  to the wizard without duplicating spawn logic. */
export function labSelectionToSpawnArgs(
  selection: ConfigurationLabSelectionInput,
): {
  adapter: string
  model?: string
  route?: { gateway: string }
  access?: { profileRef?: string }
  posture?: string
  effort?: string
} {
  return {
    adapter: selection.adapter!,
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.route ? { route: { gateway: selection.route } } : {}),
    ...(selection.profile ? { access: { profileRef: selection.profile } } : {}),
    ...(selection.posture ? { posture: selection.posture } : {}),
    ...(selection.effort ? { effort: selection.effort } : {}),
  }
}
