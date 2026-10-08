/**
 * Pure render helpers for the store panel — ES5 string builders (no runtime
 * deps) so jsdom can execute the bundle and its tests can assert on the
 * exact emitted markup without a shadow DOM.
 */
import type { AppSourceRow, CatalogRow, InstalledRow, RunRow, StoreSnapshot, UpdateRow, ViewState } from "./types.js"

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

const STORE_APP_ID = "@agentproto/store"

export function isBuiltin(row: CatalogRow): boolean {
  return row.category === "builtin"
}

/* ── view state (URL <-> state) ─────────────────────────────────────── */

export const EMPTY_VIEW: ViewState = { app: "", q: "", cat: "" }

export function parseView(search: string): ViewState {
  const params = new URLSearchParams(search)
  return { app: params.get("app") || "", q: params.get("q") || "", cat: params.get("cat") || "" }
}

/** The query string for a view (`""` when nothing is set). */
export function viewToSearch(view: ViewState): string {
  const parts: string[] = []
  if (view.app !== "") parts.push("app=" + encodeURIComponent(view.app))
  if (view.q !== "") parts.push("q=" + encodeURIComponent(view.q))
  if (view.cat !== "") parts.push("cat=" + encodeURIComponent(view.cat))
  return parts.length > 0 ? "?" + parts.join("&") : ""
}

function viewHref(view: ViewState): string {
  const search = viewToSearch(view)
  return search === "" ? "?" : search
}

/* ── icons ──────────────────────────────────────────────────────────── */

/** http(s) and data:image URLs only — a catalog `icon` is untrusted input
 *  and never reaches an attribute otherwise. */
export function safeIconUrl(icon: string | undefined): string {
  if (!icon) return ""
  const trimmed = icon.trim()
  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) return trimmed
  return ""
}

export function initialOf(row: { name?: string; appId: string }): string {
  const base = (row.name && row.name.trim() !== "" ? row.name : row.appId).replace(/^[^A-Za-z0-9]+/, "")
  return base.charAt(0).toUpperCase() || "?"
}

/** The icon tile. A real <img> when the catalog supplies a usable url; the
 *  initial-letter tile otherwise — and main.ts swaps a failed <img> (host
 *  CSP `img-src`, 404) for the same tile via `data-initial`. */
export function iconHtml(row: { name?: string; appId: string; icon?: string }, size: "sm" | "lg"): string {
  const initial = esc(initialOf(row))
  const url = safeIconUrl(row.icon)
  if (url === "") {
    return `<span class="store-icon store-icon-${size} store-icon-fallback" data-initial="${initial}" aria-hidden="true">${initial}</span>`
  }
  return `<span class="store-icon store-icon-${size}" data-initial="${initial}" aria-hidden="true"><img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`
}

function appLink(appId: string, inner: string, cls: string): string {
  return `<a class="${cls}" href="${esc(viewHref({ ...EMPTY_VIEW, app: appId }))}" data-open-app="${esc(appId)}">${inner}</a>`
}

/* ── filtering ──────────────────────────────────────────────────────── */

export function categoryOf(row: { category?: string }): string {
  return row.category && row.category !== "" ? row.category : "Other"
}

function matchesView(view: ViewState, category: string, haystack: (string | undefined)[]): boolean {
  if (view.cat !== "" && category !== view.cat) return false
  const q = view.q.trim().toLowerCase()
  if (q === "") return true
  for (const part of haystack) {
    if (part && part.toLowerCase().indexOf(q) !== -1) return true
  }
  return false
}

function catalogMatches(view: ViewState, r: CatalogRow): boolean {
  return matchesView(view, categoryOf(r), [r.name, r.appId, r.description, r.publisher])
}

function filterActive(view: ViewState): boolean {
  return view.q.trim() !== "" || view.cat !== ""
}

/** The category chips (All + each distinct category across catalog and
 *  installed rows) for the static `#store-cats` container. */
