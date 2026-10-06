/**
 * Pure render helpers for the store panel — ES5 string builders (no runtime
 * deps) so jsdom can execute the bundle and its tests can assert on the
 * exact emitted markup without a shadow DOM.
 */
import type { CatalogRow, InstalledRow, StoreSnapshot, UpdateRow } from "./types.js"

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function text(value: string | undefined, fallback: string): string {
  return value && value.trim() !== "" ? esc(value) : esc(fallback)
}

/** A tier/placement/requires chip, never rendered for an empty field. */
export function chips(row: CatalogRow): string {
  const parts: string[] = []
  if (row.tier) parts.push(`<span class="chip">${esc(row.tier)}</span>`)
  if (row.placement) parts.push(`<span class="chip">placement: ${esc(row.placement)}</span>`)
  if (row.requires?.agentprotoVersion) {
    parts.push(`<span class="chip">requires ${esc(row.requires.agentprotoVersion)}</span>`)
  }
  if (row.requires?.apps && row.requires.apps.length > 0) {
    parts.push(`<span class="chip">requires apps: ${esc(row.requires.apps.join(", "))}</span>`)
  }
  if (row.requires?.agents && row.requires.agents.length > 0) {
    parts.push(`<span class="chip">requires agents: ${esc(row.requires.agents.join(", "))}</span>`)
  }
  return parts.join("")
}

export function installButton(catalogRow: CatalogRow): string {
  return `<button class="sbtn store-install-btn" data-appid="${esc(catalogRow.appId)}" data-decision="install">Install</button>`
}

export function renderCatalogFeatured(rows: readonly CatalogRow[]): string {
  const featured = rows.filter(r => r.featured === true)
  if (featured.length === 0) return ""
  return featured
    .map(
      r => `<div class="card store-card-featured" id="store-entry-${esc(r.appId)}">
      <div class="card-title">${text(r.name, r.appId)}</div>
      <div class="card-desc">${text(r.description, "")}</div>
      <div class="card-chips">${chips(r)}</div>
      <div class="card-actions">${installButton(r)}</div>
    </div>`,
    )
    .join("")
}

export function renderCatalogAvailable(rows: readonly CatalogRow[]): string {
  const byCategory = new Map<string, CatalogRow[]>()
  for (const r of rows) {
    if (r.installed) continue
    if (r.featured === true) continue
    const key = r.category && r.category !== "" ? r.category : "Other"
    const list = byCategory.get(key)
    if (list) list.push(r)
    else byCategory.set(key, [r])
  }
  let out = ""
  for (const [category, list] of byCategory) {
    out = out + `<h3 class="store-category-title">${esc(category)}</h3>`
    for (const r of list) {
      out = out + `<div class="card store-card-available" id="store-entry-${esc(r.appId)}">
      <div class="card-title">${text(r.name, r.appId)}</div>
      <div class="card-desc">${text(r.description, "")}</div>
      <div class="card-chips">${chips(r)}</div>
      <div class="card-actions">${installButton(r)}</div>
    </div>`
    }
  }
  return out
}

export function renderInstalled(installed: readonly InstalledRow[], catalogRows: readonly CatalogRow[], updates: readonly UpdateRow[]): string {
  const updateIds = new Set(updates.map(u => u.appId))
  const byId = new Map(catalogRows.map(c => [c.appId, c]))
  if (installed.length === 0) return ""
  return installed
    .map(app => {
      const version = app.version ?? byId.get(app.appId)?.version ?? ""
      const source = app.source?.kind ?? "local"
      const hasUi = byId.get(app.appId)?.hasUi === true || (app.source?.kind === "local" && app.dir !== undefined)
      const actions = [
        `<button class="sbtn store-resync-btn" data-appid="${esc(app.appId)}" data-decision="resync">Update</button>`,
        `<button class="sbtn store-uninstall-btn" data-appid="${esc(app.appId)}" data-decision="uninstall">Uninstall</button>`,
        ...(hasUi
          ? [
              `<button class="sbtn store-open-btn" data-appid="${esc(app.appId)}" data-decision="open">Open</button>`,
            ]
          : []),
      ]
      return `<div class="card store-card-installed" id="store-entry-${esc(app.appId)}">
      <div class="card-title">${text(app.name, app.appId)}</div>
      <div class="card-actions-meta"><span class="card-version">${text(version, "")}</span><span class="card-source">${esc(source)}</span>${updateIds.has(app.appId) ? `<span class="badge store-update-badge">Update available</span>` : ""}</div>
      <div class="card-actions">${actions.join("")}</div>
    </div>`
    })
    .join("")
}

export function renderSourcesHeader(snapshot: { warnings?: string[] }): string {
  if (!snapshot.warnings || snapshot.warnings.length === 0) return ""
  return `<div class="store-warnings">${snapshot.warnings.map(w => `<p class="store-warning">${esc(w)}</p>`).join("")}</div>`
}

export function renderBuiltins(builtinNames: readonly string[]): string {
  if (builtinNames.length === 0) return ""
  const details = `<details class="store-builtins"><summary>Builtin panels</summary><ul class="store-builtin-list">${builtinNames
    .map(n => `<li class="store-builtin-item">${esc(n)}</li>`)
    .join("")}</ul></details>`
  return details
}

export function isAgentappUrl(url: string): boolean {
  return url.replace(/\?.*$/, "").replace(/#.*$/, "").toLowerCase().endsWith(".agentapp")
}

export function storeEmpty(catalogRows: readonly CatalogRow[], installed: readonly InstalledRow[]): string {
  if (catalogRows.length > 0 || installed.length > 0) return ""
  return `<div class="store-empty">
    <p class="store-empty-title">No apps installed, and the app catalog is empty.</p>
    <p class="store-empty-hint">Add a <code>catalog.sources</code> entry to your daemon config, drop an <code>app-catalog.json</code> next to it, or install an app directly from a URL in the form below.</p>
  </div>`
}

export function render(snapshot: StoreSnapshot): string {
  const installed = renderInstalled(snapshot.installed, snapshot.catalog, snapshot.updates)
  const featured = renderCatalogFeatured(snapshot.catalog)
  const available = renderCatalogAvailable(snapshot.catalog)
  const builtins = renderBuiltins(["sessions-panel", "agents-overview", "bureau-sessions", "session-story", "live-session", "work-board"])
  const sections: string[] = []
  sections.push(renderSourcesHeader(snapshot))
  if (installed !== "") {
    sections.push(`<h2 class="store-section-title">Installed</h2>`, `<div class="grill">${installed}</div>`)
  }
  if (featured !== "") {
    sections.push(`<h2 class="store-section-title">Featured</h2>`, featured)
  }
  if (available !== "") {
    sections.push(`<h2 class="store-section-title">Available</h2>`, `<div class="grill">${available}</div>`)
  }
  if (installed === "" && featured === "" && available === "") {
    sections.push(storeEmpty(snapshot.catalog, snapshot.installed))
  }
  sections.push(builtins)
  return sections.join("\n")
}
