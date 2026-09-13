/**
 * Daemon-served stage board module for agentproto app UIs — a dependency-free
 * vanilla ES module rendered from the app state ledger.
 *
 * Serve (already wired into `agentproto app serve` / `app dev`):
 *
 *   <script type="module">
 *     import { mountStageBoard } from "/agentproto/stageboard.js";
 *     const board = mountStageBoard(document.getElementById("stages"), {
 *       appId: "@you/your-app",
 *       callTool: (name, args) => window.McpApp.connect().then(b => b.callTool(name, args)),
 *     });
 *   </script>
 *
 * `mountStageBoard` renders the board from `app_state_get` (the folded
 * snapshot + ledger events) and auto-refreshes every `refreshMs`. The pure
 * fold-to-rows helper `toRows(snapshot, events)` is exported separately so
 * tests (and other renderers) can reuse it without a DOM.
 *
 * Status vocabulary mirrors the daemon's `foldAppStateEvents` reducer:
 * pending | running | gated-failed | blocked | done | approved.
 *
 * Theming: all styles are scoped under `.ap-stageboard` and driven by CSS
 * variables with sensible fallbacks — an app overrides e.g.
 * `--ap-stageboard-accent` on an ancestor element to retheme the board.
 */

const STATUSES = ["pending", "running", "gated-failed", "blocked", "done", "approved"]

/** Unwrap nested MCP response shells (CallToolResult → text → JSON …). */
export function unwrapToolResult(result) {
  let cur = result
  for (let i = 0; i < 4; i++) {
    if (typeof cur === "string") {
      try {
        cur = JSON.parse(cur)
        continue
      } catch {
        return cur
      }
    }
    if (cur && Array.isArray(cur.content) && cur.content[0] && typeof cur.content[0].text === "string") {
      cur = cur.content[0].text
      continue
    }
    break
  }
  return cur
}

function gateFindings(payload) {
  const p = payload && typeof payload === "object" ? payload : {}
  const report = p.report
  if (report && typeof report === "object" && Array.isArray(report.findings)) return report.findings
  if (report !== undefined) return report
  return p
}

/**
 * Fold a ledger snapshot (+ raw events for per-event detail) into board rows.
 *
 * Returns `{ columns, rows }`:
 *   - `columns` — stage names in first-seen (snapshot key) order.
 *   - `rows`    — one row per item (or a single item-less row when the
 *     ledger never used items), each `{ item, cells, attempts, lastGate,
 *     appRunId }`: `cells[stage]` is the status chip label, `attempts` counts
 *     gate-report events, `lastGate` carries `{ ok, exitCode, findings, ts }`
 *     (findings from `payload.report.findings` when present, else the raw
 *     report payload), and `appRunId` is the most recent run that touched it.
 */
export function toRows(snapshot, events) {
  const stages = snapshot && snapshot.stages ? snapshot.stages : {}
  const columns = Object.keys(stages)
  const rows = []
  const byKey = new Map()
  const rowFor = (item) => {
    let row = byKey.get(item)
    if (!row) {
      row = { item, cells: {}, attempts: 0, lastGate: null, appRunId: null }
      byKey.set(item, row)
      rows.push(row)
    }
    return row
  }

  let anyItems = false
  for (const stage of columns) {
    const st = stages[stage] || {}
    const items = st.items && typeof st.items === "object" ? st.items : {}
    const itemKeys = Object.keys(items)
    if (itemKeys.length > 0) {
      anyItems = true
      for (const it of itemKeys) {
        const itemSnap = items[it] && typeof items[it] === "object" ? items[it] : {}
        rowFor(it).cells[stage] = itemSnap.status || "pending"
      }
    } else {
      const row = rowFor(null)
      row.cells[stage] = st.status || "pending"
      const gate = st.lastGate
      if (gate && typeof gate === "object") {
        row.lastGate = {
          ok: gate.ok === true,
          exitCode: typeof gate.exitCode === "number" ? gate.exitCode : null,
          findings: gateFindings(gate),
          ts: typeof gate.ts === "string" ? gate.ts : null,
        }
      }
    }
  }

  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== "object") continue
    const item = typeof ev.item === "string" && ev.item.length > 0 ? ev.item : null
    let row
    if (item !== null) {
      if (!anyItems) continue
      row = rowFor(item)
    } else {
      row = byKey.get(null)
    }
    if (!row) continue
    if (ev.kind === "gate-report") {
      row.attempts += 1
      const payload = ev.payload && typeof ev.payload === "object" ? ev.payload : {}
      row.lastGate = {
        ok: payload.ok === true,
        exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
        findings: gateFindings(payload),
        ts: typeof ev.ts === "string" ? ev.ts : null,
      }
    }
    if (typeof ev.appRunId === "string" && ev.appRunId.length > 0) row.appRunId = ev.appRunId
  }

  return { columns, rows: anyItems ? rows.filter((r) => r.item !== null) : rows }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
}

