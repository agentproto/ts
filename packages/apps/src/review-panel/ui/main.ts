import "./style.css"
import { renderList, renderDetail, liveSessionUrl } from "./render.js"
import type { ReviewLedgerResult, ReviewRow, RunDetail } from "./types.js"

const POLL_RUNNING_MS = 4_000
const POLL_IDLE_MS = 15_000

function getEl(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`review panel: missing #${id}`)
  return el
}

let rows: ReviewRow[] = []
let selectedRunId: string | null = null
let detail: RunDetail | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let loadInFlight = false

/**
 * Everything below reads the `#app` markup, so it only runs once the
 * document has actually finished parsing — same reasoning as work-board's
 * main.ts (Vite emits this as a classic script relocated into `<head>` by
 * vite-plugin-singlefile, ahead of the `<body>` markup it reads).
 */
function boot(): void {
  const listPaneEl = getEl("list-pane")
  const detailPaneEl = getEl("detail-pane")
  const detailBodyEl = getEl("detail-body")
  const statusbarEl = getEl("statusbar")
  const cancelBtn = getEl("cancel-btn") as HTMLButtonElement
  const rerunBtn = getEl("rerun-btn") as HTMLButtonElement
  const prBtn = getEl("pr-btn") as HTMLButtonElement
  const exportBtn = getEl("export-btn") as HTMLButtonElement

  function setStatus(msg: string): void {
    statusbarEl.textContent = msg
  }

  function findRow(runId: string): ReviewRow | undefined {
    return rows.find(r => r.runId === runId)
  }

  function renderListPane(): void {
    listPaneEl.innerHTML = renderList(rows)
    if (!selectedRunId) return
    // Compare `dataset.runid` directly rather than building a CSS attribute
    // selector — no `CSS.escape` dependency (absent in some hosts/jsdom) and
    // no risk of a run id containing a character that breaks the selector.
    listPaneEl.querySelectorAll<HTMLElement>("tr[data-runid]").forEach(tr => {
      if (tr.dataset.runid === selectedRunId) tr.classList.add("selected")
    })
  }

  function renderDetailPane(): void {
    if (!selectedRunId || !detail) {
      detailPaneEl.classList.remove("open")
      return
    }
    detailPaneEl.classList.add("open")
    detailBodyEl.innerHTML = renderDetail(detail)
    const running = detail.status === "running"
    cancelBtn.disabled = !running
    cancelBtn.style.display = running ? "" : "none"
    detailBodyEl.querySelectorAll<HTMLButtonElement>(".sess-link").forEach(btn => {
      btn.addEventListener("click", () => openSession(btn.dataset.sessionId ?? ""))
    })
  }

  /**
   * Opens the live-session panel deep-linked to a reviewer session — same
   * `openLink`-with-`window.open`-fallback convention session-chat's card
   * link uses (panel-bridge.ts's `openLink`), the only existing cross-panel
   * navigation primitive this codebase has, now pointed at a real per-
   * session URL (`liveSessionUrl`, render.ts): runtime's `handleAppUiPage`
   * reads the `?sessionId=` query param and bakes it into the served
   * widget's `window.__APP_INIT__` when it's a validated session id (see
   * builtin-apps.ts's `isValidDeepLinkSessionId`), so the widget boots
   * already pinned instead of self-discovering the newest running session.
   * `window.location.origin` is the daemon's own origin whenever this panel
   * is served standalone (the same route `resolveBuiltinPanelUi` answers)
   * — an opaque iframe origin (some embedded hosts) can't resolve it, in
   * which case the link opens relative to nothing and the host's own error
   * surfaces instead.
   */
  function openSession(sessionId: string): void {
    if (!sessionId) return
    const origin = window.location.origin && window.location.origin !== "null" ? window.location.origin : ""
    const url = liveSessionUrl(origin, sessionId)
    const caps = getHostCapabilities()
    if (caps?.openLinks) {
      openLink(url).catch(() => window.open(url, "_blank"))
    } else {
      window.open(url, "_blank")
    }
  }

  function loadList(): Promise<void> {
    if (loadInFlight) return Promise.resolve()
    loadInFlight = true
    return callTool<{ includeRunning: boolean }, ReviewLedgerResult>("review_ledger", { includeRunning: true })
      .then(result => {
        rows = result.attestations
        renderListPane()
        const runningCount = rows.filter(r => r.status === "running").length
        setStatus(`${result.total} review${result.total === 1 ? "" : "s"} · ${runningCount} running · ${new Date().toLocaleTimeString()}`)
        if (selectedRunId && findRow(selectedRunId)) return loadDetail(selectedRunId)
        return undefined
      })
      .catch((e: Error) => setStatus(`Error: ${e.message}`))
      .finally(() => {
        loadInFlight = false
      })
  }

  function loadDetail(runId: string): Promise<void> {
    return callTool<{ runId: string }, RunDetail>("review_status", { runId })
      .then(result => {
        detail = result
        renderDetailPane()
      })
      .catch((e: Error) => setStatus(`Error loading detail: ${e.message}`))
  }

  function openDetail(runId: string): void {
    selectedRunId = runId
    renderListPane()
    void loadDetail(runId)
  }

  function closeDetail(): void {
    selectedRunId = null
    detail = null
    renderListPane()
    renderDetailPane()
  }

  listPaneEl.addEventListener("click", evt => {
    if (!(evt.target instanceof Element)) return
    const tr = evt.target.closest("tr[data-runid]")
    if (!(tr instanceof HTMLElement)) return
    const runId = tr.dataset.runid
    if (runId) openDetail(runId)
  })
  listPaneEl.addEventListener("keydown", evt => {
    if (evt.key !== "Enter" && evt.key !== " ") return
    if (!(evt.target instanceof Element)) return
    const tr = evt.target.closest("tr[data-runid]")
    if (!(tr instanceof HTMLElement)) return
    evt.preventDefault()
    const runId = tr.dataset.runid
    if (runId) openDetail(runId)
  })

  getEl("detail-close").addEventListener("click", closeDetail)
  getEl("refresh-btn").addEventListener("click", () => {
    void loadList()
  })

  cancelBtn.addEventListener("click", () => {
    if (!selectedRunId) return
    callTool("review_cancel", { runId: selectedRunId })
      .then(() => {
        setStatus("Cancelled.")
        return loadList()
      })
      .catch((e: Error) => setStatus(`Cancel failed: ${e.message}`))
  })

  rerunBtn.addEventListener("click", () => {
    if (!selectedRunId) return
    const row = findRow(selectedRunId)
    const cwd = row?.cwd
    if (!cwd) {
      setStatus("Re-run failed: this row has no known checkout path.")
      return
    }
    callTool("review_run", {
      cwd,
      ...(row?.binding ? { binding: row.binding } : {}),
      nocache: true,
      wait: false,
      supersede: true,
    })
      .then(() => {
        setStatus("Re-run started.")
        return loadList()
      })
      .catch((e: Error) => setStatus(`Re-run failed: ${e.message}`))
  })

  prBtn.addEventListener("click", () => {
    if (!selectedRunId) return
    callTool("review_pr", { runId: selectedRunId })
      .then(() => {
        setStatus("Fetched PR status.")
        return loadList()
      })
      .catch((e: Error) => setStatus(`Fetch PR status failed: ${e.message}`))
  })

  exportBtn.addEventListener("click", () => {
    if (!selectedRunId) return
    callTool<{ runId: string }, { path?: string }>("review_export", { runId: selectedRunId })
      .then(result => {
        setStatus(result.path ? `Exported to ${result.path}` : "Exported.")
      })
      .catch((e: Error) => setStatus(`Export failed: ${e.message}`))
  })

  function doPoll(): void {
    if (pollTimer) clearTimeout(pollTimer)
    loadList().finally(() => {
      const anyRunning = rows.some(r => r.status === "running")
      pollTimer = setTimeout(doPoll, anyRunning ? POLL_RUNNING_MS : POLL_IDLE_MS)
    })
  }

  initBridge()
    .then(() => loadList())
    .then(() => {
      pollTimer = setTimeout(doPoll, POLL_RUNNING_MS)
    })
    .catch((e: Error) => setStatus(`Bridge error: ${e.message}`))
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot)
} else {
  boot()
}
