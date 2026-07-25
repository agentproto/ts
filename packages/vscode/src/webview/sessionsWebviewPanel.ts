/**
 * Sessions webview panel — the opt-in WebviewView alternative to the
 * Sessions TreeView (`agentproto.sessionsView === "webview"`, see
 * package.json's mutually-exclusive `when` clauses on
 * `agentproto.sessions` / `agentproto.sessionsWebview`). Reproduces
 * `sessions-webview-demo-models.html` (the locked design mock): a pinned
 * live-filter input, plain-text status tabs, two-line rows with a harness
 * glyph + model, subagent nesting, and an "open in tab" indicator — all
 * theme-aware via `--vscode-*` tokens (the mock hardcodes a dark palette;
 * this does not).
 *
 * Every grouping/filter/nesting DECISION is delegated to
 * sessionsWebview.logic.ts (which itself delegates to the tree's own
 * sessionsTree.logic.ts / sessionsGroups.logic.ts / sessionFilter.logic.ts)
 * — this file only turns that model into HTML/postMessage traffic and wires
 * VS Code's live-update sources. It reads the SAME SessionStore the tree
 * does (no second poll loop) and opens transcripts through the SAME
 * `TranscriptPanels.open()` the tree's click handler uses.
 *
 * CSP/nonce/`--vscode-*` pattern copied from transcriptPanel.ts.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { SessionDescriptor } from "../client/types.js"
import type { SessionFilterController } from "../commands/sessionFilter.js"
import { isPendingSession } from "../services/pending.logic.js"
import type { SessionStore } from "../services/sessionStore.js"
import {
  buildSessionsWebviewModel,
  summaryTextFor,
  type SessionsWebviewTab,
  type WebviewGroup,
  type WebviewRow,
} from "./sessionsWebview.logic.js"
import type { TranscriptPanels } from "./transcriptPanel.js"

const VIEW_TYPE = "agentproto.sessionsWebview"

/** Reads live: the operator can add/close a folder mid-session, same reasoning as sessionsTree.ts's own openFolderPaths(). */
function openFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
}

/** Row shape actually POSTed to the webview — `session` is stripped (the host resolves clicks by id against the live store) and `open` is computed fresh from `TranscriptPanels.activeSessionId()` on every render. */
interface RenderRow {
  id: string
  isSub: boolean
  open: boolean
  status: WebviewRow["status"]
  name: string
  message: string | undefined
  tag: string
  harnessGlyph: string
  model: string | undefined
  ctxPercent: number | undefined
  cost: string | undefined
  time: string
}

interface RenderGroup {
  id: string
  name: string
  count: number
  recent: RenderRow[]
  older: RenderRow[]
}

interface ModelMessage {
  type: "model"
  groups: RenderGroup[]
  summary: string
}

type HostMessage = ModelMessage

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "open"; id: string }
  | { type: "filter"; search: string }
  | { type: "tab"; tab: SessionsWebviewTab }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  )
}

function toRenderRow(row: WebviewRow, activeSessionId: string | undefined): RenderRow {
  return {
    id: row.id,
    isSub: row.isSub,
    open: row.id === activeSessionId,
    status: row.status,
    name: row.name,
    message: row.message,
    tag: row.tag,
    harnessGlyph: row.harnessGlyph,
    model: row.model,
    ctxPercent: row.ctxPercent,
    cost: row.cost,
    time: row.time,
  }
}

function toRenderGroup(group: WebviewGroup, activeSessionId: string | undefined): RenderGroup {
  return {
    id: group.id,
    name: group.name,
    count: group.count,
    recent: group.section.recent.map(r => toRenderRow(r, activeSessionId)),
    older: group.section.older.map(r => toRenderRow(r, activeSessionId)),
  }
}

class SessionsWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private tab: SessionsWebviewTab = "all"
  private search = ""

  constructor(
    private readonly store: SessionStore,
    private readonly filter: SessionFilterController,
    private readonly transcriptPanels: TranscriptPanels,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.html = buildHtml(randomNonce())

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isWebviewToHostMessage(raw)) return
      this.handleMessage(raw)
    })

    // A hidden view stops receiving webview.postMessage traffic reliably in
    // some hosts — repaint on reveal so a webview that missed updates while
    // collapsed catches up immediately rather than waiting for the next
    // store tick.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.post()
    })

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined
    })
  }

  /** Called by registerSessionsWebview's store/filter/tab subscriptions — any source of truth this view depends on changed. */
  refresh(): void {
    this.post()
  }

  private handleMessage(msg: WebviewToHostMessage): void {
    switch (msg.type) {
      case "ready":
        this.post()
        return
      case "filter":
        this.search = msg.search
        this.post()
        return
      case "tab":
        this.tab = msg.tab
        this.post()
        return
      case "open": {
        const session = this.findSession(msg.id)
        if (session && !isPendingSession(session)) this.transcriptPanels.open(session)
        return
      }
    }
  }

  private findSession(id: string): SessionDescriptor | undefined {
    return this.store.sessions.find(s => s.id === id)
  }

  private post(): void {
    if (!this.view) return
    const model = buildSessionsWebviewModel(this.store.sessions, this.filter.workspaces, openFolderPaths(), {
      tab: this.tab,
      search: this.search,
      now: Date.now(),
    })
    const activeSessionId = this.transcriptPanels.activeSessionId()
    const filterActive = this.tab !== "all" || this.search.trim().length > 0
    const message: ModelMessage = {
      type: "model",
      groups: model.groups.map(g => toRenderGroup(g, activeSessionId)),
      summary: summaryTextFor(model, filterActive),
    }
    void this.view.webview.postMessage(message satisfies HostMessage)
  }
}

