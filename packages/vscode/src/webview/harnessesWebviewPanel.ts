/**
 * Harnesses webview panel — the opt-in WebviewView alternative to the Harnesses
 * TreeView (`agentproto.harnessesView === "webview"`, see package.json's
 * mutually-exclusive `when` clauses). Mirrors the Sessions webview's row
 * grammar: hairline separators, 7x7px status dots, real adapter logos in the
 * second column, and one labeled action button (Install / Installing… /
 * ▶ Start) that never changes slot or swaps on hover.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { AdapterInfo } from "../client/types.js"
import type { DaemonClient } from "../client/daemonClient.js"
import type { HarnessNode } from "../views/harnessesTree.logic.js"
import type { HarnessesTreeProvider } from "../views/harnessesTree.js"
import {
  buildHarnessesWebviewModel,
  type HarnessWebviewRow,
  type HarnessesWebviewModel,
} from "./harnessesWebview.logic.js"

const VIEW_TYPE = "agentproto.harnessesWebview"

type RenderLogo =
  | { kind: "icon"; file: string; uri: string }
  | { kind: "lettermark"; text: string }

interface RenderRow {
  slug: string
  name: string
  description: string
  status: HarnessWebviewRow["status"]
  installable: boolean
  action: HarnessWebviewRow["action"]
  logo: RenderLogo
}

interface ModelMessage {
  type: "model"
  rows: RenderRow[]
  shownCount: number
  totalCount: number
  search: string
}

type HostMessage = ModelMessage

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "filter"; search: string }
  | { type: "install"; slug: string }
  | { type: "spawn"; slug: string }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (typeof value !== "object" || value === null) return false
  if (!("type" in value)) return false
  return typeof value.type === "string"
}

class HarnessesWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private search = ""
  private adapters: AdapterInfo[] = []
  // Optimistic "Installing…" state set the moment the click fires. Cleared in
  // bulk on the next adapters refresh (see fetch()) — that refresh is the
  // authoritative signal that an install attempt has settled, whether it
  // succeeded or failed, since installHarness's `finally` always calls
  // provider.refresh() (packages/vscode/src/commands/harnesses.ts).
  private installingSlugs = new Set<string>()

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: DaemonClient,
    private readonly treeProvider: HarnessesTreeProvider,
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
    try {
      this.adapters = await this.client.listAdapters()
    } catch {
      this.adapters = []
    }
    // Authoritative refresh lands — drop any optimistic "installing" flags
    // and let buildHarnessesWebviewModel derive the real action from the
    // fresh adapter statuses (ready → "start", still-installable → "install").
    this.installingSlugs.clear()
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
      case "install": {
        const adapter = this.adapters.find(a => a.slug === msg.slug)
        if (adapter) {
          // Flip the row to "Installing…" immediately, before the command
          // (which shows its own progress notification and awaits the
          // daemon) resolves — the row's own feedback shouldn't wait on that.
          this.installingSlugs.add(msg.slug)
          this.post()
          const node: HarnessNode = { adapter }
          void vscode.commands.executeCommand("agentproto.installHarness", node)
        }
        return
      }
      case "spawn": {
        const adapter = this.adapters.find(a => a.slug === msg.slug)
        if (adapter) {
          const node: HarnessNode = { adapter }
          void vscode.commands.executeCommand("agentproto.spawnWithHarness", node)
        }
        return
      }
    }
  }

  private post(): void {
    if (!this.view) return
    const model = buildHarnessesWebviewModel(this.adapters, this.search, this.installingSlugs)
    const message: ModelMessage = {
      type: "model",
      rows: model.rows.map(r => toRenderRow(r, this.view!.webview, this.extensionUri)),
      shownCount: model.shownCount,
      totalCount: model.totalCount,
      search: this.search,
    }
    void this.view.webview.postMessage(message satisfies HostMessage)
  }
}

export function registerHarnessesWebview(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  treeProvider: HarnessesTreeProvider,
): void {
  const provider = new HarnessesWebviewProvider(ctx.extensionUri, client, treeProvider)
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider),
    treeProvider.onDidChangeTreeData(() => provider.refresh()),
  )
}

function randomNonce(): string {
  return randomBytes(16).toString("hex")
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => {
    return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
  })
}

function logoHtml(logo: RenderLogo): string {
  if (logo.kind === "lettermark") {
    return `<span class="logo mono">${escapeHtml(logo.text)}</span>`
  }
  if (logo.file.endsWith(".svg")) {
    return `<span class="logo svg" data-src="${escapeHtml(logo.uri)}" data-file="${escapeHtml(logo.file)}"></span>`
  }
  return `<span class="logo img"><img src="${escapeHtml(logo.uri)}" alt="" /></span>`
}

function toRenderLogo(logo: HarnessWebviewRow["logo"], webview: vscode.Webview, extensionUri: vscode.Uri): RenderLogo {
  if (logo.kind === "lettermark") return logo
  const uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "icons", "adapters", logo.file))
  return { kind: "icon", file: logo.file, uri: uri.toString() }
}

function toRenderRow(row: HarnessWebviewRow, webview: vscode.Webview, extensionUri: vscode.Uri): RenderRow {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    installable: row.installable,
    action: row.action,
    logo: toRenderLogo(row.logo, webview, extensionUri),
  }
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
  <title>agentproto harnesses</title>
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
    .row {
      position: relative; padding: 7px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      cursor: pointer; display: grid; grid-template-columns: 10px 20px 1fr auto; column-gap: 8px; align-items: center;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; justify-self: center; }
    .dot.ready { background: var(--vscode-charts-green, #2ea043); }
    .dot.available { background: var(--vscode-editorWarning-foreground, #cca700); opacity: 0.9; }
    .dot.dim { background: var(--vscode-descriptionForeground); opacity: 0.45; }
    .logo { width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; color: var(--vscode-foreground); }
    .logo.svg svg { width: 14px; height: 14px; display: block; }
    .logo.img img { width: 15px; height: 15px; object-fit: contain; border-radius: 3px; }
    .logo.mono {
      width: 16px; height: 16px; border-radius: 50%; background: rgba(255,255,255,0.08);
      font-size: 9px; font-weight: 700; letter-spacing: -0.02em;
    }
    .mid { min-width: 0; }
    .name { font-size: 12.5px; font-weight: 550; letter-spacing: -0.01em; color: var(--vscode-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .desc { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
    .desc .pipe { opacity: 0.5; margin: 0 4px; }
    .act {
      font-family: var(--vscode-font-family); font-size: 11px; line-height: 1;
      padding: 3px 10px; border-radius: 4px; border: 1px solid var(--vscode-descriptionForeground);
      background: transparent; color: var(--vscode-descriptionForeground); opacity: 0.7;
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
      min-width: 64px;
    }
    .act.primary { color: var(--vscode-foreground); opacity: 0.85; }
    .row:hover .act, .act:hover, .act:focus-visible { opacity: 1; color: var(--vscode-foreground); border-color: var(--vscode-foreground); }
    .act:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .act[disabled] { cursor: default; }
    .act .tri { font-size: 8px; }
    .spin {
      width: 10px; height: 10px; border: 1.5px solid var(--vscode-descriptionForeground);
      border-top-color: var(--vscode-foreground); border-radius: 50%;
      animation: agentproto-harness-spin 0.8s linear infinite; display: inline-block;
    }
    @keyframes agentproto-harness-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
    #empty { padding: 32px 16px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
    #empty[hidden] { display: none; }
  </style>
</head>
<body>
  <div id="search">
    <span class="mag" aria-hidden="true">⌕</span>
    <input id="q" placeholder="Filter harnesses…" autocomplete="off" />
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

      function actionHTML(r) {
        if (r.action === 'start') {
          return '<button class="act primary" data-act="start" title="Start a session with ' + escapeHtml(r.name) + '"><span class="tri">▶</span>Start</button>';
        }
        if (r.action === 'installing') {
          return '<button class="act" disabled><span class="spin"></span>Installing…</button>';
        }
        return '<button class="act" data-act="install">Install</button>';
      }

      function rowHTML(r) {
        return '<div class="row" tabindex="0" data-slug="' + escapeHtml(r.slug) + '" data-act="' + escapeHtml(r.action) + '">' +
          '<span class="dot ' + r.status + '"></span>' +
          logoHtml(r.logo) +
          '<div class="mid">' +
            '<div class="name">' + escapeHtml(r.name) + '</div>' +
            '<div class="desc">' + escapeHtml(r.description).replace(/ · /g, '<span class="pipe">·</span>') + '</div>' +
          '</div>' +
          actionHTML(r) +
        '</div>';
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
              if (el.dataset.file !== 'claude.svg' && el.dataset.file !== 'openclaw.png') {
                svgEl.style.color = 'var(--vscode-foreground)';
              }
            }
          })
          .catch(function () {});
      }

      function render(payload) {
        var html = '';
        for (var i = 0; i < payload.rows.length; i++) {
          html += rowHTML(payload.rows[i]);
        }
        listEl.innerHTML = html;
        emptyEl.hidden = payload.rows.length !== 0;
        var summary = payload.search.trim().length > 0
          ? payload.shownCount + ' of ' + payload.totalCount + ' shown'
          : payload.totalCount + ' installed';
        summaryEl.textContent = summary;
        var svgs = listEl.querySelectorAll('.logo.svg');
        for (var j = 0; j < svgs.length; j++) loadSvg(svgs[j]);
      }

      function fireRow(row) {
        if (!row) return;
        var act = row.getAttribute('data-act');
        var slug = row.getAttribute('data-slug');
        if (act === 'installing') return;
        if (act === 'install') {
          vscode.postMessage({ type: 'install', slug: slug });
        } else if (act === 'start') {
          vscode.postMessage({ type: 'spawn', slug: slug });
        }
      }

      listEl.addEventListener('click', function (e) {
        fireRow(e.target.closest('.row'));
      });
      listEl.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var row = e.target.closest('.row');
        if (!row) return;
        e.preventDefault();
        fireRow(row);
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
