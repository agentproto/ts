/**
 * Wallets webview panel — the opt-in WebviewView alternative to the Auth
 * Profiles TreeView (`agentproto.authProfilesView === "webview"`). Groups auth
 * profiles into provider columns (wallet-first, same model as the Auth &
 * Model Map): a provider header with subscription/API-key summary pills, then
 * one card per wallet, folding long-tail providers behind "more" at
 * `DEFAULT_PROVIDER_COUNT`. Providers with no wallet yet surface separately
 * with a one-click Connect.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type {
  AuthProfileSummary,
  LlmEndpointStatusResult,
  ProviderPresetEntry,
} from "../client/types.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"
import { profileCuratedIds, type AuthProfileNode } from "../views/authProfilesTree.logic.js"
import {
  buildAuthProfilesWebviewModel,
  type AuthProfilesExpandedState,
  type AuthProfilesWebviewModel,
  type ProviderWebviewRow,
  type RouterWebviewRow,
  type UnconnectedProviderRow,
} from "./authProfilesWebview.logic.js"
import { adapterLogoFor, type AdapterLogo } from "./adapterIcon.logic.js"
import {
  buildCreateRequest,
  suggestProfileId,
  successMessage,
  validateCredential,
  validateProfileId,
} from "../commands/authProfileFlow.logic.js"
import {
  buildModelPickItems,
  resolveModelSelection,
} from "../commands/authProfileModelPicker.logic.js"

const VIEW_TYPE = "agentproto.authProfilesWebview"

interface ModelMessage {
  type: "model"
  model: RenderModel
  search: string
}

interface SetModelsDialogMessage {
  type: "setModelsDialog"
  profileId: string
  items: { id: string; label: string; description?: string; detail?: string; picked: boolean }[]
}

interface ConnectDialogMessage {
  type: "connectDialog"
  slug: string
  suggestedId: string
  name: string
}

type HostMessage = ModelMessage | SetModelsDialogMessage | ConnectDialogMessage

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "filter"; search: string }
  | { type: "toggleSection"; section: "providers" | "router" }
  | { type: "toggleMoreProviders" }
  | { type: "connect"; slug: string; id: string; label?: string }
  | { type: "requestConnect"; slug: string }
  | { type: "enable"; profileId: string }
  | { type: "disable"; profileId: string }
  | { type: "delete"; profileId: string }
  | { type: "setModels"; profileId: string; ids: string[] }
  | { type: "requestSetModels"; profileId: string }
  | { type: "openMap" }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (typeof value !== "object" || value === null) return false
  if (!("type" in value)) return false
  return typeof value.type === "string"
}

type RenderLogo =
  | { kind: "icon"; file: string; uri: string }
  | { kind: "lettermark"; text: string }

interface RenderProvider extends Omit<ProviderWebviewRow, "logo"> {
  logo: RenderLogo
}

interface RenderUnconnected extends Omit<UnconnectedProviderRow, "logo"> {
  logo: RenderLogo
}

interface RenderSection<T, K extends string> {
  kind: K
  label: string
  count: number | string
  expanded: boolean
  rows: T[]
}

interface RenderModel {
  providers: RenderSection<RenderProvider, "providers">
  unconnected: RenderUnconnected[]
  moreCount: number
  router: RenderSection<RouterWebviewRow, "router">
}

class AuthProfilesWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private search = ""
  private presets: ProviderPresetEntry[] = []
  private profiles: AuthProfileSummary[] = []
  private routerStatus: LlmEndpointStatusResult | null = null
  private expanded: AuthProfilesExpandedState = { providers: true, router: false }
  private showAllProviders = false

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
  }

  refresh(): void {
    void this.fetch()
  }

  private async fetch(): Promise<void> {
    const [presets, profiles] = await Promise.all([
      this.client.listProviderPresets().catch((): ProviderPresetEntry[] => []),
      this.client.listAuthProfiles().catch((): AuthProfileSummary[] => []),
    ])
    this.presets = presets
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
      case "toggleMoreProviders":
        this.showAllProviders = !this.showAllProviders
        this.post()
        return
      case "openMap": {
        void vscode.commands.executeCommand("agentproto.openAuthModel")
        return
      }
      case "requestConnect": {
        void this.openConnectDialog(msg.slug)
        return
      }
      case "connect": {
        void this.runConnectPresetFlow(msg.slug, msg.id, msg.label)
        return
      }
      case "requestSetModels": {
        void this.openSetModelsDialog(msg.profileId)
        return
      }
      case "setModels": {
        void this.applySetModels(msg.profileId, msg.ids)
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
    }
  }

  private post(): void {
    if (!this.view) return
    const model = buildAuthProfilesWebviewModel(
      this.presets,
      this.profiles,
      this.routerStatus,
      this.search,
      this.expanded,
      this.showAllProviders,
    )
    const message: ModelMessage = {
      type: "model",
      model: toRenderModel(model, this.view.webview, this.extensionUri),
      search: this.search,
    }
    void this.view.webview.postMessage(message satisfies HostMessage)
  }

  private async openConnectDialog(slug: string): Promise<void> {
    if (!this.view) return
    const preset = this.presets.find(p => p.slug === slug)
    const name = preset?.name?.trim() || slug
    const suggestedId = suggestProfileId("api-key", slug)
    const message: ConnectDialogMessage = { type: "connectDialog", slug, suggestedId, name }
    void this.view.webview.postMessage(message)
  }

  private async openSetModelsDialog(profileId: string): Promise<void> {
    if (!this.view) return
    const summary = this.profiles.find(p => p.id === profileId)
    if (!summary) return
    let models: Awaited<ReturnType<DaemonClient["getCatalogProviderModels"]>> = { provider: summary.endpoint, models: [] }
    try {
      models = await this.client.getCatalogProviderModels(summary.endpoint)
    } catch {
      // Fall through to empty list — the dialog will show nothing to pick.
    }
    const current = profileCuratedIds(summary)
    const items = buildModelPickItems(models.models, current).map(i => ({
      id: i.id,
      label: i.label,
      description: i.description,
      detail: i.detail,
      picked: i.picked,
    }))
    const message: SetModelsDialogMessage = { type: "setModelsDialog", profileId, items }
    void this.view.webview.postMessage(message)
  }

  private async applySetModels(profileId: string, ids: string[]): Promise<void> {
    const write = resolveModelSelection(ids)
    try {
      await this.client.setAuthProfileModels(profileId, write.mode, write.ids)
      void vscode.window.showInformationMessage(
        write.mode === "all"
          ? `"${profileId}" now allows all eligible models.`
          : `"${profileId}" now allows ${write.ids.length} model${write.ids.length === 1 ? "" : "s"}.`,
      )
      await this.treeProvider.refresh()
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not set allowed models for "${profileId}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private async runConnectPresetFlow(slug: string, id: string, label?: string): Promise<void> {
    const trimmedId = id.trim()
    if (!trimmedId) {
      void vscode.window.showErrorMessage("Profile id is required.")
      return
    }
    const existingIds = this.profiles.map(p => p.id)
    const idError = validateProfileId(trimmedId, existingIds)
    if (idError) {
      void vscode.window.showErrorMessage(idError)
      return
    }
    const credential = await vscode.window.showInputBox({
      title: `Connect ${slug}: credential`,
      prompt: `Paste the ${slug} API key`,
      password: true,
      ignoreFocusOut: true,
      validateInput: validateCredential,
    })
    if (!credential) return
    const request = buildCreateRequest({
      id: trimmedId,
      endpoint: slug,
      method: "api-key",
      credential,
      label: label?.trim(),
    })
    try {
      const created = await this.client.createAuthProfile(request)
      void vscode.window.showInformationMessage(successMessage(created))
      await this.treeProvider.refresh()
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not connect ${slug}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
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
): RenderModel {
  return {
    providers: {
      kind: "providers",
      label: model.providers.label,
      count: model.providers.count,
      expanded: model.providers.expanded,
      rows: model.providers.rows.map(r => toRenderProvider(r, webview, extensionUri)),
    },
    unconnected: model.unconnected.map(u => ({ ...u, logo: toRenderLogo(u.logo, webview, extensionUri) })),
    moreCount: model.moreCount,
    router: {
      kind: "router",
      label: model.router.label,
      count: model.router.count,
      expanded: model.router.expanded,
      rows: model.router.rows,
    },
  }
}

function toRenderProvider(row: ProviderWebviewRow, webview: vscode.Webview, extensionUri: vscode.Uri): RenderProvider {
  return { ...row, logo: toRenderLogo(row.logo, webview, extensionUri) }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => {
    return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
  })
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
  <title>agentproto wallets</title>
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
    #maplink {
      display: block; width: calc(100% - 24px); margin: 8px 12px 0; text-align: left;
      background: transparent; border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.35));
      color: var(--vscode-textLink-foreground, #8fc2ff); font-family: inherit; font-size: 11px;
      padding: 5px 8px; border-radius: 4px; cursor: pointer;
    }
    #maplink:hover { border-color: var(--vscode-textLink-foreground, #8fc2ff); }
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
    .provider-group { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
    .provider-group:last-child { border-bottom: none; }
    .provider-header { display: flex; align-items: center; gap: 8px; padding: 3px 12px; }
    .provider-header .pname { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
    .provider-header .native { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.8; margin-left: 2px; }
    .provider-pills { margin-left: auto; display: flex; gap: 4px; }
    .ppill { font-size: 9px; font-weight: 600; letter-spacing: 0.02em; padding: 1px 6px; border-radius: 99px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .ppill.sub { color: var(--vscode-charts-green, #2ea043); border-color: currentColor; }
    .ppill.key { color: var(--vscode-charts-blue, #3794ff); border-color: currentColor; }
    .logo { width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; color: var(--vscode-foreground); flex: 0 0 auto; }
    .logo.svg svg { width: 14px; height: 14px; display: block; }
    .logo.img img { width: 15px; height: 15px; object-fit: contain; border-radius: 3px; }
    .logo.mono {
      width: 16px; height: 16px; border-radius: 50%; background: rgba(255,255,255,0.08);
      font-size: 9px; font-weight: 700; letter-spacing: -0.02em; display: flex; align-items: center; justify-content: center;
    }
    .wcard { margin: 4px 12px 0 34px; padding: 6px 8px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-radius: 6px; position: relative; }
    .wcard:hover { background: var(--vscode-list-hoverBackground); }
    .wtop { display: flex; align-items: center; gap: 6px; }
    .wtop .dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
    .wtop .dot.self-refreshing { background: var(--vscode-charts-green, #2ea043); }
    .wtop .dot.stored { background: var(--vscode-editorWarning-foreground, #cca700); }
    .wtop .dot.unavailable { background: var(--vscode-errorForeground, #f14c4c); }
    .wname { font-size: 12px; font-weight: 550; color: var(--vscode-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .kchip { margin-left: auto; font-size: 8.5px; font-weight: 700; letter-spacing: 0.03em; padding: 1px 6px; border-radius: 99px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); white-space: nowrap; }
    .kchip.sub { color: var(--vscode-charts-green, #2ea043); border-color: currentColor; }
    .kchip.key { color: var(--vscode-charts-blue, #3794ff); border-color: currentColor; }
    .wmeta { font-size: 10.5px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
    .wactions { display: none; gap: 6px; position: absolute; top: 6px; right: 8px; }
    .wcard:hover .wactions { display: flex; }
    .wactions span { cursor: pointer; color: var(--vscode-descriptionForeground); }
    .wactions span:hover { color: var(--vscode-foreground); }
    .grouplabel { font-size: 9.5px; font-weight: 600; letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); opacity: 0.75; text-transform: uppercase; padding: 8px 12px 2px; }
    .morebtn { width: calc(100% - 24px); margin: 6px 12px 0; font: 600 10px var(--vscode-font-family); padding: 6px; border-radius: 6px; border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.35)); background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; }
    .morebtn:hover { color: var(--vscode-foreground); border-color: var(--vscode-descriptionForeground); }
    .connect-row {
      position: relative; padding: 6px 12px; cursor: pointer; display: grid;
      grid-template-columns: 20px 1fr auto; column-gap: 8px; align-items: center;
    }
    .connect-row:hover { background: var(--vscode-list-hoverBackground); }
    .connect-row .cname { font-size: 12px; color: var(--vscode-foreground); }
    .connect-row .caction { font-size: 10px; color: var(--vscode-textLink-foreground, #8fc2ff); border: 1px solid rgba(143,194,255,0.35); padding: 1px 6px; border-radius: 3px; opacity: 0.9; }
    .row {
      position: relative; padding: 7px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      cursor: default; display: grid; grid-template-columns: 10px 1fr; column-gap: 8px; align-items: center;
    }
    .row:last-child { border-bottom: none; }
    .dot { width: 7px; height: 7px; border-radius: 50%; justify-self: center; }
    .dot.ready { background: var(--vscode-charts-green, #2ea043); }
    .dot.available { background: var(--vscode-editorWarning-foreground, #cca700); opacity: 0.9; }
    .dot.unconnected { width: 6px; height: 6px; border: 1.5px solid var(--vscode-descriptionForeground); background: transparent; opacity: 0.8; }
    .dot.dim { background: var(--vscode-descriptionForeground); opacity: 0.45; }
    .mid { min-width: 0; }
    .name { font-size: 12.5px; font-weight: 550; letter-spacing: -0.01em; color: var(--vscode-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .desc { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
    #empty { padding: 32px 16px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
    #empty[hidden] { display: none; }
    .dialog-backdrop {
      position: absolute; inset: 0; z-index: 20;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      display: none; flex-direction: column;
    }
    .dialog-backdrop.show { display: flex; }
    .dialog { flex: 1 1 auto; display: flex; flex-direction: column; padding: 12px; }
    .dialog-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; color: var(--vscode-foreground); }
    .dialog-body { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
    .dialog-input {
      width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-panel-border); padding: 4px 6px; margin-bottom: 10px;
      font-family: inherit; font-size: 12px;
    }
    .dialog-input:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
    .model-list { flex: 1 1 auto; overflow-y: auto; border: 1px solid var(--vscode-panel-border); padding: 4px 0; }
    .model-item { display: flex; align-items: flex-start; gap: 8px; padding: 4px 8px; cursor: pointer; }
    .model-item:hover { background: var(--vscode-list-hoverBackground); }
    .model-item input { flex: 0 0 auto; margin-top: 2px; }
    .model-item .label-col { min-width: 0; }
    .model-item .label { font-size: 12px; color: var(--vscode-foreground); }
    .model-item .detail { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .dialog-actions { flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 8px; padding-top: 10px; }
    .dialog-actions button { padding: 3px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; font-family: inherit; font-size: 12px; }
    .dialog-actions button:hover { background: var(--vscode-button-hoverBackground); }
    .dialog-actions button.secondary { background: transparent; color: var(--vscode-foreground); }
    .dialog-actions button.secondary:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
</head>
<body>
  <div id="search">
    <span class="mag" aria-hidden="true">⌕</span>
    <input id="q" placeholder="Filter wallets / providers…" autocomplete="off" />
    <span id="clear" title="Clear filter">✕</span>
  </div>
  <div id="summary"></div>
  <button id="maplink" title="Open the full auth &amp; model configuration map">↗ open Auth &amp; Model Map</button>
  <div id="list"></div>
  <div id="empty" hidden>Nothing matches.</div>
  <div id="dialog-backdrop" class="dialog-backdrop">
    <div class="dialog">
      <div id="dialog-title" class="dialog-title"></div>
      <div id="dialog-body" class="dialog-body"></div>
      <div class="dialog-actions">
        <button id="dialog-cancel" class="secondary">Cancel</button>
        <button id="dialog-confirm">Confirm</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const qEl = document.getElementById('q');
      const clearEl = document.getElementById('clear');
      const listEl = document.getElementById('list');
      const emptyEl = document.getElementById('empty');
      const summaryEl = document.getElementById('summary');
      const mapEl = document.getElementById('maplink');
      const dialogBackdrop = document.getElementById('dialog-backdrop');
      const dialogTitle = document.getElementById('dialog-title');
      const dialogBody = document.getElementById('dialog-body');
      const dialogConfirm = document.getElementById('dialog-confirm');
      const dialogCancel = document.getElementById('dialog-cancel');

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

      function kindClass(k) { return k === 'api-key' ? 'key' : 'sub'; }
      function kindLabel(k) {
        return k === 'subscription-refreshing' ? 'SUB · SELF-REFRESH' : k === 'subscription-stored' ? 'SUB · STORED' : 'API KEY';
      }

      function walletCardHTML(w) {
        var actions = '<span class="wactions">' +
          '<span title="Set allowed models" data-set-models="' + escapeHtml(w.id) + '">+</span>' +
          '<span title="' + (w.enabled ? 'Disable' : 'Enable') + '" data-toggle="' + escapeHtml(w.id) + '">' + (w.enabled ? '⊘' : '✓') + '</span>' +
          '<span title="Delete" data-delete="' + escapeHtml(w.id) + '">🗑</span>' +
          '</span>';
        return '<div class="wcard" data-profile-id="' + escapeHtml(w.id) + '" data-enabled="' + w.enabled + '">' +
          '<div class="wtop">' +
            '<span class="dot ' + escapeHtml(w.keyStatus || 'stored') + '"></span>' +
            '<span class="wname">' + escapeHtml(w.label) + '</span>' +
            '<span class="kchip ' + kindClass(w.accessKind) + '">' + kindLabel(w.accessKind) + '</span>' +
          '</div>' +
          '<div class="wmeta">' + escapeHtml(w.credential) + ' · ' + escapeHtml(w.models) + (w.enabled ? '' : ' · disabled') + '</div>' +
          actions +
        '</div>';
      }

      function providerGroupHTML(p) {
        var pills = '';
        if (p.subscriptionCount) pills += '<span class="ppill sub">SUBSCRIPTION ×' + p.subscriptionCount + '</span>';
        if (p.apiKeyCount) pills += '<span class="ppill key">API KEY ×' + p.apiKeyCount + '</span>';
        var html = '<div class="provider-group">' +
          '<div class="provider-header">' +
            logoHtml(p.logo) +
            '<span class="pname">' + escapeHtml(p.endpoint) + '</span>' +
            '<span class="native">' + escapeHtml(p.native) + '</span>' +
            '<span class="provider-pills">' + pills + '</span>' +
          '</div>';
        for (var i = 0; i < p.wallets.length; i++) html += walletCardHTML(p.wallets[i]);
        html += '</div>';
        return html;
      }

      function connectRowHTML(u) {
        return '<div class="connect-row" data-slug="' + escapeHtml(u.slug) + '">' +
          logoHtml(u.logo) +
          '<span class="cname">' + escapeHtml(u.name) + '</span>' +
          '<span class="caction">Connect</span>' +
        '</div>';
      }

      function routerRowHTML(r) {
        return '<div class="row" data-kind="router">' +
          '<span class="dot ' + r.status + '"></span>' +
          '<div class="mid">' +
            '<div class="name">' + escapeHtml(r.name) + '</div>' +
            (r.description ? '<div class="desc">' + escapeHtml(r.description) + '</div>' : '') +
          '</div>' +
        '</div>';
      }

      function providersSectionHTML(section, unconnected, moreCount) {
        var headerClass = 'section-header' + (section.expanded ? '' : ' collapsed');
        var html = '<div class="section" data-section="providers">' +
          '<div class="' + headerClass + '">' +
            '<span class="htitle"><span class="chev">›</span>' + escapeHtml(section.label) + '</span>' +
            '<span class="c">' + escapeHtml(String(section.count)) + '</span>' +
          '</div>';
        if (section.expanded) {
          html += '<div class="list" data-list="providers">';
          for (var i = 0; i < section.rows.length; i++) html += providerGroupHTML(section.rows[i]);
          if (moreCount > 0) {
            html += '<button class="morebtn" data-action="toggleMoreProviders">▾ ' + moreCount + ' more provider' + (moreCount === 1 ? '' : 's') + '</button>';
          }
          if (unconnected.length > 0) {
            html += '<div class="grouplabel">Connect a provider</div>';
            for (var j = 0; j < unconnected.length; j++) html += connectRowHTML(unconnected[j]);
          }
          html += '</div>';
        }
        html += '</div>';
        return html;
      }

      function routerSectionHTML(section) {
        var headerClass = 'section-header' + (section.expanded ? '' : ' collapsed');
        var html = '<div class="section" data-section="router">' +
          '<div class="' + headerClass + '">' +
            '<span class="htitle"><span class="chev">›</span>' + escapeHtml(section.label) + '</span>' +
            '<span class="c">' + escapeHtml(String(section.count)) + '</span>' +
          '</div>';
        if (section.expanded) {
          html += '<div class="list" data-list="router">';
          for (var i = 0; i < section.rows.length; i++) html += routerRowHTML(section.rows[i]);
          html += '</div>';
        }
        html += '</div>';
        return html;
      }

      function render(payload) {
        var m = payload.model;
        var html = providersSectionHTML(m.providers, m.unconnected, m.moreCount) + routerSectionHTML(m.router);
        listEl.innerHTML = html;
        var totalRows = m.providers.rows.length + m.unconnected.length + m.router.rows.length;
        emptyEl.hidden = totalRows !== 0;
        summaryEl.textContent = payload.search.trim().length > 0 ? totalRows + ' shown' : '';
        var svgs = listEl.querySelectorAll('.logo.svg');
        for (var j = 0; j < svgs.length; j++) loadSvg(svgs[j]);
      }

      var dialogState = { mode: 'none', profileId: null, slug: null };

      function hideDialog() {
        dialogState = { mode: 'none', profileId: null, slug: null };
        dialogBackdrop.classList.remove('show');
        dialogBody.innerHTML = '';
      }

      function showSetModelsDialog(payload) {
        dialogState = { mode: 'setModels', profileId: payload.profileId, slug: null };
        dialogTitle.textContent = 'Allowed models for ' + escapeHtml(payload.profileId);
        dialogConfirm.textContent = 'Save';
        var html = '<div class="model-list">';
        for (var i = 0; i < payload.items.length; i++) {
          var item = payload.items[i];
          var detail = item.detail ? '<div class="detail">' + escapeHtml(item.detail) + '</div>' : '';
          var desc = item.description ? '<div class="detail">' + escapeHtml(item.description) + '</div>' : '';
          html += '<label class="model-item">' +
            '<input type="checkbox" data-model-id="' + escapeHtml(item.id) + '"' + (item.picked ? ' checked' : '') + ' />' +
            '<span class="label-col"><div class="label">' + escapeHtml(item.label) + '</div>' + desc + detail + '</span>' +
            '</label>';
        }
        html += '</div>';
        dialogBody.innerHTML = html;
        dialogBackdrop.classList.add('show');
      }

      function showConnectDialog(payload) {
        dialogState = { mode: 'connect', profileId: null, slug: payload.slug };
        dialogTitle.textContent = 'Connect ' + escapeHtml(payload.name);
        dialogConfirm.textContent = 'Connect';
        dialogBody.innerHTML =
          '<label>Profile id</label>' +
          '<input id="connect-id" class="dialog-input" value="' + escapeHtml(payload.suggestedId) + '" />' +
          '<label>Label (optional)</label>' +
          '<input id="connect-label" class="dialog-input" placeholder="e.g. ' + escapeHtml(payload.name) + ' API Key" />';
        dialogBackdrop.classList.add('show');
        document.getElementById('connect-id').focus();
      }

      dialogCancel.addEventListener('click', hideDialog);
      dialogConfirm.addEventListener('click', function () {
        if (dialogState.mode === 'setModels') {
          var checked = dialogBody.querySelectorAll('input[type="checkbox"]:checked');
          var ids = [];
          for (var i = 0; i < checked.length; i++) ids.push(checked[i].getAttribute('data-model-id'));
          vscode.postMessage({ type: 'setModels', profileId: dialogState.profileId, ids: ids });
          hideDialog();
        } else if (dialogState.mode === 'connect') {
          var idEl = document.getElementById('connect-id');
          var labelEl = document.getElementById('connect-label');
          var id = idEl ? idEl.value.trim() : '';
          if (!id) return;
          vscode.postMessage({ type: 'connect', slug: dialogState.slug, id: id, label: labelEl ? labelEl.value.trim() : undefined });
          hideDialog();
        }
      });

      mapEl.addEventListener('click', function () {
        vscode.postMessage({ type: 'openMap' });
      });

      listEl.addEventListener('click', function (e) {
        var sectionHeader = e.target.closest('.section-header');
        if (sectionHeader) {
          var section = sectionHeader.parentElement.dataset.section;
          vscode.postMessage({ type: 'toggleSection', section: section });
          return;
        }
        var moreBtn = e.target.closest('[data-action="toggleMoreProviders"]');
        if (moreBtn) {
          vscode.postMessage({ type: 'toggleMoreProviders' });
          return;
        }
        var wcard = e.target.closest('[data-profile-id]');
        if (wcard) {
          var setModelsBtn = e.target.closest('[data-set-models]');
          if (setModelsBtn) {
            vscode.postMessage({ type: 'requestSetModels', profileId: setModelsBtn.getAttribute('data-set-models') });
            return;
          }
          var toggleBtn = e.target.closest('[data-toggle]');
          if (toggleBtn) {
            var enabled = wcard.getAttribute('data-enabled') === 'true';
            vscode.postMessage({ type: enabled ? 'disable' : 'enable', profileId: toggleBtn.getAttribute('data-toggle') });
            return;
          }
          var deleteBtn = e.target.closest('[data-delete]');
          if (deleteBtn) {
            vscode.postMessage({ type: 'delete', profileId: deleteBtn.getAttribute('data-delete') });
            return;
          }
          return;
        }
        var connectRow = e.target.closest('.connect-row');
        if (connectRow) {
          vscode.postMessage({ type: 'requestConnect', slug: connectRow.getAttribute('data-slug') });
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
        else if (msg && msg.type === 'setModelsDialog') showSetModelsDialog(msg);
        else if (msg && msg.type === 'connectDialog') showConnectDialog(msg);
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`
}