/**
 * Registers the WebviewViewProvider and wires every live-update source: the
 * shared SessionStore (same poll loop the tree uses), the filter
 * controller's workspace-label cache, and the "open in tab" indicator's
 * source of truth (`TranscriptPanels.activeSessionId()`) — kept current via
 * `vscode.window.tabGroups.onDidChangeTabs`, which fires on every tab
 * activate/close/move, distinct from a plain click-selection.
 */
export function registerSessionsWebview(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
  filter: SessionFilterController,
  transcriptPanels: TranscriptPanels,
): void {
  const provider = new SessionsWebviewProvider(store, filter, transcriptPanels)
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider),
    store.onDidChange(() => provider.refresh()),
    filter.onDidChange(() => provider.refresh()),
    vscode.window.tabGroups.onDidChangeTabs(() => provider.refresh()),
  )
}

function randomNonce(): string {
  return randomBytes(16).toString("hex")
}

/** Exported so sessionsWebview.dom.test.ts can execute the exact shipped HTML/script in jsdom. */
export function buildHtml(nonce: string): string {
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
  <title>agentproto sessions</title>
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
    /* ── Pinned filter ─────────────────────────────────────────────── */
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
    /* ── Status tabs — plain text, underline on active, NOT chips ────── */
    #tabs { flex: 0 0 auto; display: flex; gap: 16px; padding: 10px 12px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); }
    .tab {
      font-size: 11px; color: var(--vscode-descriptionForeground); cursor: pointer;
      padding-bottom: 3px; border-bottom: 1.5px solid transparent;
      display: flex; align-items: center; gap: 5px; user-select: none;
    }
    .tab:hover { color: var(--vscode-foreground); }
    .tab.on { color: var(--vscode-foreground); border-bottom-color: var(--vscode-foreground); }
    #summary { flex: 0 0 auto; padding: 6px 12px 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
    /* ── List ──────────────────────────────────────────────────────── */
    #list { flex: 1 1 auto; overflow-y: auto; }
    .section {
      padding: 16px 12px 4px; font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--vscode-descriptionForeground);
      display: flex; justify-content: space-between; align-items: baseline;
    }
    .section .c { font-weight: 400; }
    .subhead { padding: 10px 12px 4px; font-size: 10px; color: var(--vscode-descriptionForeground); }
    /* No cards, no boxes, no rounded corners — hairline separators only. */
    .row {
      position: relative; padding: 9px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      cursor: pointer; display: grid; grid-template-columns: 10px 1fr auto; column-gap: 10px; align-items: start;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.open { background: rgba(127,127,127,0.08); box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
    .row.open .name { color: var(--vscode-foreground); font-weight: 600; }
    /* Nested subagents: indentation + dimming only, no connector line, no box. */
    .row.sub { padding-left: 34px; border-bottom-color: transparent; }
    .row.sub + .row:not(.sub) { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); }
    .row.sub .name { font-size: 12.5px; font-weight: 500; color: var(--vscode-descriptionForeground); }
    .row.sub .dot { width: 5px; height: 5px; opacity: 0.7; }
    .dot { margin-top: 5px; width: 7px; height: 7px; }
    .dot.live { background: var(--vscode-charts-green, #2ea043); border-radius: 50%; }
    .dot.awaiting { border: 1.5px solid var(--vscode-editorWarning-foreground, #cca700); border-radius: 50%; }
    .dot.done { background: var(--vscode-descriptionForeground); border-radius: 50%; opacity: 0.5; }
    .mid { min-width: 0; }
    .name {
      font-size: 13px; font-weight: 550; color: var(--vscode-foreground); letter-spacing: -0.01em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px;
    }
    .msg {
      margin-top: 3px; font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.4;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .tags { margin-top: 5px; display: flex; align-items: center; gap: 9px; font-size: 10.5px; color: var(--vscode-descriptionForeground); flex-wrap: wrap; }
    .tag.harness { display: inline-flex; align-items: center; gap: 4px; }
    .tag.model { color: var(--vscode-foreground); opacity: 0.75; }
    .tag.cost { font-variant-numeric: tabular-nums; }
    .ctxbar { display: inline-flex; align-items: center; gap: 5px; }
    .ctxbar .track { width: 22px; height: 2px; background: var(--vscode-panel-border, rgba(128,128,128,0.35)); position: relative; }
    .ctxbar .fill { position: absolute; inset: 0 auto 0 0; background: var(--vscode-descriptionForeground); }
    .right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; padding-top: 1px; min-height: 14px; }
    .time { font-size: 10.5px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .row:hover .time { display: none; }
    .acts { display: none; } .row:hover .acts { display: block; }
    .acts span { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .acts span:hover { color: var(--vscode-foreground); }
    #empty { padding: 32px 16px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
    #empty[hidden] { display: none; }
  </style>
</head>
<body>
  <div id="search">
    <span class="mag" aria-hidden="true">⌕</span>
    <input id="q" placeholder="Filter" autocomplete="off" />
    <span id="clear" title="Clear filter">✕</span>
  </div>
  <div id="tabs">
    <div class="tab on" data-tab="all">All</div>
    <div class="tab" data-tab="live"><span class="dot live"></span>Live</div>
    <div class="tab" data-tab="awaiting"><span class="dot awaiting"></span>Awaiting</div>
    <div class="tab" data-tab="done">Done</div>
  </div>
  <div id="summary"></div>
  <div id="list"></div>
  <div id="empty" hidden>Nothing matches.</div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const qEl = document.getElementById('q');
      const clearEl = document.getElementById('clear');
      const tabsEl = document.getElementById('tabs');
      const listEl = document.getElementById('list');
      const emptyEl = document.getElementById('empty');
      const summaryEl = document.getElementById('summary');

      function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, function (ch) {
          return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;';
        });
      }

      function rowHTML(r) {
        var classes = 'row' + (r.isSub ? ' sub' : '') + (r.open ? ' open' : '');
        var tags = '<span class="tag">' + escapeHtml(r.tag) + '</span>';
        tags += '<span class="tag harness"><span class="g">' + escapeHtml(r.harnessGlyph) + '</span>' +
          (r.model ? '<span class="model">' + escapeHtml(r.model) + '</span>' : '') + '</span>';
        if (typeof r.ctxPercent === 'number') {
          tags += '<span class="ctxbar"><span class="track"><span class="fill" style="width:' + r.ctxPercent +
            '%"></span></span>' + r.ctxPercent + '%</span>';
        }
        if (r.cost) tags += '<span class="tag cost">' + escapeHtml(r.cost) + '</span>';
        return '<div class="' + classes + '" data-id="' + escapeHtml(r.id) + '" data-status="' + r.status + '">' +
          '<span class="dot ' + r.status + '"></span>' +
          '<div class="mid">' +
            '<div class="name"><span>' + escapeHtml(r.name) + '</span></div>' +
            (r.message ? '<div class="msg">' + escapeHtml(r.message) + '</div>' : '') +
            '<div class="tags">' + tags + '</div>' +
          '</div>' +
          '<div class="right"><span class="time">' + escapeHtml(r.time) + '</span>' +
            '<span class="acts"><span title="Open in tab" data-open="' + escapeHtml(r.id) + '">↗</span></span></div>' +
        '</div>';
      }

      function render(payload) {
        var html = '';
        var shown = 0;
        for (var i = 0; i < payload.groups.length; i++) {
          var g = payload.groups[i];
          if (g.recent.length + g.older.length === 0) continue;
          shown += g.recent.length + g.older.length;
          html += '<div class="section">' + escapeHtml(g.name) + '<span class="c">' + g.count + '</span></div>';
          for (var j = 0; j < g.recent.length; j++) html += rowHTML(g.recent[j]);
          if (g.older.length > 0) {
            html += '<div class="subhead">Older than 24 hours</div>';
            for (var k = 0; k < g.older.length; k++) html += rowHTML(g.older[k]);
          }
        }
        listEl.innerHTML = html;
        emptyEl.hidden = shown !== 0;
        summaryEl.textContent = payload.summary;
      }

      listEl.addEventListener('click', function (e) {
        var openBtn = e.target.closest('[data-open]');
        var row = e.target.closest('.row');
        var id = openBtn ? openBtn.getAttribute('data-open') : row ? row.getAttribute('data-id') : null;
        if (id) vscode.postMessage({ type: 'open', id: id });
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

      tabsEl.addEventListener('click', function (e) {
        var t = e.target.closest('.tab');
        if (!t) return;
        var tabs = tabsEl.querySelectorAll('.tab');
        for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('on');
        t.classList.add('on');
        vscode.postMessage({ type: 'tab', tab: t.getAttribute('data-tab') });
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