export function renderCategoryChips(snapshot: StoreSnapshot, view: ViewState): string {
  const seen = new Set<string>()
  for (const r of snapshot.catalog) seen.add(categoryOf(r))
  const known = new Set(snapshot.catalog.map(c => c.appId))
  for (const a of snapshot.installed) if (!known.has(a.appId)) seen.add("Other")
  const cats = Array.from(seen).sort()
  const chip = (value: string, label: string): string =>
    `<button class="store-cat-chip${view.cat === value ? " active" : ""}" data-cat="${esc(value)}" aria-pressed="${view.cat === value ? "true" : "false"}">${esc(label)}</button>`
  return [chip("", "All")].concat(cats.map(c => chip(c, c))).join("")
}

/* ── shelves ────────────────────────────────────────────────────────── */

function remoteCard(r: CatalogRow, cls: string): string {
  return `<div class="card ${cls}" id="store-entry-${esc(r.appId)}">
      <div class="card-head">${appLink(r.appId, iconHtml(r, "sm"), "store-icon-link")}<div class="card-body">
      <div class="card-title">${appLink(r.appId, text(r.name, r.appId), "store-app-link")}</div>
      <div class="card-desc">${text(r.description, "")}</div>
      <div class="card-chips">${chips(r)}</div>
      <div class="card-actions">${installButton(r)}</div>
      </div></div>
    </div>`
}

export function renderCatalogFeatured(rows: readonly CatalogRow[], view: ViewState = EMPTY_VIEW): string {
  const featured = rows.filter(r => r.featured === true && !isBuiltin(r) && catalogMatches(view, r))
  if (featured.length === 0) return ""
  return featured.map(r => remoteCard(r, "store-card-featured")).join("")
}

export function renderCatalogAvailable(rows: readonly CatalogRow[], view: ViewState = EMPTY_VIEW): string {
  const byCategory = new Map<string, CatalogRow[]>()
  for (const r of rows) {
    if (r.installed) continue
    if (r.featured === true) continue
    if (isBuiltin(r)) continue
    if (!catalogMatches(view, r)) continue
    const key = categoryOf(r)
    const list = byCategory.get(key)
    if (list) list.push(r)
    else byCategory.set(key, [r])
  }
  let out = ""
  for (const [category, list] of byCategory) {
    out = out + `<h3 class="store-category-title">${esc(category)}</h3>`
    for (const r of list) out = out + remoteCard(r, "store-card-available")
  }
  return out
}

function installedHasUi(app: InstalledRow, byId: Map<string, CatalogRow>): boolean {
  return byId.get(app.appId)?.hasUi === true || (app.source?.kind === "local" && app.dir !== undefined)
}

export function renderInstalled(
  installed: readonly InstalledRow[],
  catalogRows: readonly CatalogRow[],
  updates: readonly UpdateRow[],
  view: ViewState = EMPTY_VIEW,
): string {
  const updateIds = new Set(updates.map(u => u.appId))
  const byId = new Map(catalogRows.map(c => [c.appId, c]))
  if (installed.length === 0) return ""
  return installed
    .filter(app => {
      const c = byId.get(app.appId)
      return matchesView(view, categoryOf(c ?? {}), [app.name, c?.name, app.appId, app.description, c?.description, c?.publisher])
    })
    .map(app => {
      const c = byId.get(app.appId)
      const version = app.version ?? c?.version ?? ""
      const source = app.source?.kind ?? "local"
      const hasUi = installedHasUi(app, byId)
      const actions = [
        `<button class="sbtn store-resync-btn" data-appid="${esc(app.appId)}" data-decision="resync">Update</button>`,
        `<button class="sbtn store-uninstall-btn" data-appid="${esc(app.appId)}" data-decision="uninstall">Uninstall</button>`,
        ...(hasUi
          ? [
              `<button class="sbtn store-open-btn" data-appid="${esc(app.appId)}" data-decision="open">Open</button>`,
            ]
          : []),
      ]
      const iconRow = { name: app.name ?? c?.name, appId: app.appId, icon: c?.icon }
      return `<div class="card store-card-installed" id="store-entry-${esc(app.appId)}">
      <div class="card-head">${appLink(app.appId, iconHtml(iconRow, "sm"), "store-icon-link")}<div class="card-body">
      <div class="card-title">${appLink(app.appId, text(app.name, app.appId), "store-app-link")}</div>
      <div class="card-actions-meta"><span class="card-version">${text(version, "")}</span><span class="card-source">${esc(source)}</span>${updateIds.has(app.appId) ? `<span class="badge store-update-badge">Update available</span>` : ""}</div>
      <div class="card-actions">${actions.join("")}</div>
      </div></div>
    </div>`
    })
    .join("")
}

