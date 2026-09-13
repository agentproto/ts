/**
 * Auth & Models EXPLORER — the editable editor-tab webview (viewType
 * `agentproto.authExplorer`, opened by `agentproto.openAuthExplorer`).
 *
 * The live implementation of the approved `auth-explorer-mockup.html` design
 * (found in `.claude/plans/`, rendered as `_authfinal.png`): a master-detail
 * page — left rail with Providers → wallets, Harnesses → spawn presets, and a
 * multi-served Models pivot; right detail pages that actually EDIT the
 * configuration, unlike the read-only Auth & Model Map:
 *
 * - per-wallet allowed-models editor (vendor groups, per-model + per-vendor
 *   toggles) writing through `setAuthProfileModels`;
 * - whole-wallet enable/disable + delete;
 * - connect flows for unconnected providers (reuses the Wallets flow);
 * - spawn-preset (favorites) delete;
 * - local-router upstream link assignment (`llm_endpoint_set_upstream_link`).
 *
 * All toggle math lives in `authExplorer.logic.ts` (pure, unit-tested); the
 * host recomputes writes from its latest fetched view so the webview never
 * needs to be trusted with allowlist arithmetic.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type {
  AdapterInfo,
  AuthProfileSummary,
  CatalogModelsResponse,
  LlmEndpointLinksResult,
  LlmEndpointStatusResult,
  ProviderPresetEntry,
  UserPreset,
} from "../client/types.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"
import { runCreateAuthProfileFlow } from "../commands/authProfiles.js"
import {
  buildCreateRequest,
  successMessage,
  suggestProfileId,
  validateCredential,
  validateProfileId,
} from "../commands/authProfileFlow.logic.js"
import {
  buildAuthExplorerView,
  toggleWalletModel,
  toggleWalletVendor,
  type AuthExplorerView,
  type ExplorerWalletView,
} from "./authExplorer.logic.js"

const VIEW_TYPE = "agentproto.authExplorer"

/** host → webview */
interface ModelMessage {
  type: "model"
  view: AuthExplorerView
}

/** webview → host */
type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "addWallet" }
  | { type: "connectProvider"; slug: string }
  | { type: "toggleModel"; profileId: string; writeId: string }
  | { type: "toggleVendor"; profileId: string; vendor: string }
  | { type: "removeUnlisted"; profileId: string; id: string }
  | { type: "setEnabled"; profileId: string; enabled: boolean }
  | { type: "deleteProfile"; profileId: string }
  | { type: "deletePreset"; presetId: string }
  | { type: "setUpstreamLink"; provider: string; profileId: string | null }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  )
}

export interface AuthExplorerPanel {
  open(): void
}