const STYLES = `
.ap-stageboard {
  --ap-sb-line: var(--ap-stageboard-line, #d0d7de);
  --ap-sb-muted: var(--ap-stageboard-muted, #6a737d);
  --ap-sb-bg: var(--ap-stageboard-bg, rgba(127,127,127,.08));
  --ap-sb-warn: var(--ap-stageboard-warn, #b8860b);
  --ap-sb-bad: var(--ap-stageboard-bad, #c0392b);
  --ap-sb-good: var(--ap-stageboard-good, #1e7e34);
  --ap-sb-accent: var(--ap-stageboard-accent, #0366d6);
  font-size: 13px;
  color: inherit;
}
.ap-stageboard .ap-sb-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.ap-stageboard .ap-sb-head h3 { margin: 0; font-size: 15px; }
.ap-stageboard .ap-sb-updated { color: var(--ap-sb-muted); font-size: 12px; }
.ap-stageboard .ap-sb-actions { display: flex; gap: 6px; margin: 0 0 10px; flex-wrap: wrap; }
.ap-stageboard button { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 6px;
  border: 1px solid var(--ap-sb-line); background: var(--ap-sb-bg); color: inherit; cursor: pointer; }
.ap-stageboard button:hover { border-color: var(--ap-sb-accent); }
.ap-stageboard .ap-sb-verify { background: var(--ap-sb-bg); border: 1px solid var(--ap-sb-line);
  border-radius: 6px; padding: 6px 10px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.ap-stageboard .ap-sb-board { overflow-x: auto; }
.ap-stageboard table { border-collapse: collapse; min-width: 480px; }
.ap-stageboard th, .ap-stageboard td { border: 1px solid var(--ap-sb-line); padding: 4px 8px; font-size: 12px; text-align: left; }
.ap-stageboard th { color: var(--ap-sb-muted); font-weight: 600; }
.ap-stageboard .ap-sb-chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px;
  background: var(--ap-sb-bg); color: var(--ap-sb-muted); border-left: 2px solid var(--ap-sb-line); }
.ap-stageboard .ap-sb-status-running { color: var(--ap-sb-warn); border-left-color: var(--ap-sb-warn); }
.ap-stageboard .ap-sb-status-gated-failed { color: var(--ap-sb-bad); border-left-color: var(--ap-sb-bad); }
.ap-stageboard .ap-sb-status-blocked { color: var(--ap-sb-bad); border-left-color: var(--ap-sb-bad); }
.ap-stageboard .ap-sb-status-done { color: var(--ap-sb-good); border-left-color: var(--ap-sb-good); }
.ap-stageboard .ap-sb-status-approved { color: var(--ap-sb-good); border-left-color: var(--ap-sb-good); border: 1px solid var(--ap-sb-line); }
.ap-stageboard details.ap-sb-gate { margin-top: 4px; font-size: 12px; color: var(--ap-sb-muted); }
.ap-stageboard details.ap-sb-gate pre { background: var(--ap-sb-bg); border: 1px solid var(--ap-sb-line);
  border-radius: 6px; padding: 8px; overflow-x: auto; max-width: 640px; white-space: pre-wrap; }
.ap-stageboard .ap-sb-empty { color: var(--ap-sb-muted); padding: 14px 0; }
.ap-stageboard .ap-sb-error { color: var(--ap-sb-bad); padding: 8px 0; }
.ap-stageboard .ap-sb-approvals { margin: 0 0 10px; border: 1px solid var(--ap-sb-line); border-radius: 6px; padding: 8px; }
.ap-stageboard .ap-sb-approvals .ap-sb-approval { display: flex; gap: 8px; align-items: center; padding: 3px 0; flex-wrap: wrap; }
`

