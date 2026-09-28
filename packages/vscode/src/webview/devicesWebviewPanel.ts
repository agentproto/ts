/**
 * Devices webview panel — this machine plus every paired device (client/host)
 * `GET /devices` knows about, with lazy drill-down into a host's remote
 * sessions. Mirrors the Activity/Harnesses webviews' row grammar: hairline
 * separators, a status dot, a stable action slot.
 *
 * Refresh cadence rides the SAME signal the Sessions/Activity webviews use
 * (the shared SessionStore's `onDidChange`) plus the panel's own "Refresh"
 * button — deliberately no polling timer. A host's session list is fetched
 * once on expand, then refetched on that same cadence ONLY while its row
 * stays expanded, never for a collapsed device — see devicesWebview.logic.ts
 * for why.
 *
 * CSP/nonce idiom copied from activityWebviewPanel.ts.
 */

import { randomBytes } from "node:crypto"
import { hostname as osHostname } from "node:os"

import * as vscode from "vscode"

import type { Device } from "../client/types.js"
import type { DaemonClient } from "../client/daemonClient.js"
import { registerOutputDocuments, type OutputDocuments } from "../services/outputDocument.js"
import type { DaemonConnectionState, SessionStore } from "../services/sessionStore.js"
import {
  buildDevicesWebviewModel,
  nextExpandedIds,
  type DeviceSessionsState,
  type DeviceWebviewRow,
} from "./devicesWebview.logic.js"

const VIEW_TYPE = "agentproto.devicesWebview"
/** Own scheme — the transcript panel already owns `agentproto-output`, and a
 *  scheme can only be registered once per extension host (same precedent as
 *  apps.ts's MANIFEST_SCHEME). */
const DEVICE_OUTPUT_SCHEME = "agentproto-device-output"

interface ModelMessage {
  type: "model"
  connection: DaemonConnectionState
  rows: DeviceWebviewRow[]
  loadError: string | undefined
}

type HostMessage = ModelMessage

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "toggleExpand"; id: string }
  | { type: "rename"; id: string }
  | { type: "revoke"; id: string }
  | { type: "copyFingerprint"; id: string }
  | { type: "openSession"; deviceId: string; sessionId: string; sessionName: string }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  )
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

class DevicesWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private devices: Device[] = []
  private expandedIds = new Set<string>()
  private sessionsByDevice = new Map<string, DeviceSessionsState>()
  private daemonVersion: string | undefined
  private loadError: string | undefined

  constructor(
    private readonly client: DaemonClient,
    private readonly store: SessionStore,
    private readonly outputDocs: OutputDocuments,
    private readonly hostname: string,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] }
    webviewView.webview.html = buildHtml(randomNonce(), webviewView.webview.cspSource)

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isWebviewToHostMessage(raw)) return
      this.handleMessage(raw)
    })

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.post()
    })

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined
    })

    void this.fetchHealth()
    this.refresh()
  }

  /** Called by registerDevicesWebview's store subscription — the same live-
   *  update signal Activity/Sessions refresh on. Re-fetches the top-level
   *  device list AND any currently-expanded host's sessions; a collapsed
   *  device's sessions are never touched. */
  refresh(): void {
    void this.fetchDevices()
    for (const id of this.expandedIds) void this.loadDeviceSessions(id)
  }

  private handleMessage(msg: WebviewToHostMessage): void {
    switch (msg.type) {
      case "ready":
        this.post()
        return
      case "refresh":
        this.refresh()
        return
      case "toggleExpand":
        this.toggleExpand(msg.id)
        return
      case "rename":
        void this.renameDevice(msg.id)
        return
      case "revoke":
        void this.revokeDevice(msg.id)
        return
      case "copyFingerprint":
        void this.copyFingerprint(msg.id)
        return
      case "openSession":
        void this.openDeviceSession(msg.deviceId, msg.sessionId, msg.sessionName)
        return
    }
  }

  private async fetchHealth(): Promise<void> {
    try {
      const health = await this.client.health()
      this.daemonVersion = health.version ?? undefined
    } catch {
      this.daemonVersion = undefined
    }
    this.post()
  }

  private async fetchDevices(): Promise<void> {
    try {
      this.devices = await this.client.listDevices()
      this.loadError = undefined
    } catch (err) {
      this.loadError = describeError(err)
    }
    this.post()
  }

  private toggleExpand(id: string): void {
    this.expandedIds = nextExpandedIds(this.expandedIds, id)
    this.post()
    if (this.expandedIds.has(id) && !this.sessionsByDevice.has(id)) {
      void this.loadDeviceSessions(id)
    }
  }

  private async loadDeviceSessions(id: string): Promise<void> {
    this.sessionsByDevice.set(id, { status: "loading" })
    this.post()
    try {
      const { sessions, stale, capturedAt } = await this.client.getDeviceSessions(id)
      this.sessionsByDevice.set(id, { status: "loaded", sessions, ...(stale ? { stale, capturedAt } : {}) })
    } catch (err) {
      this.sessionsByDevice.set(id, { status: "error", message: describeError(err) })
    }
    this.post()
  }

  private async renameDevice(id: string): Promise<void> {
    const device = this.devices.find(d => d.fingerprint === id)
    if (!device) return
    const name = await vscode.window.showInputBox({
      prompt: `Rename "${device.name}"`,
      value: device.name,
      validateInput: v => (v.trim().length > 0 ? undefined : "Name can't be empty"),
    })
    const trimmed = name?.trim()
    if (!trimmed || trimmed === device.name) return
    try {
      await this.client.renameDevice(id, trimmed)
      await this.fetchDevices()
    } catch (err) {
      vscode.window.showErrorMessage(`agentproto: rename failed — ${describeError(err)}`)
    }
  }

  private async revokeDevice(id: string): Promise<void> {
    const device = this.devices.find(d => d.fingerprint === id)
    if (!device) return
    const choice = await vscode.window.showWarningMessage(
      `Revoke device "${device.name}"?`,
      { modal: true, detail: "It can no longer connect until re-paired." },
      "Revoke",
    )
    if (choice !== "Revoke") return
    try {
      await this.client.revokeDevice(id)
      this.expandedIds.delete(id)
      this.sessionsByDevice.delete(id)
      await this.fetchDevices()
    } catch (err) {
      vscode.window.showErrorMessage(`agentproto: revoke failed — ${describeError(err)}`)
    }
  }

  private async copyFingerprint(id: string): Promise<void> {
    await vscode.env.clipboard.writeText(id)
    vscode.window.showInformationMessage(`agentproto: copied fingerprint ${id}`)
  }

  private async openDeviceSession(deviceId: string, sessionId: string, sessionName: string): Promise<void> {
    try {
      const result = await this.client.getDeviceSessionOutput(deviceId, sessionId)
      const text = result.lines.length > 0 ? result.lines.join("\n") : "(no output yet)"
      await this.outputDocs.show(`${sessionName} — output`, text)
    } catch (err) {
      vscode.window.showErrorMessage(`agentproto: couldn't load session output — ${describeError(err)}`)
    }
  }

  private post(): void {
    if (!this.view) return
    const model = buildDevicesWebviewModel({
      hostname: this.hostname,
      daemonVersion: this.daemonVersion,
      localSessionCount: this.store.sessions.length,
      devices: this.devices,
      expandedIds: this.expandedIds,
      sessionsByDevice: this.sessionsByDevice,
      now: Date.now(),
    })
    const message: ModelMessage = {
      type: "model",
      connection: this.store.connectionState,
      rows: model.rows,
      loadError: this.loadError,
    }
    void this.view.webview.postMessage(message satisfies HostMessage)
  }
}

