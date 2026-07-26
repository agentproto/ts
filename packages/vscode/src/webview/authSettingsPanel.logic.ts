/**
 * Pure view-model + HTML for the Auth Settings webview — no `vscode` import so
 * it's unit-testable under plain vitest. The panel controller
 * (`authSettingsPanel.ts`) fetches presets + catalog + auth profiles, hands
 * them here to build the model and the page, and wires the message actions.
 *
 * The page answers the two questions the tree only hints at: which provider
 * presets are actually connected (and one-click connect the ones that aren't),
 * and — per wallet — exactly which models it can bill and whether each is
 * spawnable now (active) or merely eligible (inactive).
 */

import { LOCAL_LOGIN_RECIPES } from "../commands/authProfileFlow.logic.js"
import { importedBadge } from "../commands/onboarding.logic.js"
import {
  presetConnected,
  profileCuratedIds,
  profileEnabled,
  profileKeyLabel,
  servicedModelsByProfile,
  type ServicedModel,
} from "../views/authProfilesTree.logic.js"
import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  ProviderPresetEntry,
} from "../client/types.js"

export interface PresetRow {
  slug: string
  name: string
  connected: boolean
  keyEnv?: string
}

export interface UnavailableModel {
  product: string
  ref: string
  reason: string
}

export interface WalletRow {
  id: string
  endpoint: string
  label?: string
  /** Models this profile is currently configured to bill (allowed by curation
   *  and eligible by endpoint/method). These are the "active" pills. */
  models: ServicedModel[]
  /** Whole-profile enable/disable (WS2) — a REAL state, distinct from
   *  `runnableCount` (derived runnability). */
  enabled: boolean
  /** Read-only key identity (WS5): a `last4`+fingerprint tail, "self-refreshing",
   *  or "key unavailable". Undefined when the daemon reported no status. */
  keyLabel?: string
  /** Curated model ids (WS3) rendered as read-only chips — only when the
   *  profile is in `allow` mode. */
  curatedIds: string[]
  /** Provenance (WS6) — the discovery origin this profile was imported from,
   *  when it was created by `auth_profile_import`. Absent for a hand-created
   *  profile. Drives the "imported from <origin>" badge. */
  origin?: string
  /** How many catalog models this endpoint offers in total (e.g. the six xAI
   *  models), independent of this profile's curation or eligibility. */
  catalogCount: number
  /** How many of those catalog models are admitted by this profile's curation
   *  allowlist (`mode: "all"` counts everything). */
  curatedCount: number
  /** How many of those catalog models are runnable right now with this profile
   *  (endpoint/method eligible, profile enabled, and allowed by curation). */
  runnableCount: number
  /** Catalog models that match this endpoint but are not currently billable,
   *  with the data-supported reason (e.g. "curated out"). */
  unavailable: UnavailableModel[]
}

export interface AuthSettingsModel {
  presets: PresetRow[]
  wallets: WalletRow[]
}

/**
 * Per-model curation gate (WS3) — local mirror of the predicate in
 * `packages/runtime/src/catalog-models.ts`. An absent/`all` curation admits
 * everything; an `allow` curation admits the model when its id appears as the
 * route-qualified `ref`, the route-independent `vendor/product`, or (on a
 * direct route only) the bare product.
 */
function profileAllowsModel(
  profile: AuthProfileSummary,
  ref: string,
  vendorProduct: string,
): boolean {
  const curation = profile.models
  if (!curation || curation.mode === "all") return true
  const slash = vendorProduct.indexOf("/")
  const product = slash === -1 ? vendorProduct : vendorProduct.slice(slash + 1)
  const isDirect = !ref.includes("@")
  return (
    curation.ids.includes(ref) ||
    curation.ids.includes(vendorProduct) ||
    (isDirect && curation.ids.includes(product))
  )
}

interface ProfileCatalogCounts {
  catalogCount: number
  curatedCount: number
  runnableCount: number
  unavailable: UnavailableModel[]
}

/**
 * Counts for a single wallet against the catalog join, scoped to the wallet's
 * own billing endpoint (`route.route === profile.endpoint`). This keeps native
 * `xai` and `xai-anthropic` profiles from cross-qualifying: each only sees the
 * routes that bill its own endpoint.
 */
function catalogCountsForProfile(
  profile: AuthProfileSummary,
  catalog: CatalogModelsResponse,
): ProfileCatalogCounts {
  let catalogCount = 0
  let curatedCount = 0
  let runnableCount = 0
  const unavailable: UnavailableModel[] = []

  for (const vendor of catalog.vendors ?? []) {
    for (const product of vendor.products ?? []) {
      for (const route of product.routes ?? []) {
        if (route.route !== profile.endpoint) continue
        catalogCount++
        const vendorProduct = `${vendor.vendor}/${product.product}`
        const allowed = profileAllowsModel(profile, route.ref, vendorProduct)
        const runnable = profileEnabled(profile) && route.runnable && route.eligibleProfiles.includes(profile.id)

        if (allowed) curatedCount++
        if (runnable) runnableCount++

        if (profileEnabled(profile) && !runnable) {
          let reason = "not eligible"
          if (!allowed) reason = "curated out"
          unavailable.push({ product: product.product, ref: route.ref, reason })
        }
      }
    }
  }

  return { catalogCount, curatedCount, runnableCount, unavailable }
}

