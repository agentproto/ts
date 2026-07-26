/**
 * Configuration Lab webview view — the right-hand/pre-spawn planning surface
 * in the Agentproto Lab Activity Bar container. Lets the user pick a harness,
 * model, route, auth profile, posture, and effort, then previews the resolved
 * effective launch configuration without spawning anything.
 *
 * Host ↔ webview protocol:
 *   Host → webview:  { type: "snapshot", snapshot: ConfigurationLabSnapshot }
 *   webview → host:  { type: "ready" }
 *                      { type: "setHarness", adapter }
 *                      { type: "setModel", model }
 *                      { type: "setRoute", route }
 *                      { type: "setProfile", profile }
 *                      { type: "setPosture", posture }
 *                      { type: "setEffort", effort }
 *                      { type: "validate" }
 *                      { type: "copyJson" }
 *                      { type: "spawn" }
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type {
  ConfigurationLabIssue,
  ConfigurationLabSelectionInput,
  ConfigurationLabSnapshot,
} from "../client/types.js"
import {
  buildConfigurationLabSnapshot,
  fetchConfigurationLabData,
  labSelectionToSpawnArgs,
} from "../commands/configurationLab.logic.js"

const VIEW_TYPE = "agentproto.configurationLab"

export type HostToWebviewMessage = {
  type: "snapshot"
  snapshot: ConfigurationLabSnapshot
}

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "setHarness"; adapter: string }
  | { type: "setModel"; model: string }
  | { type: "setRoute"; route: string }
  | { type: "setProfile"; profile: string }
  | { type: "setPosture"; posture: string }
  | { type: "setEffort"; effort: string }
  | { type: "validate" }
  | { type: "copyJson" }
  | { type: "spawn" }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (typeof value !== "object" || value === null) return false
  if (!("type" in value)) return false
  return typeof (value as { type: unknown }).type === "string"
}

class ConfigurationLabWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private selection: ConfigurationLabSelectionInput = {}
  private latestSnapshot: ConfigurationLabSnapshot | undefined

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: DaemonClient,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }
    webviewView.webview.html = buildHtml(randomNonce(), webviewView.webview.cspSource)

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isWebviewToHostMessage(raw)) return
      void this.handleMessage(raw)
    })

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void this.refresh()
    })

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined
    })
  }

  async refresh(): Promise<void> {
    await this.resolveAndPost()
  }

  private async resolveAndPost(): Promise<void> {
    if (!this.view) return
    try {
      const data = await fetchConfigurationLabData(
        {
          listAdapters: () => this.client.listAdapters(),
          harnessCapabilities: (adapter) => this.client.harnessCapabilities(adapter),
          catalogModels: () => this.client.catalogModels(),
          listAuthProfiles: () => this.client.listAuthProfiles(),
          listProviderPresets: () => this.client.listProviderPresets(),
        },
        this.selection.adapter,
      )
      this.latestSnapshot = buildConfigurationLabSnapshot(data, { ...this.selection })
    } catch {
      this.latestSnapshot = emptySnapshot(this.selection)
    }
    void this.post({ type: "snapshot", snapshot: this.latestSnapshot })
  }

  private async handleMessage(msg: WebviewToHostMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        void this.resolveAndPost()
        return
      case "setHarness":
        this.selection = { adapter: msg.adapter }
        void this.resolveAndPost()
        return
      case "setModel":
        this.selection = { ...this.selection, model: msg.model }
        void this.resolveAndPost()
        return
      case "setRoute":
        this.selection = { ...this.selection, route: msg.route }
        void this.resolveAndPost()
        return
      case "setProfile":
        this.selection = { ...this.selection, profile: msg.profile }
        void this.resolveAndPost()
        return
      case "setPosture":
        this.selection = { ...this.selection, posture: msg.posture }
        void this.resolveAndPost()
        return
      case "setEffort":
        this.selection = { ...this.selection, effort: msg.effort }
        void this.resolveAndPost()
        return
      case "validate":
        void this.resolveAndPost()
        return
      case "copyJson": {
        if (this.selection.adapter) {
          const args = labSelectionToSpawnArgs(this.selection)
          await vscode.env.clipboard.writeText(JSON.stringify(args, null, 2))
          void vscode.window.showInformationMessage("agentproto: spawn options copied to clipboard")
        }
        return
      }
      case "spawn": {
        if (this.selection.adapter) {
          const args = labSelectionToSpawnArgs(this.selection)
          void vscode.commands.executeCommand("agentproto.spawnAgent", args)
        }
        return
      }
    }
  }

  private post(message: HostToWebviewMessage): void {
    if (!this.view) return
    void this.view.webview.postMessage(message)
  }
}

function emptySnapshot(selection: ConfigurationLabSelectionInput): ConfigurationLabSnapshot {
  return {
    selection: {
      adapter: selection.adapter,
      model: selection.model,
      route: selection.route,
      profile: selection.profile,
      posture: selection.posture,
      effort: selection.effort,
      options: selection.options,
    },
    adapters: [],
    harness: null,
    axes: { models: [], routes: [], profiles: [], postures: [], efforts: [] },
    effective: [],
    issues: [
      {
        severity: "error",
        message: "Could not reach the agentproto daemon. Is it running?",
      },
    ],
  }
}

function randomNonce(): string {
  return randomBytes(16).toString("hex")
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
  })
}

function issueClass(issue: ConfigurationLabIssue): string {
  switch (issue.severity) {
    case "error":
      return "issue error"
    case "warning":
      return "issue warning"
    default:
      return "issue info"
  }
}

function issueIcon(issue: ConfigurationLabIssue): string {
  switch (issue.severity) {
    case "error":
      return "✕"
    case "warning":
      return "⚠"
    default:
      return "ℹ"
  }
}

export function registerConfigurationLabWebview(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
): void {
  const provider = new ConfigurationLabWebviewProvider(ctx.extensionUri, client)
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider))
}

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
  <title>agentproto configuration lab</title>
  <style>
    :root {
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    body { display: flex; flex-direction: column; }
    #app { flex: 1 1 auto; overflow-y: auto; padding: 12px; }
    h1 { font-size: 13px; font-weight: 600; margin: 0 0 10px; color: var(--vscode-foreground); }
    h2 { font-size: 12px; font-weight: 600; margin: 16px 0 8px; color: var(--vscode-foreground); text-transform: uppercase; letter-spacing: 0.03em; }
    .section { margin-bottom: 4px; }
    .row { display: flex; flex-direction: column; margin-bottom: 10px; }
    label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
    select, input[type="text"] {
      width: 100%; height: 26px; background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-input-foreground, var(--vscode-foreground));
      font-size: 12px; padding: 0 6px; outline: none;
      font-family: var(--vscode-font-family);
    }
    select:disabled, input[type="text"]:disabled {
      opacity: 0.6; cursor: not-allowed;
    }
    select:focus, input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
    option.runnable-false { color: var(--vscode-errorForeground); }
    .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .effective { margin-top: 16px; }
    .field { display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
    .field:last-child { border-bottom: none; }
    .field-key { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .field-value { font-size: 12px; color: var(--vscode-foreground); max-width: 60%; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .field-value.unset { color: var(--vscode-descriptionForeground); font-style: italic; }
    .badge { font-size: 9px; text-transform: uppercase; padding: 1px 4px; border-radius: 2px; margin-left: 6px; }
    .badge.explicit { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .badge.default { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .badge.unset { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); }
    .issues { margin-top: 12px; }
    .issue { font-size: 11px; padding: 5px 0; display: flex; gap: 6px; }
    .issue.error { color: var(--vscode-errorForeground); }
    .issue.warning { color: var(--vscode-editorWarning-foreground); }
    .issue.info { color: var(--vscode-descriptionForeground); }
    .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
    button {
      height: 26px; padding: 0 10px; font-size: 11px; cursor: pointer;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; outline: none;
    }
    button:focus { outline: 1px solid var(--vscode-focusBorder); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 16px 0; }
  </style>
</head>
<body>
  <div id="app">
    <h1>Configuration Lab</h1>

    <div class="section" id="harness-section">
      <h2>Harness</h2>
      <div class="row">
        <label for="harness">Adapter / harness</label>
        <select id="harness"><option value="" disabled selected>Select a harness…</option></select>
        <div class="hint" id="harness-hint">Choose the agent CLI that will run the session.</div>
      </div>
      <div id="harness-details" hidden></div>
    </div>

    <div class="section" id="config-section">
      <h2>Configuration</h2>
      <div class="row">
        <label for="model">Model</label>
        <select id="model" disabled><option value="">Select a harness first…</option></select>
      </div>
      <div class="row">
        <label for="route">Route / gateway</label>
        <select id="route" disabled><option value="">Select a model first…</option></select>
      </div>
      <div class="row">
        <label for="profile">Auth profile</label>
        <select id="profile" disabled><option value="">Select a route first…</option></select>
      </div>
      <div class="row">
        <label for="posture">Posture / mode</label>
        <select id="posture" disabled><option value="">Select a harness first…</option></select>
      </div>
      <div class="row">
        <label for="effort">Effort</label>
        <select id="effort" disabled><option value="">Select a model first…</option></select>
      </div>
    </div>

    <div class="section effective" id="effective-section">
      <h2>Effective launch configuration</h2>
      <div id="effective"><div class="empty">Select a harness to see the resolved configuration.</div></div>
    </div>

    <div class="section issues" id="issues-section" hidden>
      <h2>Validation</h2>
      <div id="issues"></div>
    </div>

    <div class="actions">
      <button id="btn-validate">Validate</button>
      <button id="btn-copy" class="secondary" disabled>Copy JSON</button>
      <button id="btn-spawn" class="secondary" disabled>Spawn with this config…</button>
    </div>
  </div>

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();

      const harnessEl = document.getElementById('harness');
      const harnessHintEl = document.getElementById('harness-hint');
      const harnessDetailsEl = document.getElementById('harness-details');
      const modelEl = document.getElementById('model');
      const routeEl = document.getElementById('route');
      const profileEl = document.getElementById('profile');
      const postureEl = document.getElementById('posture');
      const effortEl = document.getElementById('effort');
      const effectiveEl = document.getElementById('effective');
      const issuesSectionEl = document.getElementById('issues-section');
      const issuesEl = document.getElementById('issues');
      const btnValidate = document.getElementById('btn-validate');
      const btnCopy = document.getElementById('btn-copy');
      const btnSpawn = document.getElementById('btn-spawn');

      function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, function (ch) {
          return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;';
        });
      }

      function option(value, label, selected, extraClass) {
        return '<option value="' + escapeHtml(value) + '"' + (selected ? ' selected' : '') + (extraClass ? ' class="' + extraClass + '"' : '') + '>' + escapeHtml(label) + '</option>';
      }

      function renderSelect(el, items, selected, placeholder, labelFn, valueFn, classFn) {
        el.innerHTML = '';
        el.appendChild(new Option(placeholder, '', selected === undefined || selected === ''));
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var value = valueFn ? valueFn(item) : item.value;
          var label = labelFn ? labelFn(item) : item.label;
          var extraClass = classFn ? classFn(item) : '';
          var opt = new Option(label, value, false, value === selected);
          if (extraClass) opt.className = extraClass;
          el.appendChild(opt);
        }
      }

      function renderBadge(source) {
        return '<span class="badge ' + source + '" title="' + (source === 'explicit' ? 'You selected this' : source === 'default' ? 'Adapter or daemon default' : 'Not set') + '">' + escapeHtml(source) + '</span>';
      }

      function renderEffective(fields) {
        if (!fields.length) {
          effectiveEl.innerHTML = '<div class="empty">Select a harness to see the resolved configuration.</div>';
          return;
        }
        var html = '';
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i];
          var valueHtml = f.value === undefined
            ? '<span class="field-value unset">—</span>'
            : '<span class="field-value" title="' + escapeHtml(f.detail || '') + '">' + escapeHtml(f.value) + (f.detail ? ' <span style="opacity:0.7">(' + escapeHtml(f.detail) + ')</span>' : '') + '</span>';
          html += '<div class="field"><span class="field-key">' + escapeHtml(f.key) + renderBadge(f.source) + '</span>' + valueHtml + '</div>';
        }
        effectiveEl.innerHTML = html;
      }

      function renderIssues(issues) {
        if (!issues.length) {
          issuesSectionEl.hidden = true;
          issuesEl.innerHTML = '';
          return;
        }
        issuesSectionEl.hidden = false;
        var html = '';
        for (var i = 0; i < issues.length; i++) {
          var issue = issues[i];
          html += '<div class="' + escapeHtml('issue ' + issue.severity) + '" title="' + escapeHtml(issue.axis || '') + '"><span>' + escapeHtml(issue.severity === 'error' ? '✕' : issue.severity === 'warning' ? '⚠' : 'ℹ') + '</span><span>' + escapeHtml(issue.message) + '</span></div>';
        }
        issuesEl.innerHTML = html;
      }

      function renderHarnessDetails(harness) {
        if (!harness) {
          harnessDetailsEl.hidden = true;
          harnessDetailsEl.innerHTML = '';
          return;
        }
        var parts = [];
        if (harness.version) parts.push('v' + harness.version);
        if (harness.protocol) parts.push(harness.protocol);
        if (harness.capabilities && harness.capabilities.source) parts.push(harness.capabilities.source);
        var html = '<div class="hint">' + escapeHtml(parts.join(' · ')) + '</div>';
        if (harness.modes && harness.modes.length) {
          html += '<div class="hint">Modes: ' + escapeHtml(harness.modes.map(function (m) { return m.id; }).join(', ')) + '</div>';
        }
        if (harness.capabilities && harness.capabilities.models && harness.capabilities.models.defaultModel) {
          html += '<div class="hint">Default model: ' + escapeHtml(harness.capabilities.models.defaultModel) + '</div>';
        }
        harnessDetailsEl.innerHTML = html;
        harnessDetailsEl.hidden = false;
      }

      var currentSnapshot = null;

      function render(snapshot) {
        currentSnapshot = snapshot;

        populateHarnesses(snapshot.adapters || []);
        harnessEl.value = snapshot.selection.adapter || '';
        modelEl.disabled = !snapshot.selection.adapter;
        routeEl.disabled = !snapshot.selection.model;
        profileEl.disabled = !snapshot.selection.route;
        postureEl.disabled = !snapshot.selection.adapter;
        effortEl.disabled = !snapshot.selection.model;

        harnessHintEl.textContent = snapshot.harness
          ? 'Selected harness: ' + (snapshot.harness.name || snapshot.harness.slug)
          : 'Choose the agent CLI that will run the session.';
        renderHarnessDetails(snapshot.harness);

        renderSelect(modelEl, snapshot.axes.models, snapshot.selection.model, 'Select a model…',
          function (m) { return m.id + (m.provider ? ' · ' + m.provider : ''); },
          function (m) { return m.id; }
        );
        renderSelect(routeEl, snapshot.axes.routes, snapshot.selection.route, 'Select a route…',
          function (r) { return r.label + (r.curated ? ' ★' : '') + (r.runnable ? '' : ' (no profile)'); },
          function (r) { return r.value; },
          function (r) { return r.runnable ? '' : 'runnable-false'; }
        );
        renderSelect(profileEl, snapshot.axes.profiles, snapshot.selection.profile, 'Select a profile…',
          function (p) { return p.addProfile ? p.label : p.label; },
          function (p) { return p.value || ''; }
        );
        renderSelect(postureEl, snapshot.axes.postures, snapshot.selection.posture, 'Select a posture…',
          function (p) { return p.label; },
          function (p) { return p.value; }
        );
        renderSelect(effortEl, snapshot.axes.efforts, snapshot.selection.effort, 'Select effort…',
          function (e) { return e; },
          function (e) { return e; }
        );

        renderEffective(snapshot.effective);
        renderIssues(snapshot.issues);

        var hasAdapter = !!snapshot.selection.adapter;
        btnCopy.disabled = !hasAdapter;
        btnSpawn.disabled = !hasAdapter;
      }

      function bindSelect(el, type) {
        el.addEventListener('change', function () {
          var value = el.value;
          if (!value) return;
          vscode.postMessage({ type: type, [type.replace('set', '').toLowerCase()]: value });
        });
      }

      // The host sends the harness list separately so the webview doesn't need
      // the full adapter registry in every snapshot. We attach the list on first
      // snapshot and re-render.
      function populateHarnesses(adapters) {
        var selected = harnessEl.value;
        harnessEl.innerHTML = '';
        harnessEl.appendChild(new Option('Select a harness…', '', !selected));
        for (var i = 0; i < adapters.length; i++) {
          var a = adapters[i];
          harnessEl.appendChild(new Option((a.name || a.slug) + ' (' + a.slug + ')', a.slug, false, a.slug === selected));
        }
      }

      harnessEl.addEventListener('change', function () {
        if (harnessEl.value) vscode.postMessage({ type: 'setHarness', adapter: harnessEl.value });
      });
      bindSelect(modelEl, 'setModel');
      bindSelect(routeEl, 'setRoute');
      bindSelect(profileEl, 'setProfile');
      bindSelect(postureEl, 'setPosture');
      bindSelect(effortEl, 'setEffort');

      btnValidate.addEventListener('click', function () { vscode.postMessage({ type: 'validate' }); });
      btnCopy.addEventListener('click', function () { vscode.postMessage({ type: 'copyJson' }); });
      btnSpawn.addEventListener('click', function () { vscode.postMessage({ type: 'spawn' }); });

      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg || msg.type !== 'snapshot') return;
        render(msg.snapshot);
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`
}
