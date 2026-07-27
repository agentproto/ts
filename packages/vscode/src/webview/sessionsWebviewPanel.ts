/**
 * Sessions webview panel — the opt-in WebviewView alternative to the
 * Sessions TreeView (`agentproto.sessionsView === "webview"`, see
 * package.json's mutually-exclusive `when` clauses on
 * `agentproto.sessions` / `agentproto.sessionsWebview`). Reproduces
 * `sessions-webview-demo-models.html` (the locked design mock): a pinned
 * live-filter input, plain-text status tabs, two-line rows with a harness
 * glyph + model, subagent nesting, workspace tags, lifecycle actions, and
 * an "open in tab" indicator — all theme-aware via `--vscode-*` tokens.
 *
 * PROGRESSIVE LOADING ARCHITECTURE: the webview uses a dedicated summary
 * endpoint (`GET /sessions/summaries`) rather than the full
 * `SessionDescriptor` snapshot the tree consumes. The daemon projects each
 * row down to the fields the panel actually renders and supports
 * limit/offset pagination. The webview loads the first page immediately for
 * a bounded first paint, then offers a "Load more" affordance for older
 * sessions. Live correctness is preserved by refreshing the currently loaded
 * summary slice whenever the shared SessionStore signals a change (lifecycle
 * events, descriptor refresh). Pending optimistic rows are merged from the
 * store so a spawn in flight appears instantly.
 *
 * CSP/nonce/`--vscode-*` pattern copied from transcriptPanel.ts.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor, SessionSummary } from "../client/types.js"
import type { SessionFilterController } from "../commands/sessionFilter.js"
import { describeSession, isLiveSession } from "../commands/sessionActions.logic.js"
import { canArchive, canUnarchive } from "../commands/sessionArchive.logic.js"
import { isPendingSession } from "../services/pending.logic.js"
import type { SeenTracker } from "../services/seen.js"
import type { DaemonConnectionState, SessionStore } from "../services/sessionStore.js"
import {
  buildSessionsWebviewModel,
  summaryTextFor,
  type RowAction,
  type SessionsWebviewTab,
  type WebviewRow,
  type WebviewWorkspace,
  workspaceColorFor,
} from "./sessionsWebview.logic.js"
import type { TranscriptPanels } from "./transcriptPanel.js"

const VIEW_TYPE = "agentproto.sessionsWebview"
const PAGE_SIZE = 50
const SETUP_DOCS_URL = "https://agentproto.sh/docs"
const CLAUDE_SETUP_PROMPT =
  "Set up Agentproto for this VS Code workspace. Install the Agentproto CLI, start its local daemon, register this workspace, connect Claude Code through the Agentproto MCP bridge, and verify that the Agentproto Sessions panel is live. Explain each command before I run it."

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
  unread: boolean
  action: RowAction | undefined
  workspace: (WebviewWorkspace & { css: string }) | undefined
  archived: boolean
}

interface RenderSection {
  recent: RenderRow[]
  older: RenderRow[]
}

interface ModelMessage {
  type: "model"
  connection: DaemonConnectionState
  section: RenderSection
  summary: string
  loading: boolean
  hasMore: boolean
  loadError: string | undefined
}

type HostMessage = ModelMessage

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openDocs" }
  | { type: "copyClaudePrompt" }
  | { type: "open"; id: string }
  | { type: "filter"; search: string }
  | { type: "tab"; tab: SessionsWebviewTab }
  | { type: "stop"; id: string }
  | { type: "archive"; id: string }
  | { type: "unarchive"; id: string }
  | { type: "loadMore" }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  )
}

function toRenderRow(row: WebviewRow, activeSessionId: string | undefined, seen: SeenTracker): RenderRow {
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
    unread: seen.isUnread(row.session),
    action: row.action,
    workspace: row.workspace ? { ...row.workspace, css: workspaceColorFor(row.workspace.slug).css } : undefined,
    archived: row.archived,
  }
}

class SessionsWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private tab: SessionsWebviewTab = "all"
  private search = ""

  private summaries: SessionSummary[] = []
  private serverTotal = 0
  private loading = false
  private loadError: string | undefined

  constructor(
    private readonly client: DaemonClient,
    private readonly store: SessionStore,
    private readonly filter: SessionFilterController,
    private readonly transcriptPanels: TranscriptPanels,
    private readonly seen: SeenTracker,
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

    // Align canonical archive visibility with the active tab when the view first appears.
    this.syncArchivedFlag()

    // Initial bounded load: first page only. The list renders immediately
    // without waiting for the full daemon snapshot.
    void this.loadInitial()
  }

  /** Called by registerSessionsWebview's store/filter/tab subscriptions — any source of truth this view depends on changed. */
  refresh(): void {
    void this.refreshSummaries()
  }

  private handleMessage(msg: WebviewToHostMessage): void {
    switch (msg.type) {
      case "ready":
        this.post()
        return
      case "refresh":
        void this.refreshDaemon()
        return
      case "openDocs":
        void vscode.env.openExternal(vscode.Uri.parse(SETUP_DOCS_URL))
        return
      case "copyClaudePrompt":
        void this.copyClaudeSetupPrompt()
        return
      case "filter":
        this.search = msg.search
        this.post()
        return
      case "tab":
        this.setTab(msg.tab)
        return
      case "open": {
        void this.openSession(msg.id)
        return
      }
      case "stop":
        void this.runSessionAction(msg.id, "stop")
        return
      case "archive":
        void this.runSessionAction(msg.id, "archive")
        return
      case "unarchive":
        void this.runSessionAction(msg.id, "unarchive")
        return
      case "loadMore":
        void this.loadMore()
        return
    }
  }

  private setTab(next: SessionsWebviewTab): void {
    const previous = this.tab
    this.tab = next
    if (next === "archived" && !this.store.showArchived) {
      this.store.setShowArchived(true)
    } else if (previous === "archived" && this.store.showArchived) {
      this.store.setShowArchived(false)
    }
    // Tab changes reset the loaded set: different archived visibility and a
    // fresh first page keep the model coherent.
    void this.loadInitial()
  }

  private async refreshDaemon(): Promise<void> {
    await this.store.refreshAll()
    this.post()
  }

  private async copyClaudeSetupPrompt(): Promise<void> {
    await vscode.env.clipboard.writeText(CLAUDE_SETUP_PROMPT)
    void vscode.window.showInformationMessage("Agentproto setup prompt copied — paste it into Claude Code.")
  }

  private syncArchivedFlag(): void {
    if (this.tab === "archived" && !this.store.showArchived) {
      this.store.setShowArchived(true)
    } else if (this.tab !== "archived" && this.store.showArchived) {
      this.store.setShowArchived(false)
    }
  }

  private async openSession(id: string): Promise<void> {
    if (isPendingSession({ id })) return
    const session = await this.resolveSession(id)
    if (session) this.transcriptPanels.open(session)
  }

  private async resolveSession(id: string): Promise<SessionDescriptor | undefined> {
    const fromStore = this.store.sessions.find(s => s.id === id)
    if (fromStore) return fromStore
    try {
      return await this.client.getSession(id)
    } catch (err) {
      vscode.window.showWarningMessage(`agentproto: session ${id} not found.`)
      return undefined
    }
  }

  private async runSessionAction(
    id: string,
    action: RowAction,
  ): Promise<void> {
    if (isPendingSession({ id })) {
      vscode.window.showWarningMessage(`agentproto: session ${id} is still starting.`)
      return
    }
    const summary = this.summaries.find(s => s.id === id)
    if (!summary) {
      vscode.window.showWarningMessage(`agentproto: session ${id} no longer exists.`)
      return
    }
    const label = describeSession(summary)
    try {
      if (action === "stop") {
        if (!isLiveSession(summary)) {
          vscode.window.showWarningMessage(`agentproto: ${label} is no longer running.`)
          return
        }
        await this.client.kill(id)
        await this.store.refreshAll()
        const restart = await vscode.window.showInformationMessage(
          `agentproto: stopped ${label}`,
          "Restart",
        )
        if (restart === "Restart") {
          await vscode.commands.executeCommand("agentproto.restartSession", id)
        }
      } else if (action === "archive") {
        if (!canArchive(summary)) {
          vscode.window.showWarningMessage(
            `agentproto: ${label} can't be archived — only an exited/killed/error session may be archived.`,
          )
          return
        }
        await this.client.archiveSession(id)
        await this.store.refreshAll()
        vscode.window.showInformationMessage(`agentproto: archived ${label}`)
      } else if (action === "unarchive") {
        if (!canUnarchive(summary)) {
          vscode.window.showWarningMessage(`agentproto: ${label} is not archived.`)
          return
        }
        await this.client.unarchiveSession(id)
        await this.store.refreshAll()
        vscode.window.showInformationMessage(`agentproto: unarchived ${label}`)
      }
    } catch (err) {
      vscode.window.showErrorMessage(`agentproto: ${action} failed — ${describeError(err)}`)
    }
  }

  private async loadInitial(): Promise<void> {
    this.summaries = []
    this.serverTotal = 0
    this.loadError = undefined
    await this.fetchPage(0)
  }

  private async loadMore(): Promise<void> {
    if (this.loading) return
    await this.fetchPage(this.summaries.length)
  }

  private async fetchPage(offset: number): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.loadError = undefined
    this.post()
    try {
      const result = await this.client.listSessionSummaries({
        includeArchived: this.tab === "archived",
        limit: PAGE_SIZE,
        offset,
      })
      if (offset === 0) {
        this.summaries = result.summaries
      } else {
        this.summaries = [...this.summaries, ...result.summaries]
      }
      this.serverTotal = result.total
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err)
    } finally {
      this.loading = false
      this.post()
    }
  }

  /**
   * Live refresh of the currently loaded slice. Triggered by SessionStore
   * lifecycle events, this re-fetches the first N summaries (where N is how
   * many rows the user has already loaded) so active/recent status changes
   * appear without a manual reload while keeping the request bounded.
   */
  private async refreshSummaries(): Promise<void> {
    if (this.loading || this.summaries.length === 0) return
    this.loading = true
    try {
      const result = await this.client.listSessionSummaries({
        includeArchived: this.tab === "archived",
        limit: this.summaries.length,
        offset: 0,
      })
      this.summaries = result.summaries
      this.serverTotal = result.total
      this.loadError = undefined
    } catch (err) {
      // Keep the existing loaded data; surface the error only if we're not
      // already showing something useful.
      this.loadError = err instanceof Error ? err.message : String(err)
    } finally {
      this.loading = false
      this.post()
    }
  }

  private post(): void {
    if (!this.view) return
    const pendingRows = this.store.sessions.filter(isPendingSession)
    const model = buildSessionsWebviewModel([...pendingRows, ...this.summaries], this.filter.workspaces, {
      tab: this.tab,
      search: this.search,
      now: Date.now(),
    })
    const activeSessionId = this.transcriptPanels.activeSessionId()
    const filterActive = this.tab !== "all" || this.search.trim().length > 0
    const hasMore = this.summaries.length < this.serverTotal
    const message: ModelMessage = {
      type: "model",
      connection: this.store.connectionState,
      section: {
        recent: model.section.recent.map(r => toRenderRow(r, activeSessionId, this.seen)),
        older: model.section.older.map(r => toRenderRow(r, activeSessionId, this.seen)),
      },
      summary: summaryTextFor(model, filterActive),
      loading: this.loading,
      hasMore,
      loadError: this.loadError,
    }
    void this.view.webview.postMessage(message satisfies HostMessage)
  }
}

