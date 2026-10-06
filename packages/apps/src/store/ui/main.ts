import "./style.css"
import { render, isAgentappUrl } from "./render.js"
import type { CatalogRow, InstalledRow, StoreSnapshot, UpdateRow, InstallConfirmationRequest } from "./types.js"

function getEl(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`app store: missing #${id}`)
  return el
}

let snapshot: StoreSnapshot = { catalog: [], installed: [], updates: [] }

function setStatus(msg: string): void {
  getEl("statusbar").textContent = msg
}

/**
 * The two-step install confirmation handshake (app-tools.ts
 * `appInstallConfirmation`): the FIRST app_install call (no `confirm`)
 * must come back a preview — the real install only happens on the SECOND
 * call, which re-sends the same payload plus `confirm: <the preview's
 * token>`. The preview's runsBuildCommand tell is what the user actually
 * sees in the dialog: a `.agentapp` never runs ui.build (app-tools.ts), a
 * git source does only for a `{dir}`-style local install, so a remote git
 * install with `allowBuild` unset answers false — the dialog shows the
 * sha it will pin instead.
 */
function sendInstall(payload: Record<string, unknown>): Promise<InstallConfirmationRequest | { appId: string }> {
  return callTool<Record<string, unknown>, InstallConfirmationRequest | { appId: string }>(
    "app_install",
    payload,
  )
}

function runInstallConfirm(
  payload: Record<string, unknown>,
  ask: (preview: InstallConfirmationRequest) => boolean,
): void {
  sendInstall(payload)
    .then(result => {
      if ("needsConfirmation" in result && result.needsConfirmation === true) {
        if (!ask(result)) return
        callTool<Record<string, unknown>, { appId: string }>("app_install", {
          ...payload,
          confirm: result.confirm,
        })
          .then(() => {
            setStatus(`Installed ${String(payload.url)}`)
            return refresh()
          })
          .catch((e: Error) => setStatus(`Install failed: ${e.message}`))
      } else {
        setStatus(`Installed ${(result as { appId: string }).appId}`)
        return refresh()
      }
    })
    .catch((e: Error) => setStatus(`Install failed: ${e.message}`))
}

function buildInstallPayload(entry: CatalogRow): Record<string, unknown> | undefined {
  const source = entry.source
  if (!source || typeof source !== "object") return undefined
  const s = source as {
    kind: string
    url?: string
    sha256?: string
    sha?: string
    ref?: string
    subdir?: string
  }
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

function describePreview(preview: InstallConfirmationRequest): string {
  const sha =
    preview.kind === "agentapp"
      ? preview.sha256
        ? `sha256 ${preview.sha256}`
        : "no pinned digest"
      : preview.sha
        ? `commit ${preview.sha}`
        : "no pinned commit"
  const buildLine = preview.runsBuildCommand
    ? "It WILL run the app's ui.build command."
    : "It will not run any build command."
  return (
    `Install ${preview.url}? (${preview.kind}; ${sha})\n\n${buildLine}\n\nConfirm to proceed.`
  )
}

function armInstall(entry: CatalogRow): void {
  const payload = buildInstallPayload(entry)
  if (!payload) {
    setStatus("Catalog entry has no remote source — cannot install.")
    return
  }
  runInstallConfirm(payload, preview => window.confirm(describePreview(preview)))
}

/**
 * Install-from-URL: the caller (URL bar field) supplies url (+ optional
 * git ref/subdir); the preview's sha fields come back from the daemon's
 * own guard — a `.agentapp` whose sha256 the user typed is pinned here,
 * but when the field is left blank the daemon answers a preview WITHOUT a
 * pin, which the dialog then says in words.
 */
function installFromUrl(url: string, sha256?: string, ref?: string, subdir?: string): void {
  const payload: Record<string, unknown> = { url }
  if (isAgentappUrl(url)) {
    if (sha256) payload.sha256 = sha256
  } else {
    if (ref) payload.ref = ref
    if (subdir) payload.subdir = subdir
    payload.allowBuild = false
  }
  runInstallConfirm(payload, preview => window.confirm(describePreview(preview)))
}

function resync(appId: string): void {
  callTool<{ appId: string }, { changed: boolean }>("app_resync", { appId })
    .then(result => {
      setStatus(result.changed ? `${appId} updated` : `${appId} already up to date`)
      return refresh()
    })
    .catch((e: Error) => setStatus(`Update failed: ${e.message}`))
}

function uninstall(appId: string): void {
  if (!window.confirm(`Uninstall ${appId}? Its data directory is kept.`)) return
  callTool<{ appId: string }, { appId: string }>("app_uninstall", { appId })
    .then(() => {
      setStatus(`Uninstalled ${appId}`)
      return refresh()
    })
    .catch((e: Error) => setStatus(`Uninstall failed: ${e.message}`))
}

function openUi(appId: string): void {
  // The standalone tab (GET /apps/:appId/ui) is the address appStandaloneUrl
  // (packages/vscode) emits — appId per path segment, `@` kept literal so
  // the url in the location bar stays readable.
  const encoded = appId
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/%40/g, "@")
  window.open(`/apps/${encoded}/ui`, "_blank", "noopener")
}

