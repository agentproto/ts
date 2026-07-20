/**
 * Pure tree-building logic for the auth profiles view — no vscode import so
 * it's unit-testable under plain vitest.
 */

import type {
  CatalogModelsResponse,
  ProviderPresetEntry,
} from "../client/types.js"

export type AuthProfileNode =
  | { kind: "preset"; preset: ProviderPresetEntry }
  | { kind: "profile"; profileId: string; routesCount: number }

export type AuthProfileGroup =
  | { kind: "presets"; label: string }
  | { kind: "profiles"; label: string }

export type AuthProfileTreeNode = AuthProfileGroup | AuthProfileNode

export function isAuthProfileGroup(node: AuthProfileTreeNode): node is AuthProfileGroup {
  return node.kind === "presets" || node.kind === "profiles"
}

export function isAuthProfileNode(node: AuthProfileTreeNode): node is AuthProfileNode {
  return node.kind === "preset" || node.kind === "profile"
}

function presetSortKey(preset: ProviderPresetEntry): string {
  const readyFirst = preset.status === "ready" ? "0" : "1"
  const name = (preset.name ?? preset.slug).toLowerCase()
  return `${readyFirst}|${name}|${preset.slug}`
}

export function buildPresetNodes(presets: ProviderPresetEntry[]): AuthProfileNode[] {
  return [...presets]
    .sort((a, b) => (presetSortKey(a) < presetSortKey(b) ? -1 : 1))
    .map(preset => ({ kind: "preset", preset }))
}

export function buildProfileNodes(
  catalog: CatalogModelsResponse,
): { profileId: string; routesCount: number }[] {
  const counts = new Map<string, number>()
  for (const vendor of catalog.vendors ?? []) {
    for (const product of vendor.products ?? []) {
      for (const route of product.routes ?? []) {
        for (const profileId of route.eligibleProfiles ?? []) {
          counts.set(profileId, (counts.get(profileId) ?? 0) + 1)
        }
      }
    }
  }
  return [...counts.entries()]
    .map(([profileId, routesCount]) => ({ profileId, routesCount }))
    .sort((a, b) => {
      if (b.routesCount !== a.routesCount) return b.routesCount - a.routesCount
      return a.profileId.localeCompare(b.profileId)
    })
}

export function presetIcon(preset: ProviderPresetEntry): string {
  // Status-aware codicon id: both states use the key icon per the current
  // design spec; the function is kept stable so the view can switch later.
  return preset.status === "ready" ? "key" : "key"
}

export function presetDescription(preset: ProviderPresetEntry): string {
  const keyEnv = preset.info?.keyEnv
  if (keyEnv) return `${preset.slug} · ${keyEnv}`
  return preset.slug
}

export function presetTooltip(preset: ProviderPresetEntry): string {
  const info = preset.info
  const lines: string[] = []
  lines.push(`**${preset.name ?? preset.slug}**`)
  lines.push(`- Slug: \`${preset.slug}\``)
  lines.push(`- Status: ${preset.status}`)
  if (info) {
    if (info.schemaFlavor) lines.push(`- Schema flavor: ${info.schemaFlavor}`)
    if (info.baseUrl) lines.push(`- Base URL: ${info.baseUrl}`)
    if (info.keyEnv) lines.push(`- Key env: \`${info.keyEnv}\``)
    if (info.defaultModel) lines.push(`- Default model: ${info.defaultModel}`)
  }
  if (preset.description) {
    lines.push("")
    lines.push(preset.description)
  }
  return lines.join("\n")
}

export function profileDescription(routesCount: number): string {
  return `${routesCount} route${routesCount === 1 ? "" : "s"}`
}

export function profileTooltip(profileId: string, routesCount: number): string {
  return [`**${profileId}**`, ``, `- Eligible routes: ${routesCount}`].join("\n")
}