export function renderSourcesHeader(snapshot: { warnings?: string[] }): string {
  if (!snapshot.warnings || snapshot.warnings.length === 0) return ""
  return `<div class="store-warnings">${snapshot.warnings.map(w => `<p class="store-warning">${esc(w)}</p>`).join("")}</div>`
}

/** Builtin panels from the catalog's `category === "builtin"` rows, each
 *  with an Open button (the store itself is the current page, so it's left
 *  out). Open by default — the list is the only way to reach them. */
export function renderBuiltins(rows: readonly CatalogRow[], view: ViewState = EMPTY_VIEW): string {
  const builtins = rows.filter(r => isBuiltin(r) && r.appId !== STORE_APP_ID && catalogMatches(view, r))
  if (builtins.length === 0) return ""
  const items = builtins
    .map(
      r => `<li class="store-builtin-item" id="store-entry-${esc(r.appId)}">${appLink(r.appId, iconHtml(r, "sm"), "store-icon-link")}<span class="store-builtin-name">${appLink(r.appId, text(r.name, r.appId), "store-app-link")}</span> <span class="store-builtin-desc">${text(r.description, "")}</span> <button class="sbtn store-open-btn" data-appid="${esc(r.appId)}" data-decision="open">Open</button></li>`,
    )
    .join("")
  return `<details class="store-builtins" open><summary>Builtin panels</summary><ul class="store-builtin-list">${items}</ul></details>`
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

export function renderNoResults(view: ViewState): string {
  const what = view.q.trim() !== "" ? `“${esc(view.q.trim())}”` : "this filter"
  const cat = view.cat !== "" ? ` in <strong>${esc(view.cat)}</strong>` : ""
  return `<div class="store-no-results"><p class="store-empty-title">No apps match ${what}${cat}.</p><p class="store-empty-hint">Clear the search or pick another category.</p></div>`
}

export function render(snapshot: StoreSnapshot, view: ViewState = EMPTY_VIEW): string {
  const installed = renderInstalled(snapshot.installed, snapshot.catalog, snapshot.updates, view)
  const featured = renderCatalogFeatured(snapshot.catalog, view)
  const available = renderCatalogAvailable(snapshot.catalog, view)
  const builtins = renderBuiltins(snapshot.catalog, view)
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
    if (filterActive(view) && (snapshot.installed.length > 0 || snapshot.catalog.some(r => !isBuiltin(r)))) {
      sections.push(renderNoResults(view))
    } else if (!filterActive(view) || builtins === "") {
      sections.push(storeEmpty(snapshot.catalog.filter(r => !isBuiltin(r)), snapshot.installed))
    }
  }
  sections.push(builtins)
  return sections.join("\n")
}

/* ── install payload + copyable commands ───────────────────────────── */

/** The exact `app_install` arguments (minus `confirm`) a catalog entry's
 *  Install button sends. */
export function buildInstallPayload(entry: CatalogRow): Record<string, unknown> | undefined {
  const s = entry.source
  if (!s || typeof s !== "object") return undefined
  const payload: Record<string, unknown> = { url: s.url }
  if (s.kind === "agentapp") {
    payload.sha256 = s.sha256
  } else {
    if (s.ref) payload.ref = s.ref
    if (s.subdir) payload.subdir = s.subdir
    if (s.sha) payload.sha = s.sha
    payload.allowBuild = false
  }
  if (entry.catalogUrl) payload.catalogUrl = entry.catalogUrl
  return payload
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(value)) return value
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/** `agentproto app install <url> [--sha256 …|--ref … --subdir … --sha …]`
 *  (flags per packages/cli/src/commands/app.ts: --sha256 is `.agentapp`
 *  only, --ref/--subdir/--sha are git only). */