function injectStyles(doc) {
  if (doc.getElementById("ap-stageboard-styles")) return
  const style = doc.createElement("style")
  style.id = "ap-stageboard-styles"
  style.textContent = STYLES
  doc.head.appendChild(style)
}

function renderRows(rows, columns) {
  return rows
    .map((row) => {
      const label = row.item === null ? "(stage)" : row.item
      const cells = columns
        .map((stage) => {
          const status = row.cells[stage] || "pending"
          const cls = STATUSES.includes(status) ? "ap-sb-status-" + status : ""
          return '<td><span class="ap-sb-chip ' + esc(cls) + '">' + esc(status) + "</span></td>"
        })
        .join("")
      const gateBits = []
      if (row.lastGate) gateBits.push("last gate: " + (row.lastGate.ok ? "ok" : "FAILED"))
      if (row.attempts > 0) gateBits.push("attempts: " + row.attempts)
      if (row.appRunId) gateBits.push("run: " + row.appRunId)
      const gateDetail = gateBits.length
        ? '<details class="ap-sb-gate"><summary>' + esc(gateBits.join(" · ")) + "</summary>" +
          '<pre>' + esc(row.lastGate ? JSON.stringify(row.lastGate.findings, null, 2) : "(no gate report)") + "</pre></details>"
        : ""
      return "<tr><td>" + esc(label) + "</td>" + cells + "<td>" + gateDetail + "</td></tr>"
    })
    .join("")
}

/**
 * Mount a live stage board into `el` (an Element or a CSS selector).
 *
 * Options:
 *   - `appId`     (required) the installed app whose ledger to render.
 *   - `callTool`  (required) `(name, args) => Promise<CallToolResult>` — the
 *     host bridge's tool-call function (e.g. `McpApp.connect().callTool`).
 *   - `refreshMs` auto-refresh interval (default 15000; 0 disables).
 *   - `onValidate` optional hook for the Validate button. When absent, the
 *     board shows the app's `verify.command` from `app_status` if that run
 *     status exposes one, and hides the button otherwise.
 *   - `onApprove` optional hook receiving a pending approval; when absent the
 *     board itself calls `workflow_escalation_resolve` (asking `who` via a
 *     prompt input), degrading gracefully when that tool is not in the
 *     app's `ui.tools` allowlist (feature-detected from the 403 error).
 *
 * Returns `{ refresh, destroy }`.
 */