/**
 * Registers the WebviewViewProvider and wires the live-update signal: the
 * shared SessionStore's onDidChange (same signal Activity refreshes on — no
 * second polling timer). Owns its own read-only output-document scheme for
 * a remote session's output tail.
 */
export function registerDevicesWebview(ctx: vscode.ExtensionContext, client: DaemonClient, store: SessionStore): void {
  const outputDocs = registerOutputDocuments(ctx, DEVICE_OUTPUT_SCHEME)
  const provider = new DevicesWebviewProvider(client, store, outputDocs, osHostname())
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider),
    store.onDidChange(() => provider.refresh()),
  )
}

function randomNonce(): string {
  return randomBytes(16).toString("hex")
}

/** Exported so devicesWebview.dom.test.ts can execute the exact shipped HTML/script in jsdom. */
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
  <title>agentproto devices</title>
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
    body.daemon-state > #list { display: none !important; }
    body.daemon-state > #daemon-state { display: block; }

    #list { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }
    #error { padding: 6px 12px; color: var(--vscode-errorForeground, #f14c4c); font-size: 11px; flex: 0 0 auto; }
    #error[hidden] { display: none; }
    #foot { display: flex; align-items: center; padding: 4px 12px 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); flex: 0 0 auto; }
    #refresh { background: transparent; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; padding: 2px 10px; cursor: pointer; border-radius: 4px; font-family: inherit; }
    #refresh:hover { color: var(--vscode-foreground, #cccccc); border-color: var(--vscode-descriptionForeground, #9d9d9d); }

    .row { display: flex; gap: 9px; padding: 7px 10px 7px 14px; position: relative; border-left: 2px solid transparent; align-items: flex-start; }
    .row + .row { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
    .row.offline { opacity: 0.55; }
    .ddot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto; }
    .ddot.online { background: var(--vscode-charts-green, #89d185); }
    .ddot.offline { background: var(--vscode-descriptionForeground, #9d9d9d); opacity: 0.6; }
    .twist { flex: 0 0 auto; width: 14px; margin-top: 3px; border: none; background: transparent; color: var(--vscode-descriptionForeground, #9d9d9d); cursor: pointer; font-size: 9px; padding: 0; transition: transform 0.12s; }
    .twist.open { transform: rotate(90deg); }
    .twist[hidden] { visibility: hidden; }
    .mid { flex: 1; min-width: 0; }
    .name { font-weight: 600; font-size: 12.5px; display: flex; gap: 6px; align-items: baseline; min-width: 0; flex-wrap: wrap; row-gap: 2px; }
    .name .chip { font-weight: 400; font-size: 10px; letter-spacing: .03em; color: var(--vscode-descriptionForeground, #9d9d9d); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 4px; padding: 0 4px; white-space: nowrap; }
    .name .chip.host-scoped { color: var(--vscode-charts-purple, #b180d7); border-color: currentColor; }
    .name .chip.legacy { color: var(--vscode-editorWarning-foreground, #cca700); border-color: currentColor; }
    .meta { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .right { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
    .time { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; white-space: nowrap; }
    .menu-btn { background: transparent; border: none; color: var(--vscode-descriptionForeground, #9d9d9d); cursor: pointer; font-size: 13px; padding: 0 4px; border-radius: 3px; }
    .menu-btn:hover { color: var(--vscode-foreground, #cccccc); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .menu-btn[hidden] { visibility: hidden; }

    .menu { position: fixed; z-index: 50; background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(128,128,128,0.35))); border-radius: 4px; padding: 4px; box-shadow: 0 4px 14px rgba(0,0,0,0.35); min-width: 140px; }
    .menu[hidden] { display: none; }
    .menu button { display: block; width: 100%; text-align: left; background: transparent; border: none; color: var(--vscode-menu-foreground, var(--vscode-foreground, #cccccc)); font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 3px; cursor: pointer; }
    .menu button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))); }
    .menu button.danger:hover { color: var(--vscode-errorForeground, #f14c4c); }

    .sessions[hidden] { display: none; }
    .sessions { padding: 2px 10px 6px 34px; }
    .srow { display: flex; gap: 7px; align-items: center; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
    .srow:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); }
    .sdot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
    .sdot.needs-you { background: var(--vscode-editorWarning-foreground, #cca700); }
    .sdot.stalled, .sdot.failed { background: var(--vscode-charts-red, #f14c4c); }
    .sdot.parked-bg { background: var(--vscode-charts-orange, #d18616); }
    .sdot.working { background: var(--vscode-charts-green, #89d185); }
    .sdot.idle, .sdot.stopped { background: transparent; border: 1px solid var(--vscode-descriptionForeground, #9d9d9d); opacity: 0.7; }
    .sdot.done { background: var(--vscode-descriptionForeground, #9d9d9d); opacity: 0.55; }
    .sname { flex: 1; min-width: 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sage { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; white-space: nowrap; flex: 0 0 auto; }
    .sstate { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; padding: 4px 6px; }
    .sstate.error { color: var(--vscode-errorForeground, #f14c4c); }
    .sstate.stale { color: var(--vscode-editorWarning-foreground, #cca700); }
  </style>
</head>
<body class="daemon-state">
  <div id="daemon-state">Connecting to agentproto daemon…</div>
  <div id="list" role="list"></div>
  <div id="error" hidden></div>
  <div id="foot"><button id="refresh" type="button" title="Re-fetch devices" aria-label="Re-fetch devices">Refresh</button></div>
  <div class="menu" id="menu" hidden role="menu"></div>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      var listEl = document.getElementById('list');
      var errorEl = document.getElementById('error');
      var refreshEl = document.getElementById('refresh');
      var menuEl = document.getElementById('menu');
      var rowsById = {};

      function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, function (ch) {
          return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;';
        });
      }

      function chipsHTML(r) {
        var html = '<span class="chip">' + escapeHtml(r.roleLabel) + '</span><span class="chip">' + escapeHtml(r.kindLabel) + '</span>';
        if (r.hostScoped) html += '<span class="chip host-scoped">host-scoped</span>';
        if (r.legacy) html += '<span class="chip legacy">legacy</span>';
        return html;
      }

      function sessionsHTML(r) {
        if (!r.sessions) return '';
        var stale = r.sessions.status === 'loaded' && r.sessions.stale
          ? '<div class="sstate stale">Host offline — last seen sessions (' + escapeHtml(r.sessions.staleLabel || 'captured earlier') + ')</div>'
          : '';
        var body;
        if (r.sessions.status === 'loading') {
          body = '<div class="sstate">Loading sessions…</div>';
        } else if (r.sessions.status === 'error') {
          body = '<div class="sstate error">' + escapeHtml(r.sessions.message) + '</div>';
        } else if (r.sessions.rows.length === 0) {
          body = '<div class="sstate">No sessions.</div>';
        } else {
          body = r.sessions.rows.map(function (s) {
            return '<div class="srow" data-device="' + escapeHtml(r.id) + '" data-session="' + escapeHtml(s.id) + '" data-session-name="' + escapeHtml(s.name) + '" role="listitem" tabindex="0">' +
              '<span class="sdot ' + escapeHtml(s.status) + '"></span>' +
              '<span class="sname">' + escapeHtml(s.name) + '</span>' +
              '<span class="sage">' + escapeHtml(s.ageLabel) + '</span>' +
            '</div>';
          }).join('');
        }
        return '<div class="sessions" data-owner="' + escapeHtml(r.id) + '">' + stale + body + '</div>';
      }

      function rowHTML(r) {
        var expanded = !!(r.sessions);
        var twist = r.expandable
          ? '<button class="twist' + (expanded ? ' open' : '') + '" data-act="toggle" data-id="' + escapeHtml(r.id) + '" title="Toggle sessions" aria-label="Toggle sessions">&#9656;</button>'
          : '<span class="twist" hidden></span>';
        var menuBtn = r.isThisMachine
          ? '<button class="menu-btn" hidden></button>'
          : '<button class="menu-btn" data-act="menu" data-id="' + escapeHtml(r.id) + '" title="Device actions" aria-label="Device actions">&#8942;</button>';
        return '<div class="row' + (r.online ? '' : ' offline') + '" data-id="' + escapeHtml(r.id) + '" role="listitem">' +
          twist +
          '<span class="ddot ' + (r.online ? 'online' : 'offline') + '"></span>' +
          '<div class="mid">' +
            '<div class="name"><span>' + escapeHtml(r.name) + '</span>' + chipsHTML(r) + '</div>' +
            '<div class="meta">' + escapeHtml(r.detail) + '</div>' +
          '</div>' +
          '<div class="right"><span class="time">' + escapeHtml(r.lastSeenLabel) + '</span>' + menuBtn + '</div>' +
        '</div>' + sessionsHTML(r);
      }

      function render(payload) {
        if (payload.connection && payload.connection !== 'connected') {
          document.body.classList.add('daemon-state');
          return;
        }
        document.body.classList.remove('daemon-state');
        var rows = payload.rows || [];
        rowsById = {};
        for (var i = 0; i < rows.length; i++) rowsById[rows[i].id] = rows[i];
        listEl.innerHTML = rows.map(rowHTML).join('');
        errorEl.hidden = !payload.loadError;
        errorEl.textContent = payload.loadError || '';
      }

      function hideMenu() {
        menuEl.hidden = true;
        menuEl.innerHTML = '';
      }

      function showMenu(anchor, id) {
        var rect = anchor.getBoundingClientRect();
        menuEl.innerHTML =
          '<button data-menu-act="rename">Rename…</button>' +
          '<button data-menu-act="copyFingerprint">Copy fingerprint</button>' +
          '<button class="danger" data-menu-act="revoke">Revoke…</button>';
        menuEl.dataset.id = id;
        menuEl.hidden = false;
        var top = rect.bottom + 2;
        var left = Math.min(rect.left, window.innerWidth - 160);
        menuEl.style.top = top + 'px';
        menuEl.style.left = left + 'px';
      }

      listEl.addEventListener('click', function (e) {
        var twist = e.target.closest('.twist[data-act="toggle"]');
        if (twist) {
          vscode.postMessage({ type: 'toggleExpand', id: twist.getAttribute('data-id') });
          return;
        }
        var menuBtn = e.target.closest('.menu-btn[data-act="menu"]');
        if (menuBtn) {
          var id = menuBtn.getAttribute('data-id');
          if (menuEl.hidden === false && menuEl.dataset.id === id) { hideMenu(); return; }
          showMenu(menuBtn, id);
          return;
        }
        var srow = e.target.closest('.srow');
        if (srow) {
          vscode.postMessage({
            type: 'openSession',
            deviceId: srow.getAttribute('data-device'),
            sessionId: srow.getAttribute('data-session'),
            sessionName: srow.getAttribute('data-session-name'),
          });
        }
      });

      menuEl.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-menu-act]');
        if (!btn) return;
        var act = btn.getAttribute('data-menu-act');
        var id = menuEl.dataset.id;
        hideMenu();
        if (act === 'rename') vscode.postMessage({ type: 'rename', id: id });
        else if (act === 'revoke') vscode.postMessage({ type: 'revoke', id: id });
        else if (act === 'copyFingerprint') vscode.postMessage({ type: 'copyFingerprint', id: id });
      });

      document.addEventListener('click', function (e) {
        if (!menuEl.hidden && !menuEl.contains(e.target) && !e.target.closest('.menu-btn[data-act="menu"]')) hideMenu();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') hideMenu();
      });

      refreshEl.addEventListener('click', function () {
        vscode.postMessage({ type: 'refresh' });
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
