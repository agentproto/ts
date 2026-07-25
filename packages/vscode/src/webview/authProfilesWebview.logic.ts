/**
 * Pure Auth Profiles webview model — no vscode import so it's unit-testable
 * under plain vitest. Reshapes provider presets, model profiles, and the Local
 * Router status into the collapsible-section row model the webview paints.
 */

import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  LlmEndpointStatusResult,
  ProviderPresetEntry,
} from "../client/types.js"
import {
  buildPresetNodes,
  buildProfileNodesWithProfiles,
  presetConnected,
  presetRowDescription,
  profileEnabled,
  profileRowDescription,
  servicedModelsByProfile,
  type ServicedModel,
} from "../views/authProfilesTree.logic.js"
import {
  routerDescription,
  routerLabel,
  routerRunning,
  routerServing,
} from "../views/localRouterTree.logic.js"
import { adapterLogoFor, type AdapterLogo } from "./adapterIcon.logic.js"

export type AuthProfileStatus = "ready" | "available" | "dim" | "unconnected"

export interface PresetWebviewRow {
  kind: "preset"
  slug: string
  name: string
  description: string
  connected: boolean
  logo: AdapterLogo
}

export interface ModelWebviewRow {
  kind: "model"
  product: string
  description: string
  runnable: boolean
}

export interface ProfileWebviewRow {
  kind: "profile"
  profileId: string
  name: string
  description: string
  enabled: boolean
  logo: AdapterLogo
  expanded: boolean
  children: ModelWebviewRow[]
}

export interface RouterWebviewRow {
  kind: "router"
  name: string
  description: string
  status: AuthProfileStatus
}

export interface AuthProfilesSection<T> {
  kind: "presets" | "profiles" | "router"
  label: string
  count: number | string
  expanded: boolean
  rows: T[]
}

export interface AuthProfilesWebviewModel {
  presets: AuthProfilesSection<PresetWebviewRow>
  profiles: AuthProfilesSection<ProfileWebviewRow>
  router: AuthProfilesSection<RouterWebviewRow>
}

export interface AuthProfilesExpandedState {
  presets: boolean
  profiles: boolean
  router: boolean
}

export function routerStatusFor(status: LlmEndpointStatusResult | null): AuthProfileStatus {
  if (!status) return "dim"
  if (status.status === "starting") return "available"
  if (routerServing(status)) return "ready"
  if (routerRunning(status)) return "available"
  return "dim"
}

function toPresetRow(
  preset: ProviderPresetEntry,
  profiles: readonly AuthProfileSummary[],
): PresetWebviewRow {
  const connected = presetConnected(preset, profiles)
  return {
    kind: "preset",
    slug: preset.slug,
    name: preset.name?.trim() || preset.slug,
    description: presetRowDescription(preset, connected),
    connected,
    logo: adapterLogoFor(preset.slug),
  }
}

function toModelRow(model: ServicedModel): ModelWebviewRow {
  return {
    kind: "model",
    product: model.product,
    description: `${model.route} · ${model.runnable ? "active" : "inactive"}`,
    runnable: model.runnable,
  }
}

function toProfileRow(
  profileId: string,
  routesCount: number,
  summaries: ReadonlyMap<string, AuthProfileSummary>,
  serviced: ReadonlyMap<string, ServicedModel[]>,
  expandedProfiles: ReadonlySet<string>,
): ProfileWebviewRow {
  const summary = summaries.get(profileId)
  const enabled = profileEnabled(summary)
  return {
    kind: "profile",
    profileId,
    name: profileId,
    description: profileRowDescription(routesCount, summary),
    enabled,
    logo: adapterLogoFor(summary?.endpoint ?? profileId),
    expanded: expandedProfiles.has(profileId),
    children: expandedProfiles.has(profileId)
      ? (serviced.get(profileId) ?? []).map(toModelRow)
      : [],
  }
}

function rowMatchesSearch(row: { name: string; description: string }, search: string): boolean {
  if (search.length === 0) return true
  const term = search.toLowerCase()
  return row.name.toLowerCase().includes(term) || row.description.toLowerCase().includes(term)
}

function routerCountLabel(status: LlmEndpointStatusResult | null): string {
  if (!status) return "stopped"
  if (status.status === "never-started") return "stopped"
  if (routerServing(status)) return "healthy"
  return status.status
}

export function buildAuthProfilesWebviewModel(
  presets: readonly ProviderPresetEntry[],
  profiles: readonly AuthProfileSummary[],
  catalog: CatalogModelsResponse,
  routerStatus: LlmEndpointStatusResult | null,
  search: string,
  expanded: AuthProfilesExpandedState,
  expandedProfiles: ReadonlySet<string>,
): AuthProfilesWebviewModel {
  const summaries = new Map(profiles.map(p => [p.id, p]))
  const serviced = servicedModelsByProfile(catalog)

  const presetRows = buildPresetNodes([...presets], profiles)
    .filter(n => n.kind === "preset")
    .map(n => toPresetRow(n.preset, profiles))

  const profileNodes = buildProfileNodesWithProfiles(catalog, profiles)
  const profileRows = profileNodes.map(n =>
    toProfileRow(n.profileId, n.routesCount, summaries, serviced, expandedProfiles),
  )

  const routerRows: RouterWebviewRow[] = [
    {
      kind: "router",
      name: routerLabel(routerStatus),
      description: routerDescription(routerStatus),
      status: routerStatusFor(routerStatus),
    },
  ]

  const trimmed = search.trim()
  const visiblePresets = trimmed.length === 0 ? presetRows : presetRows.filter(r => rowMatchesSearch(r, trimmed))
  const visibleProfiles = trimmed.length === 0 ? profileRows : profileRows.filter(r => rowMatchesSearch(r, trimmed))
  const visibleRouter = trimmed.length === 0 ? routerRows : routerRows.filter(r => rowMatchesSearch(r, trimmed))

  return {
    presets: {
      kind: "presets",
      label: "Provider Presets",
      count: visiblePresets.length,
      expanded: expanded.presets,
      rows: visiblePresets,
    },
    profiles: {
      kind: "profiles",
      label: "Model Profiles",
      count: visibleProfiles.length,
      expanded: expanded.profiles,
      rows: visibleProfiles,
    },
    router: {
      kind: "router",
      label: "Local Router",
      count: routerCountLabel(routerStatus),
      expanded: expanded.router,
      rows: visibleRouter,
    },
  }
}