/**
 * Fold the three daemon responses into the panel's view model. Presets sort
 * unconnected-first (they're the ones needing action); wallets sort by how
 * many models they can actually bill (most useful first), then id.
 */
export function buildAuthSettingsModel(
  presets: readonly ProviderPresetEntry[],
  catalog: CatalogModelsResponse,
  profiles: readonly AuthProfileSummary[],
): AuthSettingsModel {
  const serviced = servicedModelsByProfile(catalog)

  const presetRows: PresetRow[] = [...presets]
    .map(p => ({
      slug: p.slug,
      name: p.name ?? p.slug,
      connected: presetConnected(p, profiles),
      ...(p.info?.keyEnv ? { keyEnv: p.info.keyEnv } : {}),
    }))
    .sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? 1 : -1
      return a.name.localeCompare(b.name)
    })

  const wallets: WalletRow[] = [...profiles]
    .map(p => {
      const keyLabel = profileKeyLabel(p)
      const enabled = profileEnabled(p)
      const counts = catalogCountsForProfile(p, catalog)
      // A disabled profile bills nothing, so don't render active/unavailable
      // pills even if the mock catalog still lists it in eligibleProfiles.
      const models = enabled ? (serviced.get(p.id) ?? []) : []
      const unavailable = enabled ? counts.unavailable : []
      return {
        id: p.id,
        endpoint: p.endpoint,
        ...(p.label ? { label: p.label } : {}),
        models,
        enabled,
        ...(keyLabel ? { keyLabel } : {}),
        curatedIds: profileCuratedIds(p),
        ...(p.origin ? { origin: p.origin } : {}),
        catalogCount: counts.catalogCount,
        curatedCount: counts.curatedCount,
        runnableCount: counts.runnableCount,
        unavailable,
      }
    })
    .sort((a, b) => {
      if (b.models.length !== a.models.length) return b.models.length - a.models.length
      return a.id.localeCompare(b.id)
    })

  return { presets: presetRows, wallets }
}

