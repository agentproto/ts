/**
 * Work webview panel — the compact read-only task list in the sidebar
 * (`agentproto.work`, placed after Activity). The narrow-column companion to
 * the work-board app panel: a vertical list over the daemon's Task ledger
 * (`client.listTasks`), NOT a board — claiming and status moves stay in the
 * board app, which does them with a CAS `rev`.
 *
 * 501 DEGRADATION: `listTasks` throws `TasksUnavailableError` when the
 * daemon has no task ledger wired. The view catches it and shows one quiet
 * line — never a blank view, never an unhandled rejection.
 *
 * The only interaction is "Open the board" at the top, routed through the
 * SAME `agentproto.openWorkBoard` command the launcher contributes — never
 * a second path.
 *
 * Refresh rides the SAME signal the Activity/Sessions webviews refresh on
 * (the SessionStore's onDidChange) — deliberately no second polling timer.
 *
 * CSP/nonce idiom copied from sessionsWebviewPanel.ts. NOTE: the inline
 * script lives inside a JS template literal — never write a backtick in it,
 * comments included.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { TaskRecord } from "../client/types.js"
import { TasksUnavailableError, type DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import { buildWorkWebviewModel } from "./workWebview.logic.js"

const VIEW_TYPE = "agentproto.work"

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openBoard" }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  )
}

class WorkWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private tasks: TaskRecord[] | undefined
  /** Set when the daemon answers without a task ledger wired. */
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
        case "openBoard":
          void vscode.commands.executeCommand("agentproto.openWorkBoard")
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

  /** Called by registerWorkWebview's store subscription — the same live-update signal the other webviews ride. */
  refresh(): void {
    void this.refreshTasks()
  }

  private async refreshTasks(): Promise<void> {
    this.loading = true
    try {
      this.tasks = await this.client.listTasks({ includeClosed: true })
      this.unavailable = false
      this.loadError = undefined
    } catch (err) {
      if (err instanceof TasksUnavailableError) {
        // Degradation, not failure: one quiet line, not a blank view.
        this.tasks = undefined
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

  private post(): void {
    const view = this.view
    if (!view) return
    const model = buildWorkWebviewModel({ tasks: this.tasks, now: Date.now() })
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
 * shared SessionStore's onDidChange (the same signal the Activity and
 * Sessions webviews refresh on — no second polling timer).
 */
export function registerWorkWebview(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  const provider = new WorkWebviewProvider(client, store)
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
  <title>agentproto work</title>
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

    #daemon-state { display: none; flex: 1 1 auto; padding: 24px 18px; align-items: center; justify-content: center; text-align: center; color: var(--vscode-descriptionForeground, #9d9d9d); }
    body.daemon-state > #board-btn, body.daemon-state > #list, body.daemon-state > #unavailable { display: none !important; }
    body.daemon-state > #daemon-state { display: block; }

    /* The one affordance: open the full board app. */
    #board-btn { margin: 8px 12px 2px; padding: 4px 10px; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); border: 0; border-radius: 3px; font-family: inherit; font-size: 12px; cursor: pointer; flex: 0 0 auto; }
    #board-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }

    #list { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }

    /* Group headers — the Activity panel's idiom, narrowed for 340px. */
    .ghead { display: flex; align-items: center; gap: 7px; padding: 8px 12px 4px; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; cursor: pointer; user-select: none; }
    .ghead .tw { font-size: 8px; transition: transform 0.12s; }
    .ghead.closed .tw { transform: rotate(-90deg); }
    .ghead .n { font-weight: 400; }
    .gbody[hidden] { display: none; }

    /* Rows — read-only: title, owner, verification tell, age. */
    .row { display: flex; gap: 8px; padding: 5px 12px; align-items: baseline; }
    .row + .row { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
    .row.cancelled .title { text-decoration: line-through; }
    .mid { flex: 1; min-width: 0; }
    .title { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .right { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }
    .tag { display: inline-block; padding: 0 6px; border-radius: 10px; font-size: 10px; font-weight: 600; white-space: nowrap; }
    .tag.gate { background: var(--vscode-charts-green, #89d185); color: var(--vscode-editor-background, #1f1f1f); }
    .tag.self { background: transparent; color: var(--vscode-editorWarning-foreground, #cca700); border: 1px solid var(--vscode-editorWarning-foreground, #cca700); }
    .tag.human { background: transparent; color: var(--vscode-charts-blue, #4fc1ff); border: 1px solid var(--vscode-charts-blue, #4fc1ff); }
    .tag.gated { background: transparent; color: var(--vscode-descriptionForeground, #9d9d9d); border: 1px solid var(--vscode-descriptionForeground, #9d9d9d); }
    .tag.cancelled { background: transparent; color: var(--vscode-descriptionForeground, #9d9d9d); border: 1px dashed var(--vscode-descriptionForeground, #9d9d9d); }
    .time { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; white-space: nowrap; }

    #unavailable { padding: 8px 12px; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); flex: 0 0 auto; }
    #unavailable[hidden] { display: none; }
    #error { padding: 6px 12px; color: var(--vscode-errorForeground, #f14c4c); font-size: 11px; flex: 0 0 auto; }
    #error[hidden] { display: none; }
  </style>
</head>
<body class="daemon-state">
  <div id="daemon-state">Connecting to agentproto daemon…</div>
  <button id="board-btn" type="button">Open the board</button>
  <div id="list" role="list"></div>
  <div id="error" hidden></div>
  <div id="unavailable" hidden>This daemon has no task ledger wired.</div>
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

      function tagHTML(tell) {
        var cls = tell === '✓ gate' ? 'gate' : tell === 'self-report' ? 'self' : tell === 'human' ? 'human' : 'gated';
        return '<span class="tag ' + cls + '">' + escapeHtml(tell) + '</span>';
      }

      function rowsHTML(g) {
        return g.rows.map(function (r) {
          return '<div class="row' + (r.cancelled ? ' cancelled' : '') + '" role="listitem">' +
            '<div class="mid">' +
              '<div class="title" title="' + escapeHtml(r.title) + '">' + escapeHtml(r.title) + '</div>' +
              '<div class="sub">' + escapeHtml(r.owner ? 'claimed by ' + r.owner : 'Unclaimed') + '</div>' +
            '</div>' +
            '<div class="right">' +
              (r.cancelled ? '<span class="tag cancelled">cancelled</span>' : '') +
              (r.tell ? tagHTML(r.tell) : '') +
              '<span class="time">' + escapeHtml(r.age) + '</span>' +
            '</div>' +
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

      document.getElementById('board-btn').addEventListener('click', function () {
        vscode.postMessage({ type: 'openBoard' });
      });

      listEl.addEventListener('click', function (e) {
        var head = e.target.closest('.ghead');
        if (!head) return;
        var key = head.getAttribute('data-key');
        collapsed[key] = !collapsed[key];
        head.classList.toggle('closed', collapsed[key]);
        head.setAttribute('aria-expanded', collapsed[key] ? 'false' : 'true');
        var body = listEl.querySelector('.gbody[data-body="' + key + '"]');
        if (body) body.hidden = collapsed[key];
      });

      listEl.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var head = e.target.closest('.ghead');
        if (head) { e.preventDefault(); head.click(); }
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