/** The ?install=<appId> deep link: once the catalog rows are in, scroll to
 *  the entry and open its confirmation (S7 empty states send the user
 *  straight here). Uninstalled-only — an installed app's confirm dialog is
 *  inert and confusing. */
/** One-shot: the ?install=<appId> deep link must open THE entry's
 *  confirmation exactly once — refresh() runs on every update, and a
 *  re-firing deep link would loop install→refresh→install forever. */
let deepLinked = false

function deepLinkInstall(): void {
  if (deepLinked) return
  const target = new URLSearchParams(window.location.search).get("install")
  if (!target) return
  deepLinked = true
  const entry = snapshot.catalog.find(c => c.appId === target && !c.installed)
  if (!entry) return
  // jsdom (the render smoke tests) has no scrollIntoView — the scroll is a
  // nicety, the confirmation dialog is the requirement.
  const el = document.getElementById(`store-entry-${CSS.escape(target)}`)
  if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" })
  armInstall(entry)
}

function refresh(): Promise<void> {
  return callTool<Record<string, never>, unknown>("app_catalog", {})
    .then(catalogRaw => {
      // app_catalog replies a bare array of entries; a failing catalog
      // source rides in a second content block, which callTool's first-text
      // unwrap hides, so the empty-catalog JSON path is the one place the
      // panel still reads its own status bar. (The daemon's builtin
      // `agentproto_store` tool replies the structured snapshot instead;
      // embedded `rows` there is the same shape.)
      const snapshotRaw = (catalogRaw as { catalog?: unknown[]; installed?: unknown[]; updates?: unknown[] }) ?? {}
      const rows: unknown[] = Array.isArray(snapshotRaw.catalog) ? snapshotRaw.catalog : (Array.isArray(catalogRaw) ? (catalogRaw as unknown[]) : [])
      snapshot.catalog = (rows as CatalogRow[]).filter(r => r && r.appId)
      return callTool<Record<string, never>, unknown>("app_list", {})
    })
    .then(appsRaw => {
      const snapshotRaw = (appsRaw as { installed?: unknown[] }) ?? {}
      const rows: unknown[] = Array.isArray(snapshotRaw.installed) ? snapshotRaw.installed : (Array.isArray(appsRaw) ? (appsRaw as unknown[]) : [])
      snapshot.installed = (rows as InstalledRow[]).filter(a => a && a.appId)
      return callTool<Record<string, never>, unknown>("app_updates", {})
    })
    .then(updatesRaw => {
      const sr = (updatesRaw as { updates?: unknown[] }) ?? {}
      const rows: unknown[] = Array.isArray(sr.updates) ? sr.updates : (Array.isArray(updatesRaw) ? (updatesRaw as unknown[]) : [])
      snapshot.updates = (rows as UpdateRow[]).filter(u => u && u.appId)
      renderBody()
      deepLinkInstall()
    })
    .catch((e: Error) => setStatus(`Error: ${e.message}`))
}

function renderBody(): void {
  const content = getEl("content")
  content.innerHTML = render(snapshot)
}

function boot(): void {
  const content = getEl("content")
  // The Install-from-URL form is STATIC html (see index.html), so it's
  // wired once here regardless of what render() drew into #content — the
  // empty state points at it without owning it.
  const urlBtn = document.getElementById("store-install-from-url-btn")
  const urlInput = document.getElementById("store-url") as HTMLInputElement | null
  const shaInput = document.getElementById("store-sha256") as HTMLInputElement | null
  const refInput = document.getElementById("store-ref") as HTMLInputElement | null
  const subdirInput = document.getElementById("store-subdir") as HTMLInputElement | null
  if (urlBtn && urlInput) {
    urlBtn.addEventListener("click", () => {
      const url = urlInput.value.trim()
      if (url === "") return
      installFromUrl(
        url,
        shaInput && shaInput.value.trim() !== "" ? shaInput.value.trim() : undefined,
        refInput && refInput.value.trim() !== "" ? refInput.value.trim() : undefined,
        subdirInput && subdirInput.value.trim() !== "" ? subdirInput.value.trim() : undefined,
      )
    })
  }

  content.addEventListener("click", evt => {
    if (!(evt.target instanceof Element)) return
    const btn = evt.target.closest("button[data-decision]")
    if (!(btn instanceof HTMLButtonElement)) return
    const appId = btn.getAttribute("data-appid")
    if (!appId) return
    const decision = btn.getAttribute("data-decision")
    if (decision === "install") {
      const entry = snapshot.catalog.find(c => c.appId === appId)
      if (entry) armInstall(entry)
    } else if (decision === "resync") {
      resync(appId)
    } else if (decision === "uninstall") {
      uninstall(appId)
    } else if (decision === "open") {
      openUi(appId)
    }
  })

  void initBridge()
    .then(() => refresh())
    .catch((e: Error) => setStatus(`Bridge error: ${e.message}`))
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot)
} else {
  boot()
}