export function registerAuthExplorer(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  treeProvider: AuthProfilesTreeProvider,
): AuthExplorerPanel {
  let panel: vscode.WebviewPanel | undefined
  let lastView: AuthExplorerView | undefined

  async function fetchView(): Promise<AuthExplorerView> {
    const [presets, profiles, catalog, adapters, userPresets, links, routerStatus] = await Promise.all([
      client.listProviderPresets().catch((): ProviderPresetEntry[] => []),
      client.listAuthProfiles().catch((): AuthProfileSummary[] => []),
      client.catalogModels().catch((): CatalogModelsResponse => ({ vendors: [] })),
      client.listAdapters().catch((): AdapterInfo[] => []),
      client.listUserPresets().catch((): UserPreset[] => []),
      client.llmEndpointListLinks().catch((): LlmEndpointLinksResult | null => null),
      client.llmEndpointStatus().catch((): LlmEndpointStatusResult | null => null),
    ])
    lastView = buildAuthExplorerView({ presets, profiles, catalog, adapters, userPresets, links, routerStatus })
    return lastView
  }

  async function post(): Promise<void> {
    if (!panel) return
    const view = await fetchView()
    void panel.webview.postMessage({ type: "model", view } satisfies ModelMessage)
  }

  function findWallet(profileId: string): ExplorerWalletView | undefined {
    for (const provider of lastView?.providers ?? []) {
      const wallet = provider.wallets.find(w => w.id === profileId)
      if (wallet) return wallet
    }
    return undefined
  }

  async function connectProvider(slug: string): Promise<void> {
    const existingIds = (lastView?.providers ?? []).flatMap(p => p.wallets.map(w => w.id))
    const id = await vscode.window.showInputBox({
      title: `Connect ${slug}: profile id`,
      value: suggestProfileId("api-key", slug),
      ignoreFocusOut: true,
      validateInput: value => validateProfileId(value.trim(), existingIds),
    })
    if (!id) return
    const credential = await vscode.window.showInputBox({
      title: `Connect ${slug}: credential`,
      prompt: `Paste the ${slug} API key`,
      password: true,
      ignoreFocusOut: true,
      validateInput: validateCredential,
    })
    if (!credential) return
    try {
      const created = await client.createAuthProfile(
        buildCreateRequest({ id: id.trim(), endpoint: slug, method: "api-key", credential }),
      )
      void vscode.window.showInformationMessage(successMessage(created))
      await treeProvider.refresh()
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not connect ${slug}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async function writeModels(profileId: string, write: { mode: "all" | "allow"; ids: string[] }): Promise<void> {
    try {
      await client.setAuthProfileModels(profileId, write.mode, write.ids)
      await treeProvider.refresh()
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not update allowed models for "${profileId}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await post()
  }

  async function handleMessage(msg: WebviewToHostMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
      case "refresh":
        await post()
        return
      case "addWallet":
        await runCreateAuthProfileFlow(client, treeProvider)
        await post()
        return
      case "connectProvider":
        await connectProvider(msg.slug)
        await post()
        return
      case "toggleModel": {
        const wallet = findWallet(msg.profileId)
        if (!wallet) return
        await writeModels(msg.profileId, toggleWalletModel(wallet, msg.writeId))
        return
      }
      case "toggleVendor": {
        const wallet = findWallet(msg.profileId)
        if (!wallet) return
        await writeModels(msg.profileId, toggleWalletVendor(wallet, msg.vendor))
        return
      }
      case "removeUnlisted": {
        const wallet = findWallet(msg.profileId)
        if (!wallet) return
        const allowed = wallet.models.filter(r => r.allowed).map(r => r.writeId)
        const kept = wallet.unlistedIds.filter(id => id !== msg.id)
        const ids = [...new Set([...allowed, ...kept])].sort((a, b) => a.localeCompare(b))
        const everythingAllowed = allowed.length === wallet.models.length && kept.length === 0
        await writeModels(
          msg.profileId,
          ids.length === 0 || everythingAllowed ? { mode: "all", ids: [] } : { mode: "allow", ids },
        )
        return
      }
      case "setEnabled": {
        try {
          await client.setAuthProfileEnabled(msg.profileId, msg.enabled)
          await treeProvider.refresh()
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Could not ${msg.enabled ? "enable" : "disable"} "${msg.profileId}": ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        await post()
        return
      }
      case "deleteProfile": {
        const choice = await vscode.window.showWarningMessage(
          `Delete wallet "${msg.profileId}"? Its stored credential reference is removed from routing.`,
          { modal: true },
          "Delete",
        )
        if (choice !== "Delete") return
        try {
          await client.deleteAuthProfile(msg.profileId)
          await treeProvider.refresh()
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Could not delete "${msg.profileId}": ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        await post()
        return
      }
      case "deletePreset": {
        const choice = await vscode.window.showWarningMessage(
          `Delete spawn preset "${msg.presetId}"?`,
          { modal: true },
          "Delete",
        )
        if (choice !== "Delete") return
        try {
          await client.deleteUserPreset(msg.presetId)
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Could not delete preset "${msg.presetId}": ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        await post()
        return
      }
      case "setUpstreamLink": {
        try {
          const result = await client.llmEndpointSetUpstreamLink(msg.provider, msg.profileId)
          if (result.restartRequired) {
            void vscode.window.showInformationMessage(
              `Upstream link for ${msg.provider} saved — restart the local router to apply it.`,
            )
          }
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Could not set upstream link for ${msg.provider}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        await post()
        return
      }
    }
  }

  ctx.subscriptions.push(treeProvider.onDidChangeTreeData(() => void post()))

  return {
    open(): void {
      if (panel) {
        panel.reveal(vscode.ViewColumn.One, false)
        return
      }
      panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Auth & Models", vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
      })
      panel.webview.onDidReceiveMessage(
        (raw: unknown) => {
          if (!isWebviewToHostMessage(raw)) return
          void handleMessage(raw)
        },
        undefined,
        ctx.subscriptions,
      )
      panel.onDidDispose(() => {
        panel = undefined
      })
      panel.webview.html = buildAuthExplorerHtml(randomNonce())
    },
  }
}

function randomNonce(): string {
  return randomBytes(16).toString("hex")
}

export function buildAuthExplorerHtml(nonce: string): string {
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join("; ")
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Auth &amp; Models</title>
<style>
:root {
  --bg: #0a0a0a; --surface: #141414; --raised: #1e1e1e; --hi: #262626;
  --ink: #fafafa; --muted: rgba(250,250,250,.58); --faint: rgba(250,250,250,.34);
  --accent: #10b981; --accent-fg: #0a0a0a;
  --border: rgba(255,255,255,.09); --border-strong: rgba(255,255,255,.18);
  --ok: #10b981; --warn: #e0b23a; --danger: #f2664a; --info: #38bdf8;
  --body: "Inter", -apple-system, system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font-family: var(--body); background: var(--bg); color: var(--ink);
  -webkit-font-smoothing: antialiased; font-size: 13px; line-height: 1.5; overflow: hidden;
}
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 9999px; border: 3px solid var(--surface); }
::-webkit-scrollbar-thumb:hover { background: var(--faint); }
.window { height: 100vh; background: var(--surface); display: grid; grid-template-rows: 46px 1fr; }
.titlebar {
  display: flex; align-items: center; padding: 0 14px 0 16px; gap: 12px;
  background: var(--surface); border-bottom: 1px solid var(--border); user-select: none;
}
.brand { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-weight: 700; font-size: 14px; }
.brand .glyph { color: var(--accent); }
.brand .sub { color: var(--muted); font-weight: 500; font-family: var(--body); font-size: 12px; }
.titlebar .spacer { flex: 1; }
.pill {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
  border-radius: 9999px; border: 1px solid var(--border); background: var(--raised);
  color: var(--muted); font-size: 12px; white-space: nowrap;
}
.pill .led { width: 7px; height: 7px; border-radius: 9999px; background: var(--faint); }
.pill .led.on { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
.btn {
  height: 26px; padding: 0 12px; border-radius: 4px; border: none; cursor: pointer;
  background: var(--accent); color: var(--accent-fg); font-weight: 600; font-size: 12px;
  display: inline-flex; align-items: center; gap: 6px; font-family: var(--body);
}
.btn:hover { filter: brightness(1.08); }
.btn.ghost { background: var(--raised); color: var(--muted); border: 1px solid var(--border); }
.btn.ghost:hover { background: var(--hi); color: var(--ink); }
.btn.danger { background: transparent; color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); }
.btn.danger:hover { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.body-grid { display: grid; grid-template-columns: 320px 1fr; min-height: 0; }
.rail { border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; background: var(--surface); }
.search { padding: 9px 10px; border-bottom: 1px solid var(--border); }
.search input {
  width: 100%; height: 30px; padding: 0 10px; border-radius: 4px; border: 1px solid var(--border);
  background: var(--raised); color: var(--ink); font-family: var(--body); font-size: 12px;
}
.search input::placeholder { color: var(--faint); }
.rail-scroll { overflow-y: auto; padding: 6px 6px 24px; flex: 1; }
.section-head {
  display: flex; align-items: center; gap: 8px; padding: 9px 8px 7px; color: var(--muted);
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em;
  position: sticky; top: 0; background: var(--surface); z-index: 1;
}
.section-head .badge {
  font-size: 10px; font-weight: 600; font-family: var(--mono); color: var(--faint);
  background: var(--raised); border: 1px solid var(--border); padding: 0 5px; height: 16px;
  display: inline-flex; align-items: center;
}
.row {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px; cursor: pointer;
  border-radius: 2px; white-space: nowrap; overflow: hidden;
}
.row:hover { background: var(--raised); }
.row.selected {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  outline: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); outline-offset: -1px;
}
.row .icon { width: 16px; height: 16px; display: grid; place-items: center; flex: 0 0 auto; font-size: 12px; color: var(--faint); }
.row .label { overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
.row .meta { color: var(--faint); font-size: 11px; margin-left: auto; padding-left: 8px; flex: 0 0 auto; font-family: var(--mono); }
.row.child { padding-left: 32px; }
.tag {
  font-size: 10px; padding: 0 6px; height: 18px; display: inline-flex; align-items: center;
  border-radius: 9999px; border: 1px solid var(--border); color: var(--faint); flex: 0 0 auto;
}
.tag.oauth { color: var(--info); border-color: color-mix(in srgb, var(--info) 30%, transparent); }
.tag.off { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
.tag.new { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
.led-dot { width: 7px; height: 7px; border-radius: 9999px; flex: 0 0 auto; }
.led-dot.on { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
.led-dot.off { background: var(--faint); }
.main { min-height: 0; overflow-y: auto; background: var(--bg); }
.detail { padding: 24px 32px 60px; max-width: 860px; }
.detail h1 { font-family: var(--mono); font-size: 17px; font-weight: 700; margin: 0 0 2px; display: flex; align-items: center; gap: 10px; }
.detail .subtitle { color: var(--muted); font-size: 12px; margin-bottom: 20px; }
.detail .subtitle code { font-family: var(--mono); font-size: 11px; background: var(--raised); padding: 1px 5px; border-radius: 2px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 16px 18px; margin-bottom: 16px; }
.card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin: 0 0 12px; font-weight: 700; }
.field { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.field label { width: 110px; color: var(--muted); font-size: 12px; flex: 0 0 auto; }
.mono { font-family: var(--mono); font-size: 11px; color: var(--muted); }
select {
  height: 30px; padding: 0 10px; border-radius: 4px; border: 1px solid var(--border);
  background: var(--raised); color: var(--ink); font-family: var(--body); font-size: 12px; cursor: pointer;
}
input.filter {
  height: 30px; padding: 0 10px; border-radius: 4px; border: 1px solid var(--border);
  background: var(--raised); color: var(--ink); font-family: var(--body); font-size: 12px;
}
.switch { position: relative; width: 30px; height: 16px; flex: 0 0 auto; cursor: pointer; display: inline-block; }
.switch input { display: none; }
.switch .track { position: absolute; inset: 0; background: var(--hi); border-radius: 9999px; border: 1px solid var(--border); transition: .15s; }
.switch .thumb { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 9999px; background: var(--faint); transition: .15s; }
.switch input:checked + .track { background: var(--accent); border-color: var(--accent); }
.switch input:checked + .track + .thumb { left: 16px; background: var(--accent-fg); }
.callout {
  border-left: 3px solid var(--info); background: color-mix(in srgb, var(--info) 6%, var(--surface));
  padding: 10px 14px; border-radius: 0 4px 4px 0; font-size: 12px;
  color: color-mix(in srgb, var(--info) 70%, var(--ink)); margin-bottom: 16px;
}
.callout b { color: var(--info); }
.vendor-group { margin-bottom: 4px; }
.vendor-head {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px; cursor: pointer;
  color: var(--ink); font-weight: 600; font-size: 12px; border-radius: 2px;
}
.vendor-head:hover { background: var(--raised); }
.vendor-head .vcount { color: var(--faint); font-weight: 400; font-size: 11px; font-family: var(--mono); }
.vendor-head .toggle-link { margin-left: auto; color: var(--accent); font-size: 11px; font-weight: 400; }
.model-row {
  display: flex; align-items: center; gap: 8px; padding: 3px 8px 3px 28px; border-radius: 2px;
  font-family: var(--mono); font-size: 11.5px; cursor: pointer;
}
.model-row:hover { background: var(--raised); }
.model-row.off { color: var(--faint); }
.model-row .price { margin-left: auto; color: var(--faint); font-size: 10.5px; }
.checkbox {
  width: 14px; height: 14px; border: 1px solid var(--border-strong); border-radius: 2px;
  display: inline-flex; align-items: center; justify-content: center; font-size: 10px; flex: 0 0 auto; color: transparent;
}
.checkbox.on { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.mdot { width: 6px; height: 6px; border-radius: 9999px; flex: 0 0 auto; }
.mdot.active { background: var(--ok); }
.mdot.inactive { background: var(--warn); }
.mdot.unbillable { background: var(--danger); }
.binding-line {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--border);
  border-radius: 4px; margin-bottom: 8px; background: var(--raised); flex-wrap: wrap;
}
.binding-line .x { margin-left: auto; }
.chip {
  font-size: 10.5px; font-family: var(--mono); border: 1px solid var(--border); border-radius: 9999px;
  padding: 2px 9px; color: var(--muted); display: inline-flex; align-items: center; gap: 5px;
}
.chip button { background: none; border: none; color: var(--danger); cursor: pointer; padding: 0; font-size: 12px; line-height: 1; }
.empty { color: var(--faint); font-style: italic; font-size: 12px; }
.cols { display: flex; gap: 16px; flex-wrap: wrap; }
.cols > * { flex: 1; min-width: 260px; }
.btn-row { display: flex; gap: 8px; margin-top: 4px; }
#loading { padding: 40px; color: var(--faint); font-size: 12px; }
</style>
</head>
<body>
<div class="window">
  <div class="titlebar">
    <div class="brand"><span class="glyph">&#9656;</span> agentproto <span class="sub">Auth &amp; Models</span></div>
    <span class="spacer"></span>
    <div class="pill" id="router-pill"><span class="led"></span><span id="router-label">router</span></div>
    <div class="pill" id="counts-pill"></div>
    <button class="btn ghost" id="refresh">&#10227; Refresh</button>
    <button class="btn" id="add-wallet">+ Add wallet</button>
  </div>
  <div class="body-grid">
    <nav class="rail">
      <div class="search"><input id="q" placeholder="Filter providers, wallets, harnesses&hellip;" autocomplete="off"></div>
      <div class="rail-scroll" id="tree"><div id="loading">Loading&hellip;</div></div>
    </nav>
    <div class="main"><div class="detail" id="detail"></div></div>
  </div>
</div>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var view = null;
  var selected = { kind: 'none', id: '' };
  var search = '';
  var modelFilter = '';

  function esc(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;';
    });
  }
  function post(msg) { vscode.postMessage(msg); }

  function walletById(id) {
    if (!view) return null;
    for (var i = 0; i < view.providers.length; i++) {
      var ws = view.providers[i].wallets;
      for (var j = 0; j < ws.length; j++) if (ws[j].id === id) return ws[j];
    }
    return null;
  }
  function providerBySlug(slug) {
    if (!view) return null;
    for (var i = 0; i < view.providers.length; i++) if (view.providers[i].slug === slug) return view.providers[i];
    return null;
  }
  function harnessBySlug(slug) {
    if (!view) return null;
    for (var i = 0; i < view.harnesses.length; i++) if (view.harnesses[i].slug === slug) return view.harnesses[i];
    return null;
  }
  function pivotByKey(key) {
    if (!view) return null;
    for (var i = 0; i < view.multiServed.length; i++) if (view.multiServed[i].key === key) return view.multiServed[i];
    return null;
  }

  function matches(text) {
    return !search || String(text).toLowerCase().indexOf(search) !== -1;
  }

  function renderRail() {
    var t = document.getElementById('tree');
    if (!view) return;
    var h = '';
    var connected = view.providers.filter(function (p) { return p.connected; });
    var unconnected = view.providers.filter(function (p) { return !p.connected; });

    h += '<div class="section-head">Providers <span class="badge">' + connected.length + '</span></div>';
    for (var i = 0; i < connected.length; i++) {
      var pv = connected[i];
      var walletMatch = pv.wallets.some(function (w) { return matches(w.label) || matches(w.id); });
      if (!matches(pv.slug) && !matches(pv.name) && !walletMatch) continue;
      var sel = selected.kind === 'provider' && selected.id === pv.slug ? ' selected' : '';
      h += '<div class="row' + sel + '" data-sel="provider" data-id="' + esc(pv.slug) + '">' +
        '<span class="icon">&#9656;</span><span class="label"><b>' + esc(pv.name) + '</b></span>' +
        '<span class="meta">' + pv.wallets.length + '</span></div>';
      for (var j = 0; j < pv.wallets.length; j++) {
        var w = pv.wallets[j];
        if (!matches(pv.slug) && !matches(w.label) && !matches(w.id)) continue;
        var ws = selected.kind === 'wallet' && selected.id === w.id ? ' selected' : '';
        var kindTag = w.accessKind === 'api-key' ? '<span class="tag">key</span>' : '<span class="tag oauth">oauth</span>';
        h += '<div class="row child' + ws + '" data-sel="wallet" data-id="' + esc(w.id) + '">' +
          '<span class="led-dot ' + (w.enabled ? 'on' : 'off') + '"></span>' +
          '<span class="label">' + esc(w.label) + '</span>' + kindTag +
          (w.enabled ? '' : '<span class="tag off">off</span>') +
          '<span class="meta">' + w.activeCount + '/' + w.catalogCount + '</span></div>';
      }
    }
    if (unconnected.length) {
      h += '<div class="section-head">Connect <span class="badge">' + unconnected.length + '</span></div>';
      for (var u = 0; u < unconnected.length; u++) {
        var up = unconnected[u];
        if (!matches(up.slug) && !matches(up.name)) continue;
        h += '<div class="row" data-connect="' + esc(up.slug) + '">' +
          '<span class="icon">+</span><span class="label">' + esc(up.name) + '</span>' +
          '<span class="tag new">connect</span></div>';
      }
    }

    h += '<div class="section-head">Harnesses <span class="badge">' + view.harnesses.length + '</span></div>';
    for (var k = 0; k < view.harnesses.length; k++) {
      var hn = view.harnesses[k];
      if (!matches(hn.slug) && !matches(hn.name)) continue;
      var hs = selected.kind === 'harness' && selected.id === hn.slug ? ' selected' : '';
      h += '<div class="row' + hs + '" data-sel="harness" data-id="' + esc(hn.slug) + '">' +
        '<span class="icon">&#9881;</span><span class="label">' + esc(hn.name) + '</span>' +
        (hn.presets.length ? '<span class="meta">' + hn.presets.length + '</span>' : '') + '</div>';
    }

    h += '<div class="section-head">Models &#183; multi-wallet <span class="badge">' + view.multiServed.length + '</span></div>';
    for (var m = 0; m < view.multiServed.length && m < 30; m++) {
      var mv = view.multiServed[m];
      if (!matches(mv.key)) continue;
      var ms = selected.kind === 'model' && selected.id === mv.key ? ' selected' : '';
      h += '<div class="row' + ms + '" data-sel="model" data-id="' + esc(mv.key) + '">' +
        '<span class="icon">&#9672;</span><span class="label mono" style="font-family:var(--mono);font-size:11px">' + esc(mv.key) + '</span>' +
        '<span class="meta">' + mv.servedBy.length + '</span></div>';
    }
    t.innerHTML = h;
  }

  function detailProvider(pv) {
    var h = '<h1><span style="color:var(--faint)">&#9656;</span> ' + esc(pv.name) + '</h1>' +
      '<div class="subtitle">provider <code>' + esc(pv.slug) + '</code></div>';
    h += '<div class="card"><h2>Wallets (' + pv.wallets.length + ')</h2>';
    if (pv.wallets.length) {
      for (var i = 0; i < pv.wallets.length; i++) {
        var w = pv.wallets[i];
        h += '<div class="binding-line" style="cursor:pointer" data-sel="wallet" data-id="' + esc(w.id) + '">' +
          '<span class="led-dot ' + (w.enabled ? 'on' : 'off') + '"></span>' +
          '<b style="font-size:12px">' + esc(w.label) + '</b>' +
          '<span class="mono">' + esc(w.credential) + '</span>' +
          '<span class="mono" style="margin-left:auto">' + w.allowedCount + ' allowed &#183; ' + w.activeCount + ' active</span></div>';
      }
    } else {
      h += '<div class="empty">no wallets on this provider</div>';
    }
    h += '<div class="btn-row" style="margin-top:12px"><button class="btn" data-connect="' + esc(pv.slug) + '">+ Connect a wallet</button></div></div>';
    if (pv.upstream) {
      var opts = '<option value=""' + (pv.upstream.linkedProfile ? '' : ' selected') + '>&mdash; not linked &mdash;</option>';
      for (var e = 0; e < pv.upstream.eligible.length; e++) {
        var el = pv.upstream.eligible[e];
        opts += '<option value="' + esc(el.id) + '"' + (el.id === pv.upstream.linkedProfile ? ' selected' : '') + '>' + esc(el.label) + '</option>';
      }
      h += '<div class="card"><h2>Local router upstream link</h2>' +
        '<div class="field"><label>Bills via</label><select data-upstream="' + esc(pv.slug) + '">' + opts + '</select></div>' +
        '<div class="mono">the local router proxies ' + esc(pv.slug) + ' traffic through the linked wallet; restart the router to apply a change</div></div>';
    }
    return h;
  }

  function detailWallet(w) {
    var kindLabel = w.accessKind === 'api-key' ? 'API key' : (w.accessKind === 'subscription-refreshing' ? 'subscription &#183; self-refreshing' : 'subscription &#183; stored');
    var h = '<h1><span class="led-dot ' + (w.enabled ? 'on' : 'off') + '"></span> ' + esc(w.label) + '</h1>' +
      '<div class="subtitle"><code>' + esc(w.id) + '</code> &#183; endpoint <b>' + esc(w.endpoint) + '</b></div>';
    h += '<div class="cols"><div class="card"><h2>Identity</h2>' +
      '<div class="field"><label>Access</label><span style="font-size:12px">' + kindLabel + '</span></div>' +
      '<div class="field"><label>Credential</label><span class="mono">' + esc(w.credential) + '</span></div>' +
      (w.origin ? '<div class="field"><label>Imported from</label><span class="mono">' + esc(w.origin) + '</span></div>' : '') +
      '<div class="field"><label>Enabled</label>' +
        '<label class="switch"><input type="checkbox" data-enable="' + esc(w.id) + '"' + (w.enabled ? ' checked' : '') + '><span class="track"></span><span class="thumb"></span></label>' +
        '<span style="color:var(--faint);font-size:11px">' + (w.enabled ? 'visible to routing' : 'ignored everywhere') + '</span></div>' +
      '<div class="btn-row"><button class="btn danger" data-delete="' + esc(w.id) + '">Delete wallet</button></div></div>';
    h += '<div class="card"><h2>Used by</h2>';
    if (w.usedByPresets.length) {
      for (var i = 0; i < w.usedByPresets.length; i++) {
        var pr = w.usedByPresets[i];
        h += '<div style="margin-bottom:8px;font-size:12px"><span style="color:var(--faint)">&#9881;</span> <b>' +
          esc(pr.harness || 'any harness') + '</b> &#183; ' + esc(pr.label) +
          (pr.model ? ' <span class="mono">(' + esc(pr.model) + ')</span>' : '') + '</div>';
      }
    } else {
      h += '<div class="empty">no spawn preset uses this wallet</div>';
    }
    for (var uo = 0; uo < w.upstreamOf.length; uo++) {
      h += '<div style="margin-top:8px;font-size:12px"><span style="color:var(--faint)">&#9656;</span> router upstream for <b>' + esc(w.upstreamOf[uo]) + '</b></div>';
    }
    h += '</div></div>';

    h += '<div class="card"><h2>Allowed models</h2>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
        '<input class="filter" id="model-filter" placeholder="Filter models&hellip;" value="' + esc(modelFilter) + '" style="flex:1;max-width:300px" autocomplete="off">' +
        '<span class="mono">' + w.allowedCount + ' allowed &#183; ' + w.activeCount + ' active' + (w.curationMode === 'all' ? ' &#183; full catalog' : '') + '</span></div>';
    if (w.unlistedIds.length) {
      h += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">' +
        '<span style="font-size:11px;color:var(--warn)">not in catalog:</span>';
      for (var un = 0; un < w.unlistedIds.length; un++) {
        var uid = w.unlistedIds[un];
        h += '<span class="chip" title="this allowlist id matches nothing in the ' + esc(w.endpoint) + ' catalog">' + esc(uid) +
          '<button data-remove-unlisted="' + esc(uid) + '" title="Remove ' + esc(uid) + '">&#215;</button></span>';
      }
      h += '</div>';
    }
    var filter = modelFilter.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    var byVendor = {};
    var vendors = [];
    for (var r = 0; r < w.models.length; r++) {
      var row = w.models[r];
      var hay = (row.vendor + '/' + row.product).toLowerCase();
      var keep = filter.every(function (t) { return hay.indexOf(t) !== -1; });
      if (!keep) continue;
      if (!byVendor[row.vendor]) { byVendor[row.vendor] = []; vendors.push(row.vendor); }
      byVendor[row.vendor].push(row);
    }
    if (!w.models.length) {
      h += '<div class="empty">no catalog models bill through this endpoint</div>';
    } else if (!vendors.length) {
      h += '<div class="empty">nothing matches the filter</div>';
    }
    for (var v = 0; v < vendors.length; v++) {
      var vendor = vendors[v];
      var rows = byVendor[vendor];
      var on = rows.filter(function (x) { return x.allowed; }).length;
      h += '<div class="vendor-group"><div class="vendor-head" data-vendor="' + esc(vendor) + '">' +
        '<span>' + esc(vendor) + '</span><span class="vcount">' + on + '/' + rows.length + '</span>' +
        '<span class="toggle-link">' + (on === rows.length ? 'deselect all' : 'select all') + '</span></div>';
      for (var q = 0; q < rows.length; q++) {
        var mr = rows[q];
        h += '<div class="model-row' + (mr.allowed ? '' : ' off') + '" data-model="' + esc(mr.writeId) + '" title="' + esc(mr.hint) + '">' +
          '<span class="checkbox' + (mr.allowed ? ' on' : '') + '">' + (mr.allowed ? '&#10003;' : '') + '</span>' +
          '<span class="mdot ' + esc(mr.status) + '"></span>' +
          '<span>' + esc(mr.product) + '</span>' +
          (mr.price ? '<span class="price">' + esc(mr.price) + '</span>' : '') + '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  function detailHarness(hn) {
    var h = '<h1><span style="color:var(--faint)">&#9881;</span> ' + esc(hn.name) + '</h1>' +
      '<div class="subtitle">adapter <code>' + esc(hn.slug) + '</code>' +
      (hn.protocol ? ' &#183; protocol ' + esc(hn.protocol) : '') +
      (hn.version ? ' &#183; v' + esc(hn.version) : '') + '</div>';
    h += '<div class="callout"><b>Spawn presets.</b> A preset (favorite) pins wallet + model + posture for one-click spawns. Create them from a session ("Save as Favorite&hellip;") or the Configuration Lab; manage them here.</div>';
    h += '<div class="card"><h2>Presets (' + hn.presets.length + ')</h2>';
    if (hn.presets.length) {
      for (var i = 0; i < hn.presets.length; i++) {
        var pr = hn.presets[i];
        h += '<div class="binding-line"><b style="font-size:12px">' + esc(pr.label) + '</b>' +
          (pr.model ? '<span class="mono">' + esc(pr.model) + '</span>' : '') +
          '<button class="btn danger x" style="height:22px;padding:0 8px;font-size:11px" data-delete-preset="' + esc(pr.id) + '">&#215;</button></div>';
      }
    } else {
      h += '<div class="empty">no presets for this harness &mdash; every spawn configures from scratch</div>';
    }
    h += '</div>';
    return h;
  }

  function detailModel(mv) {
    var h = '<h1><span style="color:var(--faint)">&#9672;</span> ' + esc(mv.key) + '</h1>' +
      '<div class="subtitle">pivot &mdash; every wallet that can bill this model right now</div>';
    h += '<div class="card"><h2>Served by ' + mv.servedBy.length + ' wallets</h2>';
    for (var i = 0; i < mv.servedBy.length; i++) {
      var e = mv.servedBy[i];
      h += '<div class="binding-line" style="cursor:pointer" data-sel="wallet" data-id="' + esc(e.profileId) + '">' +
        '<span class="led-dot on"></span><b style="font-size:12px">' + esc(e.label) + '</b>' +
        '<span style="color:var(--faint);font-size:11px">' + esc(e.endpoint) + '</span>' +
        '<code class="mono" style="background:var(--hi);padding:1px 5px;border-radius:2px">' + esc(e.ref) + '</code></div>';
    }
    h += '<div style="color:var(--faint);font-size:11px;margin-top:8px">same model, different billing routes &mdash; pick per spawn in the Configuration Lab</div></div>';
    return h;
  }

  function renderDetail() {
    var d = document.getElementById('detail');
    if (!view) return;
    var h = '';
    if (selected.kind === 'wallet') {
      var w = walletById(selected.id);
      h = w ? detailWallet(w) : '';
    } else if (selected.kind === 'provider') {
      var pv = providerBySlug(selected.id);
      h = pv ? detailProvider(pv) : '';
    } else if (selected.kind === 'harness') {
      var hn = harnessBySlug(selected.id);
      h = hn ? detailHarness(hn) : '';
    } else if (selected.kind === 'model') {
      var mv = pivotByKey(selected.id);
      h = mv ? detailModel(mv) : '';
    }
    if (!h) {
      var first = view.providers.filter(function (p) { return p.connected; })[0];
      if (first) { selected = { kind: 'provider', id: first.slug }; h = detailProvider(first); }
      else h = '<div class="empty" style="padding:40px 0">No providers connected yet &mdash; use + Add wallet.</div>';
    }
    d.innerHTML = h;
    var mf = document.getElementById('model-filter');
    if (mf) {
      mf.addEventListener('input', function () {
        modelFilter = mf.value;
        var pos = mf.selectionStart;
        renderDetail();
        var again = document.getElementById('model-filter');
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      });
    }
  }

  function render() { renderRail(); renderDetail(); }

  document.getElementById('refresh').addEventListener('click', function () { post({ type: 'refresh' }); });
  document.getElementById('add-wallet').addEventListener('click', function () { post({ type: 'addWallet' }); });
  document.getElementById('q').addEventListener('input', function () {
    search = document.getElementById('q').value.trim().toLowerCase();
    renderRail();
  });

  document.body.addEventListener('click', function (ev) {
    var target = ev.target;
    var selEl = target.closest('[data-sel]');
    if (selEl) {
      selected = { kind: selEl.getAttribute('data-sel'), id: selEl.getAttribute('data-id') };
      modelFilter = '';
      render();
      return;
    }
    var connectEl = target.closest('[data-connect]');
    if (connectEl) { post({ type: 'connectProvider', slug: connectEl.getAttribute('data-connect') }); return; }
    var removeUnlisted = target.closest('[data-remove-unlisted]');
    if (removeUnlisted && selected.kind === 'wallet') {
      post({ type: 'removeUnlisted', profileId: selected.id, id: removeUnlisted.getAttribute('data-remove-unlisted') });
      return;
    }
    var vendorEl = target.closest('[data-vendor]');
    if (vendorEl && selected.kind === 'wallet') {
      post({ type: 'toggleVendor', profileId: selected.id, vendor: vendorEl.getAttribute('data-vendor') });
      return;
    }
    var modelEl = target.closest('[data-model]');
    if (modelEl && selected.kind === 'wallet') {
      post({ type: 'toggleModel', profileId: selected.id, writeId: modelEl.getAttribute('data-model') });
      return;
    }
    var deleteEl = target.closest('[data-delete]');
    if (deleteEl) { post({ type: 'deleteProfile', profileId: deleteEl.getAttribute('data-delete') }); return; }
    var deletePresetEl = target.closest('[data-delete-preset]');
    if (deletePresetEl) { post({ type: 'deletePreset', presetId: deletePresetEl.getAttribute('data-delete-preset') }); return; }
  });

  document.body.addEventListener('change', function (ev) {
    var target = ev.target;
    var enableEl = target.closest('[data-enable]');
    if (enableEl) {
      post({ type: 'setEnabled', profileId: enableEl.getAttribute('data-enable'), enabled: enableEl.checked });
      return;
    }
    var upstreamEl = target.closest('[data-upstream]');
    if (upstreamEl) {
      post({ type: 'setUpstreamLink', provider: upstreamEl.getAttribute('data-upstream'), profileId: upstreamEl.value || null });
      return;
    }
  });

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.type !== 'model') return;
    view = msg.view;
    document.getElementById('counts-pill').textContent =
      view.counts.wallets + ' wallets · ' + view.counts.providers + ' providers · ' + view.counts.harnesses + ' harnesses';
    var led = document.querySelector('#router-pill .led');
    led.className = 'led' + (view.router.running ? ' on' : '');
    document.getElementById('router-label').textContent = view.router.label;
    render();
  });

  post({ type: 'ready' });
})();
</script>
</body>
</html>`
}