/** Minimal HTML escape for text interpolated into the page. */
export function esc(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function presetCard(p: PresetRow): string {
  const state = p.connected
    ? `<span class="badge ok">connected</span>`
    : `<span class="badge warn">not connected</span>`
  const key = p.keyEnv ? `<code>${esc(p.keyEnv)}</code>` : ""
  const action = p.connected
    ? ""
    : `<button class="act" data-action="connect" data-slug="${esc(p.slug)}">Connect</button>`
  return `<div class="card">
    <div class="row">
      <span class="title">${esc(p.name)}</span>${state}
      ${action}
    </div>
    <div class="sub">${esc(p.slug)}${key ? " · " + key : ""}</div>
  </div>`
}

function modelPill(m: ServicedModel): string {
  const cls = m.runnable ? "active" : "inactive"
  const dot = m.runnable ? "●" : "○"
  return `<span class="pill ${cls}" title="${esc(m.ref)} · ${esc(m.route)}">${dot} ${esc(m.product)} <em>${esc(m.route)}</em></span>`
}

function unavailablePill(m: UnavailableModel): string {
  return `<span class="pill inactive" title="${esc(m.ref)} · ${esc(m.reason)}">○ ${esc(m.product)}</span>`
}

function catalogSummary(w: WalletRow): string {
  if (!w.enabled) return `${w.runnableCount} active · ${w.catalogCount} catalog (profile disabled)`
  if (w.catalogCount === 0) return "No catalog models for this endpoint"
  if (w.curatedCount === w.catalogCount) return `${w.catalogCount} catalog models · ${w.runnableCount} active`
  const excluded = w.catalogCount - w.curatedCount
  return `${w.curatedCount} curated · ${w.catalogCount} catalog · ${w.runnableCount} active (${excluded} excluded by curation)`
}

function emptyMessage(w: WalletRow): string {
  if (!w.enabled) return "Profile disabled — no models active."
  if (w.catalogCount === 0) return "No catalog models for this endpoint."
  if (w.curatedCount === 0) return `Curation excludes all ${w.catalogCount} catalog models.`
  return "Bills no catalog model yet."
}

function walletCard(w: WalletRow): string {
  const allowedPills = w.models.map(modelPill).join("")
  const unavailablePills = w.unavailable.map(unavailablePill).join("")
  const modelsSection =
    allowedPills || unavailablePills
      ? `<div class="pills">${allowedPills}${unavailablePills}</div>`
      : `<div class="empty">${emptyMessage(w)}</div>`
  const label = w.label ? ` · ${esc(w.label)}` : ""
  // A REAL enable/disable badge (WS2), distinct from the derived active count.
  const stateBadge = w.enabled
    ? `<span class="badge ok">enabled</span>`
    : `<span class="badge warn">disabled</span>`
  const toggle = w.enabled
    ? `<button class="act" data-action="disable" data-id="${esc(w.id)}">Disable</button>`
    : `<button class="act" data-action="enable" data-id="${esc(w.id)}">Enable</button>`
  // Provenance badge (WS6) — where an imported profile came from.
  const badge = importedBadge(w.origin)
  const originBadge = badge ? `<span class="badge">${esc(badge)}</span>` : ""
  // Read-only key identity (WS5) — never a plaintext secret.
  const keyRow = w.keyLabel ? `<div class="sub">🔑 ${esc(w.keyLabel)}</div>` : ""
  // Curated allowlist chips (WS3 display) with a WS4 "×" remove toggle each.
  // The "+ Models" button opens the WS4 multi-select picker (full provider
  // list). An empty allowlist services everything, so the label reflects that.
  const curatedHeader = w.curatedIds.length > 0 ? "Curated to:" : "Allows all eligible models"
  const chips =
    w.curatedIds.length > 0
      ? `<div class="pills">${w.curatedIds
          .map(
            id =>
              `<span class="pill">${esc(id)} <button class="chip-x" data-action="removeModel" data-id="${esc(
                w.id,
              )}" data-model="${esc(id)}" title="Remove ${esc(id)}">×</button></span>`,
          )
          .join("")}</div>`
      : ""
  const curated = `<div class="sub">${curatedHeader}</div>${chips}`
  return `<div class="card">
    <div class="row">
      <span class="title">${esc(w.id)}</span>
      ${stateBadge}
      ${originBadge}
      <span class="badge">${catalogSummary(w)}</span>
      ${toggle}
      <button class="act" data-action="pickModels" data-id="${esc(w.id)}">+ Models</button>
      <button class="act danger" data-action="delete" data-id="${esc(w.id)}">Delete</button>
    </div>
    <div class="sub">${esc(w.endpoint)}${label}</div>
    ${keyRow}
    ${modelsSection}
    ${curated}
  </div>`
}

/**
 * The "use my existing local login" card — one button per source-backed recipe
 * (Claude Code today). A source-backed profile stores no secret and refreshes
 * itself, so it's the zero-friction way to connect a wallet. Lives at the top
 * of the Providers section.
 */
function localLoginCard(): string {
  const buttons = LOCAL_LOGIN_RECIPES.map(
    r =>
      `<button class="act" data-action="connectLocal" data-source="${esc(r.source)}" title="${esc(r.detail)}">${esc(r.label)}</button>`,
  ).join("")
  return `<div class="card">
    <div class="row"><span class="title">Use an existing local login</span></div>
    <div class="sub">Reuse a CLI you're already signed into — the token refreshes itself, nothing to paste.</div>
    <div class="pills">${buttons}</div>
  </div>`
}

/**
 * The full page. `nonce` gates the inline script (CSP); the only script is a
 * tiny event-delegated dispatcher that posts each button's action back to the
 * host — all rendering is server-built here so there's no client-side state to
 * drift.
 */
export function buildAuthSettingsHtml(model: AuthSettingsModel, nonce: string): string {
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join("; ")
  const presetSection =
    localLoginCard() +
    (model.presets.map(presetCard).join("") || `<div class="empty">No provider presets.</div>`)
  const walletSection = model.wallets.map(walletCard).join("") || `<div class="empty">No auth profiles yet.</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 16px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 18px 0 8px; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 4px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
    .row { display: flex; align-items: center; gap: 8px; }
    .title { font-weight: 600; }
    .sub { opacity: .65; font-size: 12px; margin-top: 2px; }
    .badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); opacity: .85; }
    .badge.ok { color: var(--vscode-testing-iconPassed, #3fb950); border-color: currentColor; }
    .badge.warn { color: var(--vscode-editorWarning-foreground, #d29922); border-color: currentColor; }
    .act { margin-left: auto; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 10px; border-radius: 4px; cursor: pointer; }
    .act:hover { background: var(--vscode-button-hoverBackground); }
    .act.danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-panel-border); }
    .pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .pill { font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); }
    .pill em { opacity: .6; font-style: normal; }
    .pill.active { color: var(--vscode-testing-iconPassed, #3fb950); }
    .pill.inactive { opacity: .55; }
    .chip-x { background: none; border: none; color: var(--vscode-errorForeground); cursor: pointer; padding: 0 0 0 2px; font-size: 12px; line-height: 1; }
    .empty { opacity: .55; font-size: 12px; padding: 4px 0; }
    button.link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="act" data-action="addProfile">+ Add profile</button>
    <button class="link" data-action="refresh">Refresh</button>
  </div>

  <h2>Providers</h2>
  ${presetSection}

  <h2>Wallets (auth profiles)</h2>
  ${walletSection}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      vscode.postMessage({
        type: el.getAttribute('data-action'),
        slug: el.getAttribute('data-slug') || undefined,
        id: el.getAttribute('data-id') || undefined,
        source: el.getAttribute('data-source') || undefined,
        model: el.getAttribute('data-model') || undefined,
      });
    });
  </script>
</body>
</html>`
}
