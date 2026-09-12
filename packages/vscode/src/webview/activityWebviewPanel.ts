/**
 * Activity webview panel — the read-only "what is the daemon doing" sidebar
 * (`agentproto.activity`). Consumes the daemon's Activity projection
 * (`client.listActivities`, a deterministic recomputed-on-every-call read
 * model) plus the shell sessions the Sessions panel no longer carries: PTY
 * terminals (`kind === "terminal"`) and parentless raw command executions
 * (`kind === "command"`).
 *
 * Read-only by construction: no action buttons, no writes. The only
 * interaction is opening a terminal/command session, routed through the SAME
 * `agentproto.openSession` command the Sessions panel uses — never a second
 * path.
 *
 * 501 DEGRADATION: `listActivities` throws `ActivitiesUnavailableError` when
 * the daemon runs without an activity projector wired. The panel catches it,
 * still renders the Terminals/Commands groups, and shows one quiet line
 * explaining the daemon has no activity projector — never a blank panel,
 * never an unhandled rejection.
 *
 * Refresh rides the SAME signal the Sessions webview refreshes on (the
 * SessionStore's onDidChange) — deliberately no second polling timer.
 *
 * CSP/nonce idiom copied from sessionsWebviewPanel.ts. NOTE: the inline
 * script lives inside a JS template literal — never write a backtick in it,
 * comments included.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { ActivityRecord, SessionDescriptor } from "../client/types.js"
import { ActivitiesUnavailableError, type DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import { buildActivityWebviewModel } from "./activityWebview.logic.js"

const VIEW_TYPE = "agentproto.activity"

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "open"; id: string }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  )
}

class ActivityWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private activities: ActivityRecord[] | undefined
  /** Set when the daemon answers 501 — no activity projector wired. */
  private unavailable = false
  private loadError: string | undefined
  private loading = false

  constructor(
    private readonly client: DaemonClient,
    private readonly store: SessionStore,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] }
    webviewView.webview.html = buildHtml(randomNonce(), webviewView.webview.cspSource)

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isWebviewToHostMessage(raw)) return
      switch (raw.type) {
        case "ready":
          void this.refresh()
          return
        case "refresh":
          void this.refresh()
          return
        case "open":
          void this.openSession(raw.id)
          return
      }
    })

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.post()
    })

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined
    })

    void this.refresh()
  }

  /** Called by registerActivityWebview's store subscription — the same live-update signal the Sessions webview rides. */
  refresh(): void {
    void this.refreshActivities()
  }

  private async refreshActivities(): Promise<void> {
    this.loading = true
    try {
      this.activities = await this.client.listActivities({ includeTerminal: true })
      this.unavailable = false
      this.loadError = undefined
    } catch (err) {
      if (err instanceof ActivitiesUnavailableError) {
        // Degradation, not failure: the shell groups still render.
        this.activities = undefined
        this.unavailable = true
        this.loadError = undefined
      } else {
        this.loadError = err instanceof Error ? err.message : String(err)
      }
    } finally {
      this.loading = false
      this.post()
    }
  }

  private async openSession(id: string): Promise<void> {
    const fromStore = this.store.sessions.find(s => s.id === id)
    const session = fromStore ?? (await this.client.getSession(id).catch(() => undefined))
    // Reuse the exact path the Sessions panel uses — agentproto.openSession is
    // the one place that decides terminal vs. transcript.
    if (session) await vscode.commands.executeCommand("agentproto.openSession", session)
  }

  private post(): void {
    const view = this.view
    if (!view) return
    const model = buildActivityWebviewModel({
      activities: this.activities,
      // SessionDescriptor satisfies the SessionSummary slice structurally.
      sessions: this.store.sessions,
      now: Date.now(),
    })
    const message = {
      type: "model" as const,
      connection: this.store.connectionState,
      groups: model.groups,
      shownCount: model.shownCount,
      unavailable: this.unavailable,
      loadError: this.loadError,
      loading: this.loading,
    }
    void view.webview.postMessage(message)
  }
}

/**
 * Registers the WebviewViewProvider and wires the live-update signal: the
 * shared SessionStore's onDidChange (the same signal the Sessions webview
 * refreshes on — no second polling timer).
 */
export function registerActivityWebview(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  const provider = new ActivityWebviewProvider(client, store)
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider),
    store.onDidChange(() => provider.refresh()),
  )
}

function randomNonce(): string {
  return randomBytes(16).toString("hex")
}

