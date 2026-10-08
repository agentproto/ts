import "./style.css"
import {
  buildInstallPayload,
  isAgentappUrl,
  isBuiltin,
  parseView,
  render,
  renderCategoryChips,
  renderDetail,
} from "./render.js"
import type { CatalogRow, InstalledRow, StoreSnapshot, UpdateRow, InstallConfirmationRequest, ViewState } from "./types.js"

function getEl(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`app store: missing #${id}`)
  return el
}

let snapshot: StoreSnapshot = { catalog: [], installed: [], updates: [] }

/** ?app= / ?q= / ?cat= — the URL is the source of truth at boot and on
 *  popstate; in between, navigate() updates this and mirrors it to the URL
 *  best-effort (a sandboxed host iframe may refuse history writes, in which
 *  case in-panel navigation still works, just without browser back). */
let view: ViewState = parseView(window.location.search)

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
  const path = `/apps/${encoded}/ui`
  try {
    window.open(path, "_blank", "noopener")
  } catch (e) {
    setStatus(`Cannot open a tab from this host — visit ${path} on the daemon.`)
  }
}

function urlFor(v: ViewState): string {
  const params = new URLSearchParams(window.location.search)
  const set = (key: string, value: string): void => {
    if (value === "") params.delete(key)
    else params.set(key, value)
  }
  set("app", v.app)
  set("q", v.q)
  set("cat", v.cat)
  const search = params.toString()
  return window.location.pathname + (search === "" ? "" : "?" + search)
}

function navigate(next: ViewState, mode: "push" | "replace"): void {
  const appChanged = next.app !== view.app
  view = next
  try {
    if (mode === "push") window.history.pushState(null, "", urlFor(next))
    else window.history.replaceState(null, "", urlFor(next))
  } catch (e) {
    // history is restricted in this host — the in-memory view still drives the panel
  }
  renderBody()
  if (appChanged) getEl("content").scrollTop = 0
}

function copyText(id: string): void {
  const pre = document.getElementById(id)
  if (!pre) return
  const value = pre.textContent || ""
  const selectFallback = (): void => {
    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(pre)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    let copied = false
    try {
      copied = typeof document.execCommand === "function" && document.execCommand("copy")
    } catch (e) {
      copied = false
    }
    setStatus(copied ? "Copied" : "Selected — press Ctrl/Cmd+C to copy")
  }
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(value).then(() => setStatus("Copied"), selectFallback)
  } else {
    selectFallback()
  }
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
      setStatus(summarize(snapshot))
      deepLinkInstall()
    })
    .catch((e: Error) => setStatus(`Error: ${e.message}`))
}

function summarize(snap: StoreSnapshot): string {
  const available = snap.catalog.filter(r => !r.installed && !isBuiltin(r)).length
  const builtin = snap.catalog.filter(isBuiltin).length
  const warnings = snap.warnings?.length ?? 0
  return (
    `${snap.installed.length} installed · ${available} available · ${builtin} builtin` +
    (warnings > 0 ? ` · ${warnings} warning${warnings === 1 ? "" : "s"}` : "")
  )
}

function renderBody(): void {
  const detail = view.app !== ""
  getEl("store-filter").hidden = detail
  getEl("url-install-static").hidden = detail
  if (!detail) {
    const search = getEl("store-search") as HTMLInputElement
    if (search.value !== view.q) search.value = view.q
    getEl("store-cats").innerHTML = renderCategoryChips(snapshot, view)
  }
  getEl("content").innerHTML = detail ? renderDetail(snapshot, view) : render(snapshot, view)
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

  const search = document.getElementById("store-search") as HTMLInputElement | null
  if (search) {
    search.addEventListener("input", () => navigate({ ...view, q: search.value }, "replace"))
  }
  getEl("store-cats").addEventListener("click", evt => {
    if (!(evt.target instanceof Element)) return
    const chip = evt.target.closest("button[data-cat]")
    if (chip) navigate({ ...view, cat: chip.getAttribute("data-cat") || "" }, "replace")
  })

  content.addEventListener("click", evt => {
    if (!(evt.target instanceof Element)) return
    const mouse = evt as MouseEvent
    const link = evt.target.closest("a[data-open-app], a[data-nav]")
    if (link && !(mouse.ctrlKey || mouse.metaKey || mouse.shiftKey || mouse.button > 0)) {
      evt.preventDefault()
      const openApp = link.getAttribute("data-open-app")
      navigate({ ...view, app: openApp || "" }, "push")
      return
    }
    const btn = evt.target.closest("button[data-decision]")
    if (!(btn instanceof HTMLButtonElement)) return
    const decision = btn.getAttribute("data-decision")
    if (decision === "copy") {
      const copyId = btn.getAttribute("data-copy-id")
      if (copyId) copyText(copyId)
      return
    }
    const appId = btn.getAttribute("data-appid")
    if (!appId) return
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

  // A catalog icon the host's CSP (img-src) or the network refuses falls
  // back to the same initial-letter tile a missing icon gets. `error` does
  // not bubble, hence the capture phase.
  document.addEventListener(
    "error",
    evt => {
      const img = evt.target
      if (!(img instanceof HTMLImageElement)) return
      const tile = img.closest(".store-icon")
      if (!tile) return
      tile.classList.add("store-icon-fallback")
      tile.textContent = tile.getAttribute("data-initial") || "?"
    },
    true,
  )

  window.addEventListener("popstate", () => {
    view = parseView(window.location.search)
    renderBody()
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