export function mountStageBoard(el, opts) {
  const doc = typeof document !== "undefined" ? document : undefined
  if (!doc) throw new Error("mountStageBoard requires a DOM")
  const options = opts || {}
  if (typeof options.appId !== "string" || options.appId.length === 0) {
    throw new Error("mountStageBoard: options.appId is required")
  }
  if (typeof options.callTool !== "function") {
    throw new Error("mountStageBoard: options.callTool is required")
  }
  const host = typeof el === "string" ? doc.querySelector(el) : el
  if (!host) throw new Error("mountStageBoard: no host element")

  injectStyles(doc)

  const refreshMs = typeof options.refreshMs === "number" && options.refreshMs > 0 ? options.refreshMs : 15000
  let timer = null
  let destroyed = false
  let lastData = null
  let lastError = null
  let lastUpdated = null
  let approvals = []

  const root = doc.createElement("div")
  root.className = "ap-stageboard"
  host.appendChild(root)

  function unwrapOne(result) {
    const value = unwrapToolResult(result)
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.error === "string") {
      throw new Error(value.error)
    }
    return value
  }

  function callApp(tool, args) {
    return options.callTool("app_tool_call", { appId: options.appId, tool, args: args || {} }).then(unwrapOne)
  }

  async function fetchApprovals(state) {
    // `app_status.awaitingApprovals` is a recent addition — feature-detect:
    // absent (or an unreachable status), approvals render nothing.
    const runId =
      state && Array.isArray(state.events)
        ? state.events.map((e) => (e && typeof e.appRunId === "string" ? e.appRunId : null)).filter(Boolean).pop()
        : null
    const arg = runId ? { appRunId: runId } : { appId: options.appId }
    try {
      const status = await options.callTool("app_status", arg).then(unwrapOne)
      if (status && typeof status === "object" && Array.isArray(status.awaitingApprovals)) {
        return status.awaitingApprovals.filter((a) => a && typeof a === "object")
      }
      return []
    } catch {
      return []
    }
  }

  async function refresh() {
    if (destroyed) return
    try {
      const state = await callApp("app_state_get", { tail: 200 })
      lastData = state && typeof state === "object" ? state : null
      lastError = null
      lastUpdated = new Date()
      approvals = await fetchApprovals(state)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    render()
  }

  function onApproveClick(approval) {
    if (typeof options.onApprove === "function") {
      return Promise.resolve(options.onApprove(approval)).then(() => refresh())
    }
    const who = doc.defaultView && doc.defaultView.prompt ? doc.defaultView.prompt("Approve as (who)?", "human") : "human"
    if (!who) return Promise.resolve()
    return options
      .callTool("workflow_escalation_resolve", {
        approvalId: approval.approvalId,
        approved: true,
        who,
        ...(typeof approval.note === "string" ? { note: approval.note } : {}),
      })
      .then(() => refresh())
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        lastError = /forbidden|403|ui\.tools|allowlist/i.test(msg)
          ? "Approve is not permitted by this app's ui.tools allowlist."
          : msg
        render()
      })
  }

  function render() {
    const updated = lastUpdated ? "last updated " + lastUpdated.toLocaleTimeString() : "loading…"
    const head =
      '<div class="ap-sb-head"><h3>Stages</h3>' +
      '<span class="ap-sb-updated">' + esc(updated) + "</span>" +
      '<button class="ap-sb-refresh" type="button">Refresh</button></div>'

    const verifyCommand =
      lastData && lastData.verify && typeof lastData.verify === "object" && typeof lastData.verify.command === "string"
        ? lastData.verify.command
        : null
    const actions =
      '<div class="ap-sb-actions">' +
      (typeof options.onValidate === "function" ? '<button class="ap-sb-validate" type="button">Validate</button>' : "") +
      (verifyCommand ? '<span class="ap-sb-verify">' + esc(verifyCommand) + "</span>" : "") +
      "</div>"

    const approvalsHtml =
      approvals.length > 0
        ? '<div class="ap-sb-approvals"><div class="ap-sb-updated">' + approvals.length + " pending approval(s)</div>" +
          approvals
            .map(
              (a, i) =>
                '<div class="ap-sb-approval"><code>' +
                esc(a.approvalId != null ? a.approvalId : JSON.stringify(a)) +
                "</code>" +
                (typeof a.stage === "string" ? '<span class="ap-sb-updated">' + esc(a.stage) + "</span>" : "") +
                '<button class="ap-sb-approve" data-i="' + i + '" type="button">Approve</button></div>',
            )
            .join("") +
          "</div>"
        : ""

    let body
    const snapshot = lastData && lastData.snapshot ? lastData.snapshot : lastData && lastData.stages ? lastData : null
    const events = lastData && Array.isArray(lastData.events) ? lastData.events : []
    if (!snapshot || !snapshot.stages || Object.keys(snapshot.stages).length === 0) {
      body = '<div class="ap-sb-empty">No ledger yet — stages appear here once a run records state events.</div>'
    } else {
      const { columns, rows } = toRows(snapshot, events)
      body =
        '<div class="ap-sb-board"><table><thead><tr><th>item</th>' +
        columns.map((c) => "<th>" + esc(c) + "</th>").join("") +
        "<th>gate</th></tr></thead><tbody>" +
        renderRows(rows, columns) +
        "</tbody></table></div>"
    }

    root.innerHTML =
      head + actions + approvalsHtml + (lastError ? '<div class="ap-sb-error">' + esc(lastError) + "</div>" : "") + body

    const refreshBtn = root.querySelector(".ap-sb-refresh")
    if (refreshBtn) refreshBtn.onclick = () => void refresh()
    const validateBtn = root.querySelector(".ap-sb-validate")
    if (validateBtn) validateBtn.onclick = () => void options.onValidate()
    Array.prototype.forEach.call(root.querySelectorAll(".ap-sb-approve"), (btn) => {
      const approval = approvals[Number(btn.getAttribute("data-i"))]
      if (approval) btn.onclick = () => void onApproveClick(approval)
    })
  }

  render()
  void refresh()
  if (refreshMs > 0) timer = setInterval(() => void refresh(), refreshMs)

  return {
    refresh,
    destroy() {
      destroyed = true
      if (timer !== null) clearInterval(timer)
      timer = null
      if (root.parentNode) root.parentNode.removeChild(root)
    },
  }
}
