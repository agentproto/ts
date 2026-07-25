/**
 * Auth Profiles webview panel — the opt-in WebviewView alternative to the Auth
 * Profiles TreeView (`agentproto.authProfilesView === "webview"`). Mirrors the
 * Sessions webview's postMessage protocol and row grammar, with three
 * collapsible sections (Provider Presets / Model Profiles / Local Router),
 * real provider logos, and expandable model-profile children.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  LlmEndpointStatusResult,
  ProviderPresetEntry,
} from "../client/types.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"
import type { AuthProfileNode } from "../views/authProfilesTree.logic.js"
import {
  buildAuthProfilesWebviewModel,
  type AuthProfilesExpandedState,
  type AuthProfilesWebviewModel,
  type PresetWebviewRow,
  type ProfileWebviewRow,
  type RouterWebviewRow,
} from "./authProfilesWebview.logic.js"
import { adapterLogoFor, type AdapterLogo } from "./adapterIcon.logic.js"

const VIEW_TYPE = "agentproto.authProfilesWebview"

interface ModelMessage {
  type: "model"
  model: AuthProfilesWebviewModel
  search: string
}

type HostMessage = ModelMessage

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "filter"; search: string }
  | { type: "toggleSection"; section: "presets" | "profiles" | "router" }
  | { type: "toggleProfile"; profileId: string }
  | { type: "connect"; slug: string }
  | { type: "enable"; profileId: string }
  | { type: "disable"; profileId: string }
  | { type: "delete"; profileId: string }
  | { type: "setModels"; profileId: string }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (typeof value !== "object" || value === null) return false
  if (!("type" in value)) return false
  return typeof value.type === "string"
}

type RenderLogo =
  | { kind: "icon"; file: string; uri: string }
  | { kind: "lettermark"; text: string }

interface RenderPreset extends PresetWebviewRow {
  logo: RenderLogo
}

interface RenderProfile extends ProfileWebviewRow {
  logo: RenderLogo
}

interface RenderRouter extends RouterWebviewRow {}

interface RenderSection<T, K extends string> {
  kind: K
  label: string
  count: number | string
  expanded: boolean
  rows: T[]
}

type RenderPresetSection = RenderSection<RenderPreset, "presets">
type RenderProfileSection = RenderSection<RenderProfile, "profiles">
type RenderRouterSection = RenderSection<RenderRouter, "router">

interface RenderModel {
  kind: "model"
  product: string
  description: string
  runnable: boolean
}

class AuthProfilesWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private search = ""
  private presets: ProviderPresetEntry[] = []
  private profiles: AuthProfileSummary[] = []
  private catalog: CatalogModelsResponse = { vendors: [] }
  private routerStatus: LlmEndpointStatusResult | null = null
  private expanded: AuthProfilesExpandedState = { presets: true, profiles: true, router: false }
  private expandedProfiles = new Set<string>()

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: DaemonClient,
    private readonly treeProvider: AuthProfilesTreeProvider,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }
    webviewView.webview.html = buildHtml(randomNonce(), this.extensionUri)

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
  }

  refresh(): void {
    void this.fetch()
  }

  private async fetch(): Promise<void> {
    const [presets, catalog, profiles] = await Promise.all([
      this.client.listProviderPresets().catch((): ProviderPresetEntry[] => []),
      this.client.catalogModels().catch((): CatalogModelsResponse => ({ vendors: [] })),
      this.client.listAuthProfiles().catch((): AuthProfileSummary[] => []),
    ])
    this.presets = presets
    this.catalog = catalog
    this.profiles = profiles
    this.routerStatus = await this.client.llmEndpointStatus().catch(() => null)
    this.post()
  }

  private handleMessage(msg: WebviewToHostMessage): void {
    switch (msg.type) {
      case "ready":
        void this.fetch()
        return
      case "filter":
        this.search = msg.search
        this.post()
        return
      case "toggleSection":
        this.expanded[msg.section] = !this.expanded[msg.section]
        this.post()
        return
      case "toggleProfile": {
        if (this.expandedProfiles.has(msg.profileId)) {
          this.expandedProfiles.delete(msg.profileId)
        } else {
          this.expandedProfiles.add(msg.profileId)
        }
        this.post()
        return
      }
      case "connect": {
        const preset = this.presets.find(p => p.slug === msg.slug)
        if (preset) {
          const node: AuthProfileNode = { kind: "preset", preset, connected: false }
          void vscode.commands.executeCommand("agentproto.connectAuthProfile", node)
        }
        return
      }
      case "enable": {
        const node: AuthProfileNode = { kind: "profile", profileId: msg.profileId, routesCount: 0 }
        void vscode.commands.executeCommand("agentproto.enableAuthProfile", node)
        return
      }
      case "disable": {
        const node: AuthProfileNode = { kind: "profile", profileId: msg.profileId, routesCount: 0 }
        void vscode.commands.executeCommand("agentproto.disableAuthProfile", node)
        return
      }
      case "delete": {
        const node: AuthProfileNode = { kind: "profile", profileId: msg.profileId, routesCount: 0 }
        void vscode.commands.executeCommand("agentproto.deleteAuthProfile", node)
        return
      }
      case "setModels": {
        const node: AuthProfileNode = { kind: "profile", profileId: msg.profileId, routesCount: 0 }
        void vscode.commands.executeCommand("agentproto.setAuthProfileModels", node)
        return
      }
    }
  }

  private post(): void {
    if (!this.view) return
    const model = buildAuthProfilesWebviewModel(
      this.presets,
      this.profiles,
      this.catalog,
      this.routerStatus,
      this.search,
      this.expanded,
      this.expandedProfiles,
    )
    const message: ModelMessage = {
      type: "model",
      model: toRenderModel(model, this.view.webview, this.extensionUri),
      search: this.search,
    }
    void this.view.webview.postMessage(message satisfies HostMessage)
  }
}

export function registerAuthProfilesWebview(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  treeProvider: AuthProfilesTreeProvider,
): void {
  const provider = new AuthProfilesWebviewProvider(ctx.extensionUri, client, treeProvider)
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider),
    treeProvider.onDidChangeTreeData(() => provider.refresh()),
  )
}

function randomNonce(): string {
  return randomBytes(16).toString("hex")
}

function toRenderLogo(logo: AdapterLogo, webview: vscode.Webview, extensionUri: vscode.Uri): RenderLogo {
  if (logo.kind === "lettermark") return logo
  const uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "icons", "adapters", logo.file))
  return { kind: "icon", file: logo.file, uri: uri.toString() }
}

function toRenderModel(
  model: AuthProfilesWebviewModel,
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): { presets: RenderPresetSection; profiles: RenderProfileSection; router: RenderRouterSection } {
  return {
    presets: {
      kind: "presets",
      label: model.presets.label,
      count: model.presets.count,
      expanded: model.presets.expanded,
      rows: model.presets.rows.map(r => ({ ...r, logo: toRenderLogo(r.logo, webview, extensionUri) })),
    },
    profiles: {
      kind: "profiles",
      label: model.profiles.label,
      count: model.profiles.count,
      expanded: model.profiles.expanded,
      rows: model.profiles.rows.map(r => ({
        ...r,
        logo: toRenderLogo(r.logo, webview, extensionUri),
        children: r.children.map(toRenderModelRow),
      })),
    },
    router: {
      kind: "router",
      label: model.router.label,
      count: model.router.count,
      expanded: model.router.expanded,
      rows: model.router.rows,
    },
  }
}

function toRenderModelRow(model: { product: string; description: string; runnable: boolean }): RenderModel {
  return { kind: "model", product: model.product, description: model.description, runnable: model.runnable }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => {
    return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
  })
}

export function buildHtml(nonce: string, extensionUri: vscode.Uri): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ")

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>agentproto auth profiles</title>
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
    #search { flex: 0 0 auto; position: relative; margin: 10px 12px 0; }
    #search .mag {
      position: absolute; left: 2px; top: 50%; transform: translateY(-50%);
      color: var(--vscode-descriptionForeground); font-size: 13px; pointer-events: none;
    }
    #q {
      width: 100%; height: 26px; background: transparent; border: none;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      color: var(--vscode-input-foreground, var(--vscode-foreground));
      font-size: 13px; padding: 0 16px 0 18px; outline: none;
      font-family: var(--vscode-font-family);
    }
    #q::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
    #q:focus { border-bottom-color: var(--vscode-focusBorder); }
    #clear {
      position: absolute; right: 0; top: 50%; transform: translateY(-50%);
      color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 11px; display: none;
    }
    #clear.show { display: block; }
    #summary { flex: 0 0 auto; padding: 6px 12px 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
    #list { flex: 1 1 auto; overflow-y: auto; }
    .section { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); }
    .section:last-child { border-bottom: none; }
    .section-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 7px 12px 6px; cursor: pointer; user-select: none;
    }
    .section-header:hover { background: var(--vscode-list-hoverBackground); }
    .section-header .htitle {
      font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 6px;
      text-transform: uppercase;
    }
    .section-header .chev { font-size: 9px; opacity: 0.7; transform: rotate(90deg); display: inline-block; width: 10px; }
    .section-header.collapsed .chev { transform: rotate(0deg); }
    .section-header .c { font-weight: 400; color: var(--vscode-descriptionForeground); opacity: 0.75; font-size: 10px; }
    .row {
      position: relative; padding: 7px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      cursor: default; display: grid; grid-template-columns: 10px 20px 1fr auto; column-gap: 8px; align-items: center;
    }
    .row:last-child { border-bottom: none; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.sub {
      padding-left: 34px; grid-template-columns: 8px 18px 1fr auto;
      border-bottom: 1px solid transparent;
    }
    .row.sub .name { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .row.sub .dot { width: 5px; height: 5px; opacity: 0.7; }
    .dot { width: 7px; height: 7px; border-radius: 50%; justify-self: center; }
    .dot.ready { background: var(--vscode-charts-green, #2ea043); }
    .dot.available { background: var(--vscode-editorWarning-foreground, #cca700); opacity: 0.9; }
    .dot.unconnected { width: 6px; height: 6px; border: 1.5px solid var(--vscode-descriptionForeground); background: transparent; opacity: 0.8; }
    .dot.dim { background: var(--vscode-descriptionForeground); opacity: 0.45; }
    .logo { width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; color: var(--vscode-foreground); }
    .logo.svg svg { width: 14px; height: 14px; display: block; }
    .logo.img img { width: 15px; height: 15px; object-fit: contain; border-radius: 3px; }
    .logo.mono {
      width: 16px; height: 16px; border-radius: 50%; background: rgba(255,255,255,0.08);
      font-size: 9px; font-weight: 700; letter-spacing: -0.02em;
    }
    .logo.check { width: 14px; height: 14px; border-radius: 50%; background: rgba(255,255,255,0.08); font-size: 8px; display: flex; align-items: center; justify-content: center; }
    .mid { min-width: 0; }
    .name { font-size: 12.5px; font-weight: 550; letter-spacing: -0.01em; color: var(--vscode-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .desc { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
    .desc .pipe { opacity: 0.5; margin: 0 4px; }
    .right { font-size: 10.5px; color: var(--vscode-descriptionForeground); text-align: right; white-space: nowrap; }
    .right.install {
      font-size: 10px; color: var(--vscode-textLink-foreground, #8fc2ff); border: 1px solid rgba(143,194,255,0.35);
      padding: 1px 6px; border-radius: 3px; opacity: 0.9; cursor: pointer;
    }
    .row:not(:hover) .right.install { opacity: 0.55; }
    #empty { padding: 32px 16px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
    #empty[hidden] { display: none; }
    .profile-actions { display: none; gap: 4px; }
    .row:hover .profile-actions { display: flex; }
    .profile-actions span { cursor: pointer; color: var(--vscode-descriptionForeground); }
    .profile-actions span:hover { color: var(--vscode-foreground); }
  </style>
</head>
<body>
  <div id="search">
    <span class="mag" aria-hidden="true">⌕</span>
    <input id="q" placeholder="Filter profiles / providers…" autocomplete="off" />
    <span id="clear" title="Clear filter">✕</span>
  </div>
  <div id="summary"></div>
  <div id="list"></div>
  <div id="empty" hidden>Nothing matches.</div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const qEl = document.getElementById('q');
      const clearEl = document.getElementById('clear');
      const listEl = document.getElementById('list');
      const emptyEl = document.getElementById('empty');
      const summaryEl = document.getElementById('summary');

      function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, function (ch) {
          return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;';
        });
      }

      function logoHtml(logo) {
        if (logo.kind === 'lettermark') {
          return '<span class="logo mono">' + escapeHtml(logo.text) + '</span>';
        }
        if (logo.file.endsWith('.svg')) {
          return '<span class="logo svg" data-src="' + escapeHtml(logo.uri) + '" data-file="' + escapeHtml(logo.file) + '"></span>';
        }
        return '<span class="logo img"><img src="' + escapeHtml(logo.uri) + '" alt="" /></span>';
      }

      function loadSvg(el) {
        if (!el || el.dataset.loaded) return;
        fetch(el.dataset.src)
          .then(function (res) { return res.text(); })
          .then(function (svg) {
            el.innerHTML = svg;
            el.dataset.loaded = '1';
            var svgEl = el.querySelector('svg');
            if (svgEl) {
              svgEl.setAttribute('width', '14');
              svgEl.setAttribute('height', '14');
              if (el.dataset.file !== 'claude.svg') {
                svgEl.style.color = 'var(--vscode-foreground)';
              }
            }
          })
          .catch(function () {});
      }

      function descHtml(text) {
        return escapeHtml(text).replace(/ · /g, '<span class="pipe">·</span>');
      }

      function presetRowHTML(r) {
        return '<div class="row" data-slug="' + escapeHtml(r.slug) + '" data-kind="preset">' +
          '<span class="dot ' + (r.connected ? 'ready' : 'unconnected') + '"></span>' +
          logoHtml(r.logo) +
          '<div class="mid">' +
            '<div class="name">' + escapeHtml(r.name) + '</div>' +
            '<div class="desc">' + descHtml(r.description) + '</div>' +
          '</div>' +
        '</div>';
      }

      function modelRowHTML(r) {
        return '<div class="row sub">' +
          '<span class="dot"></span>' +
          '<span class="logo check">' + (r.runnable ? '✓' : '') + '</span>' +
          '<div class="mid">' +
            '<div class="name">' + escapeHtml(r.product) + '</div>' +
          '</div>' +
          '<span class="right">' + descHtml(r.description) + '</span>' +
        '</div>';
      }

      function profileRowHTML(r) {
        var actions = '<span class="profile-actions">' +
          '<span title="Set allowed models" data-set-models="' + escapeHtml(r.profileId) + '">+</span>' +
          '<span title="' + (r.enabled ? 'Disable' : 'Enable') + '" data-toggle="' + escapeHtml(r.profileId) + '">' + (r.enabled ? '⊘' : '✓') + '</span>' +
          '<span title="Delete" data-delete="' + escapeHtml(r.profileId) + '">🗑</span>' +
          '</span>';
        return '<div class="row" data-profile-id="' + escapeHtml(r.profileId) + '" data-kind="profile" data-enabled="' + r.enabled + '">' +
          '<span class="dot ' + (r.enabled ? 'ready' : 'dim') + '"></span>' +
          logoHtml(r.logo) +
          '<div class="mid">' +
            '<div class="name">' + escapeHtml(r.name) + '</div>' +
            '<div class="desc">' + descHtml(r.description) + '</div>' +
          '</div>' +
          '<div class="right">' + actions + '</div>' +
        '</div>' +
        (r.expanded ? r.children.map(modelRowHTML).join('') : '');
      }

      function routerRowHTML(r) {
        return '<div class="row" data-kind="router">' +
          '<span class="dot ' + r.status + '"></span>' +
          '<div class="mid" style="grid-column: 3 / 5;">' +
            '<div class="name">' + escapeHtml(r.name) + '</div>' +
            (r.description ? '<div class="desc">' + escapeHtml(r.description) + '</div>' : '') +
          '</div>' +
        '</div>';
      }

      function sectionHTML(section) {
        var headerClass = 'section-header' + (section.expanded ? '' : ' collapsed');
        var html = '<div class="section" data-section="' + section.kind + '">' +
          '<div class="' + headerClass + '">' +
            '<span class="htitle"><span class="chev">›</span>' + escapeHtml(section.label) + '</span>' +
            '<span class="c">' + escapeHtml(String(section.count)) + '</span>' +
          '</div>';
        if (section.expanded) {
          html += '<div class="list" data-list="' + section.kind + '" style="display:flex;flex-direction:column;">';
          for (var i = 0; i < section.rows.length; i++) {
            if (section.kind === 'presets') html += presetRowHTML(section.rows[i]);
            else if (section.kind === 'profiles') html += profileRowHTML(section.rows[i]);
            else html += routerRowHTML(section.rows[i]);
          }
          html += '</div>';
        }
        html += '</div>';
        return html;
      }

      function render(payload) {
        var html = sectionHTML(payload.model.presets) + sectionHTML(payload.model.profiles) + sectionHTML(payload.model.router);
        listEl.innerHTML = html;
        var totalRows = payload.model.presets.rows.length + payload.model.profiles.rows.length + payload.model.router.rows.length;
        emptyEl.hidden = totalRows !== 0;
        summaryEl.textContent = payload.search.trim().length > 0
          ? totalRows + ' shown'
          : '';
        var svgs = listEl.querySelectorAll('.logo.svg');
        for (var j = 0; j < svgs.length; j++) loadSvg(svgs[j]);
      }

      listEl.addEventListener('click', function (e) {
        var sectionHeader = e.target.closest('.section-header');
        if (sectionHeader) {
          var section = sectionHeader.parentElement.dataset.section;
          vscode.postMessage({ type: 'toggleSection', section: section });
          return;
        }
        var profileRow = e.target.closest('[data-kind="profile"]');
        if (profileRow) {
          var setModelsBtn = e.target.closest('[data-set-models]');
          if (setModelsBtn) {
            vscode.postMessage({ type: 'setModels', profileId: setModelsBtn.getAttribute('data-set-models') });
            return;
          }
          var toggleBtn = e.target.closest('[data-toggle]');
          if (toggleBtn) {
            var row = toggleBtn.closest('[data-kind="profile"]');
            var enabled = row.getAttribute('data-enabled') === 'true';
            vscode.postMessage({ type: enabled ? 'disable' : 'enable', profileId: toggleBtn.getAttribute('data-toggle') });
            return;
          }
          var deleteBtn = e.target.closest('[data-delete]');
          if (deleteBtn) {
            vscode.postMessage({ type: 'delete', profileId: deleteBtn.getAttribute('data-delete') });
            return;
          }
          vscode.postMessage({ type: 'toggleProfile', profileId: profileRow.getAttribute('data-profile-id') });
          return;
        }
        var presetRow = e.target.closest('[data-kind="preset"]');
        if (presetRow) {
          vscode.postMessage({ type: 'connect', slug: presetRow.getAttribute('data-slug') });
          return;
        }
      });

      var filterTimer = null;
      qEl.addEventListener('input', function () {
        clearEl.classList.toggle('show', qEl.value.length > 0);
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(function () {
          vscode.postMessage({ type: 'filter', search: qEl.value.trim() });
        }, 120);
      });
      clearEl.addEventListener('click', function () {
        qEl.value = '';
        clearEl.classList.remove('show');
        vscode.postMessage({ type: 'filter', search: '' });
        qEl.focus();
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