/**
 * Registers the WebviewViewProvider and wires every live-update source: the
 * shared SessionStore (lifecycle events + pending rows), the filter
 * controller's workspace-label cache, and the "open in tab" indicator's
 * source of truth (`TranscriptPanels.activeSessionId()`) — kept current via
 * `vscode.window.tabGroups.onDidChangeTabs`, which fires on every tab
 * activate/close/move, distinct from a plain click-selection.
 */
export function registerSessionsWebview(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
  filter: SessionFilterController,
  transcriptPanels: TranscriptPanels,
  seen: SeenTracker,
): void {
  const provider = new SessionsWebviewProvider(client, store, filter, transcriptPanels, seen)
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider),
    store.onDidChange(() => provider.refresh()),
    filter.onDidChange(() => provider.refresh()),
    seen.onDidChange(() => provider.refresh()),
    vscode.window.tabGroups.onDidChangeTabs(() => provider.refresh()),
  )
}

function randomNonce(): string {
  return randomBytes(16).toString("hex")
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
    /* ── Daemon connection / first-run state ───────────────────────── */
    #daemon-state { display: none; flex: 1 1 auto; min-height: 0; padding: 24px 18px; align-items: center; justify-content: center; }
    body.daemon-state > #search,
    body.daemon-state > #workspace,
    body.daemon-state > #tabs,
    body.daemon-state > #summary,
    body.daemon-state > #list,
    body.daemon-state > #empty { display: none !important; }
    body.daemon-state > #daemon-state { display: flex; }
    .daemon-card { width: min(100%, 360px); text-align: center; color: var(--vscode-foreground); }
    .daemon-mark { width: 32px; height: 32px; margin: 0 auto 14px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: var(--vscode-focusBorder); border-radius: 50%; }
    #daemon-state[data-state="connecting"] .daemon-mark { animation: agentproto-daemon-spin 1s linear infinite; }
    @keyframes agentproto-daemon-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { #daemon-state[data-state="connecting"] .daemon-mark { animation: none; } }
    .daemon-card h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .daemon-card p { margin: 8px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; }
    .daemon-command { margin: 16px 0 0; padding: 9px 10px; overflow-x: auto; text-align: left; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.08)); color: var(--vscode-textPreformat-foreground, var(--vscode-foreground)); font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .daemon-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
    .daemon-actions button { width: 100%; min-height: 28px; padding: 4px 10px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); cursor: pointer; font: inherit; font-size: 12px; }
    .daemon-actions button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .daemon-actions button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.3)); }
    .daemon-actions button.primary:hover { background: var(--vscode-button-hoverBackground); }
    #daemon-state[data-state="connecting"] .offline-only { display: none; }
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
    .row.archived { opacity: 0.75; }
    /* Nested subagents: indentation + dimming only, no connector line, no box. */
    .row.sub { padding-left: 34px; border-bottom-color: transparent; }
    .row.sub + .row:not(.sub) { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); }
    .row.sub .name { font-size: 12.5px; font-weight: 500; color: var(--vscode-descriptionForeground); }
    .row.sub .dot { width: 5px; height: 5px; opacity: 0.7; }
    .dot { margin-top: 5px; width: 7px; height: 7px; border-radius: 50%; }
    /* Only genuinely working rows pulse green. Filter tabs are plain text, never animated dots. */
    .dot.working { background: var(--vscode-charts-green, #2ea043); animation: agentproto-pulse-live 1.6s ease-in-out infinite; }
    .dot.awaiting { border: 1.5px solid var(--vscode-editorWarning-foreground, #cca700); background: transparent; }
    .dot.idle { border: 1.5px solid var(--vscode-descriptionForeground); background: transparent; opacity: 0.65; }
    .dot.stalled { background: var(--vscode-editorWarning-foreground, #cca700); }
    .dot.failed { background: var(--vscode-editorError-foreground, #f85149); }
    .dot.stopped { border: 1.5px solid var(--vscode-descriptionForeground); background: transparent; opacity: 0.5; }
    .dot.done { border: 1.5px solid var(--vscode-descriptionForeground); background: transparent; opacity: 0.5; }
    .dot.done.unread { background: var(--vscode-charts-green, #2ea043); border-color: var(--vscode-charts-green, #2ea043); opacity: 1; }
    @keyframes agentproto-pulse-live { 0%, 100% { opacity: 0.55; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1); } }
    @media (prefers-reduced-motion: reduce) { .dot.working { animation: none; } }
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
    .right { position: relative; display: grid; align-items: center; justify-items: end; padding-top: 1px; min-height: 14px; }
    .time { grid-area: 1 / 1; font-size: 10.5px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; opacity: 1; }
    .row:hover .time { opacity: 0; }
    .acts { grid-area: 1 / 1; opacity: 0; display: flex; gap: 6px; }
    .row:hover .acts { opacity: 1; }
    .act {
      display: inline-flex; align-items: center; justify-content: center;
      width: 16px; height: 16px; color: var(--vscode-descriptionForeground);
      font-size: 11px; cursor: pointer; border-radius: 3px;
    }
    .act:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.2)); color: var(--vscode-foreground); }
    .act.stop { color: var(--vscode-charts-red, #f85149); }
    .act.stop:hover { color: var(--vscode-errorForeground, #f85149); }
    .act.archive { color: var(--vscode-descriptionForeground); }
    .act.unarchive { color: var(--vscode-descriptionForeground); }
    #empty { padding: 32px 16px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
    #empty[hidden] { display: none; }
    /* ── Load more / progress footer ───────────────────────────────── */
    #footer { flex: 0 0 auto; padding: 8px 12px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); }
    #load-more {
      width: 100%; padding: 6px 0; background: transparent; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      color: var(--vscode-foreground); font-size: 12px; cursor: pointer; font-family: var(--vscode-font-family);
    }
    #load-more:hover { background: var(--vscode-list-hoverBackground); }
    #load-more:disabled { opacity: 0.5; cursor: default; }
    #load-more[hidden] { display: none; }
    #footer-error { padding: 6px 0; font-size: 11px; color: var(--vscode-editorError-foreground); }
    #footer-error[hidden] { display: none; }
    #spinner { padding: 8px 0; text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground); }
    #spinner[hidden] { display: none; }
  </style>
</head>
<body class="daemon-state">
  <section id="daemon-state" data-state="connecting" aria-live="polite">
    <div class="daemon-card">
      <div class="daemon-mark" aria-hidden="true"></div>
      <h2 id="daemon-title">Connecting to agentproto daemon…</h2>
      <p id="daemon-description">Looking for your local daemon. Sessions will appear automatically once it is ready.</p>
      <code class="daemon-command offline-only">agentproto serve</code>
      <div class="daemon-actions">
        <button class="primary" type="button" data-refresh>Try again</button>
        <button class="offline-only" type="button" data-docs>Open setup guide ↗</button>
        <button class="offline-only" type="button" data-copy-claude>Copy a setup prompt for Claude</button>
      </div>
    </div>
  </section>
  <div id="search">
    <span class="mag" aria-hidden="true">⌕</span>
    <input id="q" placeholder="Filter" autocomplete="off" />
    <span id="clear" title="Clear filter">✕</span>
  </div>
  <div id="tabs">
    <div class="tab on" data-tab="all">All</div>
    <div class="tab" data-tab="working">Working</div>
    <div class="tab" data-tab="awaiting">Awaiting</div>
    <div class="tab" data-tab="idle">Idle</div>
    <div class="tab" data-tab="stalled">Stalled / failed</div>
    <div class="tab" data-tab="done">Done</div>
    <div class="tab" data-tab="archived">Archived</div>
  </div>
  <div id="summary"></div>
  <div id="list"></div>
  <div id="empty" hidden>Nothing matches.</div>
  <div id="footer">
    <button id="load-more" hidden>Load more</button>
    <div id="spinner" hidden>Loading…</div>
    <div id="footer-error" hidden></div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const qEl = document.getElementById('q');
      const clearEl = document.getElementById('clear');
      const tabsEl = document.getElementById('tabs');
      const listEl = document.getElementById('list');
      const emptyEl = document.getElementById('empty');
      const summaryEl = document.getElementById('summary');
      const loadMoreEl = document.getElementById('load-more');
      const spinnerEl = document.getElementById('spinner');
      const footerErrorEl = document.getElementById('footer-error');
      const daemonStateEl = document.getElementById('daemon-state');
      const daemonTitleEl = document.getElementById('daemon-title');
      const daemonDescriptionEl = document.getElementById('daemon-description');

      function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, function (ch) {
          return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;';
        });
      }

      function actionButton(r) {
        if (r.action === 'stop') {
          return '<span class="act stop" title="Stop session" aria-label="Stop session" role="button" tabindex="0" data-stop="' + escapeHtml(r.id) + '" data-action>■</span>';
        }
        if (r.action === 'archive') {
          return '<span class="act archive" title="Archive session" aria-label="Archive session" role="button" tabindex="0" data-archive="' + escapeHtml(r.id) + '" data-action>▣</span>';
        }
        if (r.action === 'unarchive') {
          return '<span class="act unarchive" title="Unarchive session" aria-label="Unarchive session" role="button" tabindex="0" data-unarchive="' + escapeHtml(r.id) + '" data-action>↩</span>';
        }
        return '';
      }

      function workspaceTag(r) {
        if (!r.workspace) return '<span class="tag workspace ws-accent">unassigned</span>';
        return '<span class="tag workspace ws-accent" style="color:' + escapeHtml(r.workspace.css || '#808080') + '; border-color:' + escapeHtml(r.workspace.css || '#808080') + ';">' + escapeHtml(r.workspace.label) + '</span>';
      }

      function rowHTML(r) {
        var classes = 'row' + (r.isSub ? ' sub' : '') + (r.open ? ' open' : '') + (r.archived ? ' archived' : '');
        var dotClasses = 'dot ' + r.status + (r.status === 'done' && r.unread ? ' unread' : '');
        var tags = '<span class="tag">' + escapeHtml(r.tag) + '</span>';
        tags += workspaceTag(r);
        tags += '<span class="tag harness"><span class="g">' + escapeHtml(r.harnessGlyph) + '</span>' +
          (r.model ? '<span class="model">' + escapeHtml(r.model) + '</span>' : '') + '</span>';
        if (typeof r.ctxPercent === 'number') {
          tags += '<span class="ctxbar"><span class="track"><span class="fill" style="width:' + r.ctxPercent +
            '%"></span></span>' + r.ctxPercent + '%</span>';
        }
        if (r.cost) tags += '<span class="tag cost">' + escapeHtml(r.cost) + '</span>';
        var acts = actionButton(r);
        return '<div class="' + classes + '" data-id="' + escapeHtml(r.id) + '" data-status="' + r.status + '" role="listitem" tabindex="0">' +
          '<span class="' + dotClasses + '"></span>' +
          '<div class="mid">' +
            '<div class="name"><span>' + escapeHtml(r.name) + '</span></div>' +
            (r.message ? '<div class="msg">' + escapeHtml(r.message) + '</div>' : '') +
            '<div class="tags">' + tags + '</div>' +
          '</div>' +
          '<div class="right"><span class="time">' + escapeHtml(r.time) + '</span>' +
            (acts ? '<span class="acts">' + acts + '</span>' : '') + '</div>' +
        '</div>';
      }

      function renderConnection(payload) {
        var state = payload.connection || 'connected';
        var offline = state !== 'connected';
        document.body.classList.toggle('daemon-state', offline);
        daemonStateEl.dataset.state = state;
        if (state === 'connecting') {
          daemonTitleEl.textContent = 'Connecting to agentproto daemon…';
          daemonDescriptionEl.textContent = 'Looking for your local daemon. Sessions will appear automatically once it is ready.';
        } else if (state === 'unreachable') {
          daemonTitleEl.textContent = 'Agentproto daemon is not running';
          daemonDescriptionEl.textContent = 'The extension will keep trying. Start the daemon below, use the setup guide, or ask Claude to configure this workspace.';
        }
        return state;
      }

      function render(payload) {
        if (renderConnection(payload) !== 'connected') return;
        var html = '';
        var shown = 0;
        var recent = payload.section.recent;
        var older = payload.section.older;
        shown = recent.length + older.length;
        for (var i = 0; i < recent.length; i++) html += rowHTML(recent[i]);
        if (older.length > 0) {
          html += '<div class="subhead">Older than 24 hours</div>';
          for (var j = 0; j < older.length; j++) html += rowHTML(older[j]);
        }
        listEl.innerHTML = html;
        emptyEl.hidden = shown !== 0;
        summaryEl.textContent = payload.summary;
        loadMoreEl.hidden = !payload.hasMore;
        loadMoreEl.disabled = payload.loading;
        spinnerEl.hidden = !payload.loading;
        footerErrorEl.hidden = !payload.loadError;
        footerErrorEl.textContent = payload.loadError || '';
      }

      listEl.addEventListener('click', function (e) {
        var action = e.target.closest('[data-action]');
        if (action) {
          e.stopPropagation();
          if (action.hasAttribute('data-stop')) vscode.postMessage({ type: 'stop', id: action.getAttribute('data-stop') });
          else if (action.hasAttribute('data-archive')) vscode.postMessage({ type: 'archive', id: action.getAttribute('data-archive') });
          else if (action.hasAttribute('data-unarchive')) vscode.postMessage({ type: 'unarchive', id: action.getAttribute('data-unarchive') });
          return;
        }
        var openBtn = e.target.closest('[data-open]');
        var row = e.target.closest('.row');
        var id = openBtn ? openBtn.getAttribute('data-open') : row ? row.getAttribute('data-id') : null;
        if (id) vscode.postMessage({ type: 'open', id: id });
      });

      listEl.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var row = e.target.closest('.row');
        if (!row) return;
        e.preventDefault();
        vscode.postMessage({ type: 'open', id: row.getAttribute('data-id') });
      });

      loadMoreEl.addEventListener('click', function () {
        vscode.postMessage({ type: 'loadMore' });
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

      daemonStateEl.addEventListener('click', function (e) {
        var button = e.target.closest('button');
        if (!button) return;
        if (button.hasAttribute('data-refresh')) vscode.postMessage({ type: 'refresh' });
        else if (button.hasAttribute('data-docs')) vscode.postMessage({ type: 'openDocs' });
        else if (button.hasAttribute('data-copy-claude')) vscode.postMessage({ type: 'copyClaudePrompt' });
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
