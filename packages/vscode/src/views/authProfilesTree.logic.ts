/**
 * Pure tree-building logic for the auth profiles view — no vscode import so
 * it's unit-testable under plain vitest.
 */

import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  ProviderPresetEntry,
} from "../client/types.js"

/** One model a profile can bill, flattened from the catalog for the expanded
 *  profile node. `runnable` = spawnable right now (rendered "active"); a
 *  non-runnable route the profile is still eligible for is shown inactive. */
export interface ServicedModel {
  vendor: string
  product: string
  ref: string
  route: string
  runnable: boolean
}

export type AuthProfileNode =
  | { kind: "preset"; preset: ProviderPresetEntry; connected: boolean }
  | { kind: "profile"; profileId: string; routesCount: number }
  | { kind: "profile-model"; profileId: string; model: ServicedModel }

export type AuthProfileGroup =
  | { kind: "presets"; label: string }
  | { kind: "profiles"; label: string }

export type AuthProfileTreeNode = AuthProfileGroup | AuthProfileNode

export function isAuthProfileGroup(node: AuthProfileTreeNode): node is AuthProfileGroup {
  return node.kind === "presets" || node.kind === "profiles"
}

export function isAuthProfileNode(node: AuthProfileTreeNode): node is AuthProfileNode {
  return node.kind === "preset" || node.kind === "profile" || node.kind === "profile-model"
}

function presetSortKey(preset: ProviderPresetEntry): string {
  const readyFirst = preset.status === "ready" ? "0" : "1"
  const name = (preset.name ?? preset.slug).toLowerCase()
  return `${readyFirst}|${name}|${preset.slug}`
}

/** A preset is "connected" when some api-key profile targets its endpoint —
 *  an auth profile's `endpoint` equals the preset `slug` (see
 *  authProfileFlow.logic.ts endpointChoices). This is the signal behind the
 *  "no profiles connected" confusion: an available preset with no matching
 *  profile can't bill anything until one is created. */
export function presetConnected(
  preset: ProviderPresetEntry,
  profiles: readonly AuthProfileSummary[],
): boolean {
  return profiles.some(p => p.endpoint === preset.slug)
}