export function cliInstallCommand(source: AppSourceRow | undefined): string {
  if (!source || !source.url) return ""
  let cmd = "agentproto app install " + shellQuote(source.url)
  if (source.kind === "agentapp") {
    if (source.sha256) cmd += " --sha256 " + shellQuote(source.sha256)
  } else {
    if (source.ref) cmd += " --ref " + shellQuote(source.ref)
    if (source.subdir) cmd += " --subdir " + shellQuote(source.subdir)
    if (source.sha) cmd += " --sha " + shellQuote(source.sha)
  }
  return cmd
}

function isRemoteSource(source: AppSourceRow | undefined): boolean {
  return !!source && (source.kind === "git" || source.kind === "agentapp")
}

export interface CopyItem {
  label: string
  text: string
}

function mcpCall(tool: string, args: Record<string, unknown>): string {
  return JSON.stringify({ name: tool, arguments: args }, null, 2)
}

export function copyItems(entry: CatalogRow | undefined, inst: InstalledRow | undefined, appId: string): CopyItem[] {
  const items: CopyItem[] = []
  if (entry && isBuiltin(entry)) {
    if (entry.toolId) items.push({ label: "MCP tool id", text: entry.toolId })
    if (entry.resourceUri) items.push({ label: "MCP resource URI", text: entry.resourceUri })
    return items
  }
  if (!inst && entry && entry.source) {
    items.push({ label: "CLI — install from catalog", text: "agentproto app install " + shellQuote(appId) })
    const explicit = cliInstallCommand(entry.source)
    if (explicit !== "") items.push({ label: "CLI — install from pinned source", text: explicit })
    const payload = buildInstallPayload(entry)
    if (payload) items.push({ label: "MCP — app_install", text: mcpCall("app_install", payload) })
  }
  if (inst) {
    if (isRemoteSource(inst.source)) {
      items.push({ label: "CLI — resync", text: "agentproto app resync " + shellQuote(appId) })
      items.push({ label: "MCP — app_resync", text: mcpCall("app_resync", { appId }) })
    }
    items.push({ label: "CLI — uninstall", text: "agentproto app uninstall " + shellQuote(appId) })
    items.push({ label: "MCP — app_uninstall", text: mcpCall("app_uninstall", { appId }) })
  }
  return items
}

export function renderCopyBlock(items: readonly CopyItem[]): string {
  if (items.length === 0) return ""
  const rows = items
    .map(
      (it, i) => `<div class="store-copy-item"><div class="store-copy-head"><span class="store-copy-label">${esc(it.label)}</span><button class="sbtn store-copy-btn" data-decision="copy" data-copy-id="store-copy-${i}">Copy</button></div><pre class="store-copy-text mono" id="store-copy-${i}">${esc(it.text)}</pre></div>`,
    )
    .join("")
  return `<h3 class="store-detail-section">Copy</h3><div class="store-copy">${rows}</div>`
}

/* ── detail view ────────────────────────────────────────────────────── */

export function formatBytes(n: number | undefined): string {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return ""
  if (n < 1024) return n + " B"
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB"
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB"
  return (n / 1024 / 1024 / 1024).toFixed(1) + " GB"
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "—"
  const ms = Date.parse(iso)
  if (isNaN(ms)) return iso
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z"
}

export function formatDuration(startedAt: string | undefined, endedAt: string | undefined): string {
  if (!startedAt || !endedAt) return "—"
  const ms = Date.parse(endedAt) - Date.parse(startedAt)
  if (isNaN(ms) || ms < 0) return "—"
  const total = Math.floor(ms / 1000)
  if (total < 60) return total + "s"
  const mins = Math.floor(total / 60)
  if (mins < 60) return mins + "m " + (total % 60) + "s"
  return Math.floor(mins / 60) + "h " + (mins % 60) + "m"
}

function dlRow(label: string, valueHtml: string): string {
  return valueHtml === "" ? "" : `<dt>${esc(label)}</dt><dd>${valueHtml}</dd>`
}

function mono(value: string | undefined): string {
  return value && value !== "" ? `<span class="mono">${esc(value)}</span>` : ""
}