/** Exported so the shipped HTML/script can be executed in a DOM test harness. */
export function buildHtml(nonce: string, cspSource: string): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src ${cspSource}`,
    `connect-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ")

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>agentproto activity</title>
  <style>
    :root {
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground, #cccccc));
      background-color: var(--vscode-sideBar-background, var(--vscode-editor-background, #1f1f1f));
      font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
      font-size: 13px;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    body { display: flex; flex-direction: column; }
    .mono { font-family: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace); }

    #daemon-state { display: none; flex: 1 1 auto; padding: 24px 18px; align-items: center; justify-content: center; text-align: center; color: var(--vscode-descriptionForeground, #9d9d9d); }
    body.daemon-state > #list, body.daemon-state > #unavailable { display: none !important; }
    body.daemon-state > #daemon-state { display: block; }

    /* Collapsible group headers with a painted count — same idiom as the
       Sessions panel's sections. */
    .ghead { display: flex; align-items: center; gap: 7px; padding: 9px 12px 5px; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; cursor: pointer; user-select: none; }
    .ghead .tw { font-size: 8px; color: var(--vscode-descriptionForeground, #9d9d9d); transition: transform 0.12s; }
    .ghead.closed .tw { transform: rotate(-90deg); }
    .ghead .n { color: var(--vscode-descriptionForeground, #9d9d9d); font-weight: 400; }
    .gbody[hidden] { display: none; }

    #list { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }

    /* Rows — read-only: no hover actions, just the state dot and text. */
    .row { display: flex; gap: 9px; padding: 6px 10px 6px 14px; position: relative; border-left: 2px solid transparent; }
    .row.clickable { cursor: pointer; }
    .row.clickable:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); }
    .row + .row { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
    .row.terminal { opacity: 0.65; }
    .row.stale .stale-flag { color: var(--vscode-editorWarning-foreground, #cca700); }
    .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto; }
    .dot.active { background: var(--vscode-charts-green, #89d185); }
    .dot.pending { background: var(--vscode-charts-yellow, #cca700); }
    .dot.done { background: var(--vscode-descriptionForeground, #9d9d9d); opacity: 0.6; }
    .dot.failed { background: var(--vscode-charts-red, #f14c4c); }
    .dot.cancelled { background: var(--vscode-descriptionForeground, #9d9d9d); }
    .mid { flex: 1; min-width: 0; }
    .name { font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .name .id { font-weight: 400; color: var(--vscode-descriptionForeground, #9d9d9d); }
    .msg { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 12px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .right { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
    .time { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; white-space: nowrap; }

    #unavailable { padding: 8px 12px; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); flex: 0 0 auto; }
    #unavailable[hidden] { display: none; }
    #error { padding: 6px 12px; color: var(--vscode-errorForeground, #f14c4c); font-size: 11px; flex: 0 0 auto; }
    #error[hidden] { display: none; }
  </style>
</head>
<body class="daemon-state">
  <div id="daemon-state">Connecting to agentproto daemon…</div>
  <div id="list" role="list"></div>
  <div id="error" hidden></div>
  <div id="unavailable" hidden>This daemon has no activity projector wired — live activity is unavailable. Shell sessions still appear below.</div>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      var listEl = document.getElementById('list');
      var unavailableEl = document.getElementById('unavailable');
      var errorEl = document.getElementById('error');
      var collapsed = {};

      function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, function (ch) {
          return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;';
        });
      }

      function rowsHTML(g) {
        return g.rows.map(function (r) {
          var clickable = r.kind === 'terminal' || r.kind === 'command';
          return '<div class="row' + (clickable ? ' clickable' : '') + (r.terminal ? ' terminal' : '') + (r.stale ? ' stale' : '') + '" data-id="' + escapeHtml(r.sessionId || r.id) + '" data-clickable="' + (clickable ? '1' : '') + '" role="listitem" tabindex="' + (clickable ? '0' : '-1') + '">' +
            '<span class="dot ' + escapeHtml(r.state) + '"></span>' +
            '<div class="mid">' +
              '<div class="name">' + escapeHtml(r.title) + '</div>' +
              (r.waitingOn ? '<div class="msg">' + escapeHtml(r.waitingOn) + '</div>' : '') +
              (r.stale ? '<div class="msg stale-flag" title="Active but silent for a while">stale — active but silent</div>' : '') +
            '</div>' +
            '<div class="right"><span class="time">' + escapeHtml(r.age) + '</span></div>' +
          '</div>';
        }).join('');
      }

      function groupHTML(g) {
        var isClosed = collapsed[g.key] === true;
        var head = '<div class="ghead' + (isClosed ? ' closed' : '') + '" data-key="' + escapeHtml(g.key) + '" role="button" tabindex="0" aria-expanded="' + (isClosed ? 'false' : 'true') + '">' +
          '<span class="tw">&#9662;</span>' + escapeHtml(g.label) + ' <span class="n">' + g.rows.length + '</span></div>';
        var body = '<div class="gbody" data-body="' + escapeHtml(g.key) + '"' + (isClosed ? ' hidden' : '') + '>' + rowsHTML(g) + '</div>';
        return head + body;
      }

      function render(payload) {
        if (payload.connection && payload.connection !== 'connected') {
          document.body.classList.add('daemon-state');
          return;
        }
        document.body.classList.remove('daemon-state');
        var groups = payload.groups || [];
        listEl.innerHTML = groups.map(groupHTML).join('');
        unavailableEl.hidden = payload.unavailable !== true;
        errorEl.hidden = !payload.loadError;
        errorEl.textContent = payload.loadError || '';
      }

      listEl.addEventListener('click', function (e) {
        var head = e.target.closest('.ghead');
        if (head) {
          var key = head.getAttribute('data-key');
          collapsed[key] = !collapsed[key];
          head.classList.toggle('closed', collapsed[key]);
          head.setAttribute('aria-expanded', collapsed[key] ? 'false' : 'true');
          var body = listEl.querySelector('.gbody[data-body="' + key + '"]');
          if (body) body.hidden = collapsed[key];
          return;
        }
        var row = e.target.closest('.row[data-clickable="1"]');
        if (row) vscode.postMessage({ type: 'open', id: row.getAttribute('data-id') });
      });

      listEl.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var head = e.target.closest('.ghead');
        if (head) { e.preventDefault(); head.click(); return; }
        var row = e.target.closest('.row[data-clickable="1"]');
        if (row) { e.preventDefault(); vscode.postMessage({ type: 'open', id: row.getAttribute('data-id') }); }
      });

      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (msg && msg.type === 'model') render(msg);
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`
}