export function buildPresetNodes(
  presets: ProviderPresetEntry[],
  profiles: readonly AuthProfileSummary[] = [],
): AuthProfileNode[] {
  return [...presets]
    .sort((a, b) => (presetSortKey(a) < presetSortKey(b) ? -1 : 1))
    .map(preset => ({ kind: "preset", preset, connected: presetConnected(preset, profiles) }))
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

/**
 * Every model each profile can bill, keyed by profile id — the inverse of the
 * catalog's per-route `eligibleProfiles`. Powers the expandable profile node
 * so the tree answers "what does THIS wallet get me?" directly, instead of a
 * bare route count. Order within a profile follows catalog walk order (vendor
 * → product → route).
 */
export function servicedModelsByProfile(
  catalog: CatalogModelsResponse,
): Map<string, ServicedModel[]> {
  const byProfile = new Map<string, ServicedModel[]>()
  for (const vendor of catalog.vendors ?? []) {
    for (const product of vendor.products ?? []) {
      for (const route of product.routes ?? []) {
        for (const profileId of route.eligibleProfiles ?? []) {
          const list = byProfile.get(profileId) ?? []
          list.push({
            vendor: vendor.vendor,
            product: product.product,
            ref: route.ref,
            route: route.route,
            runnable: route.runnable,
          })
          byProfile.set(profileId, list)
        }
      }
    }
  }
  return byProfile
}

/**
 * Profile nodes for the Model Profiles group: every profile that bills at
 * least one catalog route, UNIONED with every created auth profile (so a
 * profile that currently services nothing still shows, as "0 routes", rather
 * than silently vanishing — the opposite of the "which profiles do I even
 * have?" confusion). Catalog-active profiles first (by route count), then the
 * unused created ones alphabetically.
 */
export function buildProfileNodesWithProfiles(
  catalog: CatalogModelsResponse,
  profiles: readonly AuthProfileSummary[],
): { profileId: string; routesCount: number }[] {
  const fromCatalog = buildProfileNodes(catalog)
  const seen = new Set(fromCatalog.map(n => n.profileId))
  const unused = profiles
    .map(p => p.id)
    .filter(id => !seen.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map(profileId => ({ profileId, routesCount: 0 }))
  return [...fromCatalog, ...unused]
}

/** Codicon id for a serviced-model leaf: a runnable route is spawnable now
 *  (check), a non-runnable one is eligible-but-not-ready (slashed circle). */
export function servicedModelIcon(model: ServicedModel): string {
  return model.runnable ? "pass" : "circle-slash"
}

export function servicedModelDescription(model: ServicedModel): string {
  const state = model.runnable ? "active" : "inactive"
  return `${model.route} · ${state}`
}

/** Codicon for a preset row: a connected preset can bill (plug), an
 *  unconnected one needs a profile first (a plain key, the "add a credential"
 *  affordance). */
export function presetConnectionIcon(connected: boolean): string {
  return connected ? "plug" : "key"
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

/** The preset row's description, leading with connection state so the "no
 *  profile connected" gap is visible at a glance rather than buried in a
 *  tooltip. Connected → the plain preset description; unconnected → prefixed
 *  with "not connected". */
export function presetRowDescription(preset: ProviderPresetEntry, connected: boolean): string {
  return connected ? presetDescription(preset) : `not connected · ${presetDescription(preset)}`
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

/** A profile is enabled unless explicitly `disabled` (WS2) — the REAL
 *  persisted state, distinct from the derived `runnable` flag. */
export function profileEnabled(summary: AuthProfileSummary | undefined): boolean {
  return !summary?.disabled
}

/** The tree context value driving the enable/disable menu split. A disabled
 *  profile offers "Enable", an enabled one "Disable"; both still offer
 *  Delete (the package.json when-clause matches either). */
export function profileContextValue(summary: AuthProfileSummary | undefined): string {
  return profileEnabled(summary) ? "auth-profile-enabled" : "auth-profile-disabled"
}

/**
 * The read-only KEY IDENTITY line (WS5), computed by the daemon — never a
 * plaintext secret. A source-backed profile self-refreshes (no stored secret);
 * a stored secret shows its `last4` tail + one-way fingerprint; an unreadable
 * secret is surfaced explicitly rather than hidden. Returns undefined when the
 * daemon reported no key status (an older daemon), so the row simply omits it.
 */
export function profileKeyLabel(summary: AuthProfileSummary | undefined): string | undefined {
  if (!summary) return undefined
  if (summary.keyStatus === "self-refreshing" || (!summary.keyStatus && summary.source)) {
    return "self-refreshing — no stored secret"
  }
  if (summary.keyStatus === "stored") {
    const tail = summary.last4 ? `••••${summary.last4}` : "key stored"
    return summary.fingerprint ? `${tail} · ${summary.fingerprint}` : tail
  }
  if (summary.keyStatus === "unavailable") return "key unavailable"
  return undefined
}

/** The curated model ids to render as read-only chips (WS3) — only when the
 *  profile is in `allow` mode; an absent/`all` curation services everything
 *  and shows no chips. The "+" write picker is owned by another track; this is
 *  display-only. */
export function profileCuratedIds(summary: AuthProfileSummary | undefined): string[] {
  return summary?.models?.mode === "allow" ? summary.models.ids : []
}

/** The profile row's description: route count, plus a "disabled" marker and
 *  the key-identity tail when known. */
export function profileRowDescription(
  routesCount: number,
  summary: AuthProfileSummary | undefined,
): string {
  const parts = [profileDescription(routesCount)]
  if (!profileEnabled(summary)) parts.push("disabled")
  const key = profileKeyLabel(summary)
  if (key) parts.push(key)
  return parts.join(" · ")
}

/** The profile row's rich tooltip: enabled state, key identity, and any
 *  curated allowlist, on top of the eligible-route count. */
export function profileRowTooltip(
  profileId: string,
  routesCount: number,
  summary: AuthProfileSummary | undefined,
): string {
  const lines = [`**${profileId}**`, ``, `- Eligible routes: ${routesCount}`]
  lines.push(`- State: ${profileEnabled(summary) ? "enabled" : "disabled"}`)
  const key = profileKeyLabel(summary)
  if (key) lines.push(`- Key: ${key}`)
  const curated = profileCuratedIds(summary)
  if (curated.length > 0) {
    lines.push(`- Curated to ${curated.length} model${curated.length === 1 ? "" : "s"}:`)
    for (const id of curated) lines.push(`  - \`${id}\``)
  } else if (summary?.models?.mode === "allow") {
    // An explicit empty allowlist services nothing — call that out.
    lines.push(`- Curated: services no models (empty allowlist)`)
  }
  return lines.join("\n")
}