function sourceRows(source: AppSourceRow | undefined): string {
  if (!source) return ""
  return (
    dlRow("Kind", esc(source.kind)) +
    dlRow("URL", mono(source.url)) +
    dlRow("sha256", mono(source.sha256)) +
    dlRow("Commit (sha)", mono(source.sha)) +
    dlRow("Ref", mono(source.ref)) +
    dlRow("Subdir", mono(source.subdir)) +
    dlRow("Source version", mono(source.version)) +
    dlRow("Size", esc(formatBytes(source.size)))
  )
}

function idList(ids: readonly string[] | undefined): string {
  if (!ids || ids.length === 0) return ""
  return `<ul class="store-detail-list">${ids.map(id => `<li class="mono">${esc(id)}</li>`).join("")}</ul>`
}

function renderRuns(runs: readonly RunRow[] | undefined): string {
  if (!runs || runs.length === 0) return ""
  const sorted = runs.slice().sort((a, b) => ((b.startedAt || "") < (a.startedAt || "") ? -1 : (b.startedAt || "") > (a.startedAt || "") ? 1 : 0))
  const shown = sorted.slice(0, 10)
  const rows = shown
    .map(r => {
      const where = [r.harness || r.adapter, r.model].filter(x => !!x).join(" / ")
      return `<tr><td>${text(r.status, "—")}</td><td>${esc(formatTime(r.startedAt))}</td><td>${esc(formatDuration(r.startedAt, r.endedAt))}</td><td>${text(where, "—")}</td></tr>`
    })
    .join("")
  const more = runs.length > shown.length ? ` <span class="store-detail-more">(last ${shown.length} of ${runs.length})</span>` : ""
  return `<h3 class="store-detail-section">Recent runs${more}</h3><table class="store-runs"><thead><tr><th>Status</th><th>Started</th><th>Duration</th><th>Harness / model</th></tr></thead><tbody>${rows}</tbody></table>`
}

function uniq(values: readonly string[]): string[] {
  const out: string[] = []
  for (const v of values) if (out.indexOf(v) === -1) out.push(v)
  return out
}

export function renderDetail(snapshot: StoreSnapshot, view: ViewState): string {
  const appId = view.app
  const back = `<a class="store-back" href="${esc(viewHref({ ...view, app: "" }))}" data-nav="back">← Back to store</a>`
  const entry = snapshot.catalog.find(c => c.appId === appId)
  const inst = snapshot.installed.find(a => a.appId === appId)
  if (!entry && !inst) {
    return `<div class="store-detail">${back}<div class="store-no-results"><p class="store-empty-title">No app “${esc(appId)}” in the catalog or installed.</p></div></div>`
  }
  const builtin = !!entry && isBuiltin(entry)
  const update = snapshot.updates.some(u => u.appId === appId) || entry?.updateAvailable === true
  const name = (inst?.name ?? entry?.name) || appId
  const description = (entry?.description ?? inst?.description) || ""
  const version = inst?.version ?? entry?.installedVersion ?? entry?.version
  const installed = !builtin && (!!inst || entry?.installed === true)
  const hasUi = builtin ? appId !== STORE_APP_ID : entry?.hasUi === true || (!!inst && installedHasUi(inst, new Map(snapshot.catalog.map(c => [c.appId, c]))))
  const catalogVersionLine =
    update && entry?.version && entry.version !== version ? `${esc(version || "")} → ${esc(entry.version)} available` : esc(version || "")

  const badges: string[] = []
  if (version) badges.push(`<span class="chip">v${esc(version)}</span>`)
  if (update) badges.push(`<span class="badge store-update-badge">Update available</span>`)
  if (builtin) badges.push(`<span class="chip">builtin</span>`)
  else if (installed) badges.push(`<span class="chip">installed</span>`)
  if (entry?.stale) badges.push(`<span class="badge store-stale-badge">stale catalog</span>`)
  if (entry) badges.push(chips(entry))

  const actions: string[] = []
  const idAttr = `data-appid="${esc(appId)}"`
  if (!installed && !builtin && entry && entry.source) {
    actions.push(`<button class="sbtn primary store-install-btn" ${idAttr} data-decision="install">Install</button>`)
  }
  if (installed && (isRemoteSource(inst?.source) || update)) {
    actions.push(`<button class="sbtn store-resync-btn" ${idAttr} data-decision="resync">Update</button>`)
  }
  if (installed) {
    actions.push(`<button class="sbtn danger store-uninstall-btn" ${idAttr} data-decision="uninstall">Uninstall</button>`)
  }
  if (hasUi && (installed || builtin)) {
    actions.push(`<button class="sbtn store-open-btn" ${idAttr} data-decision="open">Open</button>`)
  }

  const requiresApps = uniq((entry?.requires?.apps ?? []).concat(inst?.requires ?? []))
  const requires =
    dlRow("agentproto version", esc(entry?.requires?.agentprotoVersion ?? "")) +
    dlRow("Apps", requiresApps.length > 0 ? esc(requiresApps.join(", ")) : "") +
    dlRow("Agents", entry?.requires?.agents && entry.requires.agents.length > 0 ? esc(entry.requires.agents.join(", ")) : "")

  const license = entry?.license ? esc(entry.license.kind ?? "") + (entry.license.url ? ` ${mono(entry.license.url)}` : "") : ""
  const info =
    dlRow("App id", mono(appId)) +
    dlRow("Publisher", esc(entry?.publisher ?? "")) +
    dlRow("Version", catalogVersionLine) +
    dlRow("License", license.trim()) +
    dlRow("Tier", esc(entry?.tier ?? "")) +
    dlRow("Category", esc(entry?.category ?? "")) +
    dlRow("Placement", esc(entry?.placement ?? "")) +
    dlRow("Size", esc(formatBytes(entry?.source?.size ?? inst?.source?.size))) +
    dlRow("Origin", esc(entry?.origin ?? "")) +
    dlRow("Catalog", mono(entry?.catalogUrl) + (entry?.stale ? ` <span class="badge store-stale-badge">stale</span>` : "")) +
    dlRow("Tool id", mono(entry?.toolId)) +
    dlRow("Resource URI", mono(entry?.resourceUri))

  const location =
    inst
      ? dlRow("Install dir", mono(inst.dir)) +
        dlRow("Data dir", mono(inst.dataDir)) +
        (inst.dirMissing ? `<dt>Warning</dt><dd><span class="badge store-dir-missing">dir missing — the install dir no longer exists on disk; reinstall to restore it</span></dd>` : "")
      : ""

  const catalogSource = sourceRows(entry?.source)
  const installedSource = inst?.source && inst.source.kind !== "local" ? sourceRows(inst.source) : ""

  const sections: string[] = []
  sections.push(
    `<div class="store-detail-head">${iconHtml({ name, appId, icon: entry?.icon }, "lg")}<div class="store-detail-title"><h2 class="store-detail-name">${esc(name)}</h2><div class="store-detail-id mono">${esc(appId)}</div><div class="card-chips">${badges.join("")}</div></div></div>`,
  )
  if (actions.length > 0) sections.push(`<div class="card-actions store-detail-actions">${actions.join("")}</div>`)
  if (description !== "") sections.push(`<p class="store-detail-desc">${esc(description)}</p>`)
  sections.push(`<dl class="store-kv">${info}</dl>`)
  if (requires !== "") sections.push(`<h3 class="store-detail-section">Requires</h3><dl class="store-kv">${requires}</dl>`)
  if (catalogSource !== "") sections.push(`<h3 class="store-detail-section">Source${inst ? " (catalog)" : ""}</h3><dl class="store-kv">${catalogSource}</dl>`)
  if (installedSource !== "") sections.push(`<h3 class="store-detail-section">Installed from</h3><dl class="store-kv">${installedSource}</dl>`)
  if (location !== "") sections.push(`<h3 class="store-detail-section">Installation</h3><dl class="store-kv">${location}</dl>`)
  const agents = idList(inst?.agents)
  if (agents !== "") sections.push(`<h3 class="store-detail-section">Agents</h3>${agents}`)
  const workflows = idList(inst?.workflows)
  if (workflows !== "") sections.push(`<h3 class="store-detail-section">Workflows</h3>${workflows}`)
  const runs = renderRuns(inst?.runs)
  if (runs !== "") sections.push(runs)
  sections.push(renderCopyBlock(copyItems(entry, inst, appId)))
  return `<div class="store-detail" data-appid="${esc(appId)}">${back}${sections.join("")}</div>`
}
