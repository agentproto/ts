/**
 * Sessions webview panel — the opt-in WebviewView alternative to the Sessions
 * TreeView (`agentproto.sessionsView === "webview"`). Implements DESIGN B,
 * "Attention-first sections" (validated 2026-08-07): the seven status tabs are
 * gone. Status is no longer a control — it is the sort order the list
 * organizes itself into. Every session falls into one of five fixed-priority
 * sections (Needs you → Running → Attention → Quiet → Earlier), and navigation
 * collapses to two axes: a top PROJECT RAIL (All + per-workspace chips, each
 * with a count and an ochre "awaiting" dot) and an `Agents | Auto` SEGMENTED
 * CONTROL (human- vs machine-origin, the latter grouped into Gate reviews /
 * Crons / Commands). Calmed graphite palette, lifted from the validated
 * iterations mock; the ochre "needs you" signal is the only accent allowed to
 * catch the eye. Lifecycle actions match the harness panel language (#823):
 * labeled, keyboard-reachable, optimistic (Stop → "Stopping…" → Stopped →
 * Archive; Archive slides the row away).
 *
 * PROGRESSIVE LOADING: the webview uses `GET /sessions/summaries` (projected
 * rows + limit/offset pagination) rather than the full SessionDescriptor
 * snapshot the tree consumes. First page paints immediately; "Load more" in
 * the footer pulls older pages. Live correctness is preserved by re-fetching
 * the currently loaded slice on every SessionStore change. All classification
 * (activity, origin lane, cron collapsing) reuses existing logic — NO daemon
 * changes.
 *
 * CSP/nonce/palette pattern copied from transcriptPanel.ts.
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
import type { WatchedSessions } from "../services/watchedSessions.js"
import type { AdapterLogo } from "./adapterIcon.logic.js"
import {
  DEFAULT_ATTENTION_DELAY_SEC,
  resolveAttentionDelaySec,
} from "@agentproto/runtime/session-presence"
import {
  buildSessionsWebviewModel,
  isValidColorIndex,
  summaryTextFor,
  UNASSIGNED_COLOR_CSS,
  workspaceColorFor,
  WORKSPACE_PALETTE,
  WORKSPACE_PALETTE_NAMES,
  type RailEntry,
  type RowAction,
  type SessionLane,
  type WebviewGroup,
  type WebviewRow,
  type WebviewWorkspace,
  type WorkspaceColorOverrides,
} from "./sessionsWebview.logic.js"
import type { TranscriptPanels } from "./transcriptPanel.js"

const VIEW_TYPE = "agentproto.sessionsWebview"
const PAGE_SIZE = 50
/**
 * How often the panel repaints itself with no daemon input. Status here is a
 * function of `now` (stall detection past STALL_AFTER_MS, relative times), and
 * the store only fires onDidChange when a session's FIELDS change — so a
 * session that simply goes quiet is exactly the one that never gets
 * re-rendered. Ticking well below STALL_AFTER_MS (10 min) keeps a stalled
 * session from lingering in "Running" and keeps "2 mins ago" from drifting.
 */
const REPAINT_INTERVAL_MS = 15_000
const SETUP_DOCS_URL = "https://agentproto.sh/docs"
/** globalState key for the per-slug workspace color override map — {@link WorkspaceColorOverrides}. */
export const COLOR_OVERRIDES_KEY = "agentproto.sessionsWebview.workspaceColorOverrides"

/** Read the persisted color-override map from globalState (empty map when nothing is stored yet). */
export function readColorOverrides(globalState: vscode.Memento): Record<string, number> {
  return { ...(globalState.get<Record<string, number>>(COLOR_OVERRIDES_KEY) ?? {}) }
}

/**
 * The override map after applying one slug's change — `index: null` resets that
 * slug to the hash default (deletes its entry). Returns undefined (no-op) for
 * an out-of-range index, so a corrupt/malicious webview message can't poison
 * the persisted map.
 */
export function nextColorOverrides(
  current: Readonly<Record<string, number>>,
  slug: string,
  index: number | null,
): Record<string, number> | undefined {
  const next = { ...current }
  if (index === null) {
    delete next[slug]
    return next
  }
  if (!isValidColorIndex(index)) return undefined
  next[slug] = index
  return next
}
const CLAUDE_SETUP_PROMPT =
  "Set up Agentproto for this VS Code workspace. Install the Agentproto CLI, start its local daemon, register this workspace, connect Claude Code through the Agentproto MCP bridge, and verify that the Agentproto Sessions panel is live. Explain each command before I run it."

/** Adapter logo resolved to a webview-loadable form — an icon file's `asWebviewUri`, or a lettermark. */
type RenderLogo = { kind: "icon"; file: string; uri: string } | { kind: "lettermark"; text: string }

/** Row shape actually POSTed to the webview — `session` is stripped (the host resolves clicks by id) and `open` is computed fresh from `TranscriptPanels.activeSessionId()` on every render. */
interface RenderRow {
  id: string
  open: boolean
  status: WebviewRow["status"]
  name: string
  idMono: string | undefined
  message: string | undefined
  tag: string
  tagTitle: string | undefined
  logo: RenderLogo
  model: string | undefined
  ctxPercent: number | undefined
  cost: string | undefined
  time: string
  unread: boolean
  runs: number | undefined
  approved: boolean
  watched: boolean
  pinned: boolean
  locallyWatched: boolean
  watcherCount: number
  pendingBgTasks: number
  childrenBusy: number
  originLabel: string | undefined
  stallTooltip: string | undefined
  depth: number
  action: RowAction | undefined
  workspace: (WebviewWorkspace & { css: string }) | undefined
  archived: boolean
}

interface RenderGroup {
  key: string
  label: string
  hint: string | undefined
  rows: RenderRow[]
}

interface ModelMessage {
  type: "model"
  connection: DaemonConnectionState
  lane: SessionLane
  project: string | null
  rail: RailEntry[]
  laneCounts: Record<SessionLane, number>
  groups: RenderGroup[]
  summary: string
  loading: boolean
  hasMore: boolean
  loadError: string | undefined
  showArchived: boolean
  /** Color-picker swatch options, in order — {@link WORKSPACE_PALETTE} plus the trailing neutral "unassigned" tone. */
  palette: string[]
  /** Accessible names for `palette`, same order. */
  paletteNames: string[]
}

type HostMessage = ModelMessage

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openDocs" }
  | { type: "copyClaudePrompt" }
  | { type: "open"; id: string }
  | { type: "filter"; search: string }
  | { type: "lane"; lane: SessionLane }
  | { type: "project"; slug: string | null }
  | { type: "stop"; id: string }
  | { type: "archive"; id: string }
  | { type: "unarchive"; id: string }
  | { type: "pin"; id: string; pinned: boolean }
  | { type: "loadMore" }
  | { type: "toggleArchived" }
  /** From the rail chip's swatch popover — `index: null` resets to the hash default. */
  | { type: "setColor"; slug: string; index: number | null }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  )
}

function toRenderLogo(logo: AdapterLogo, webview: vscode.Webview, extensionUri: vscode.Uri): RenderLogo {
  if (logo.kind === "lettermark") return logo
  const uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "icons", "adapters", logo.file))
  return { kind: "icon", file: logo.file, uri: uri.toString() }
}

function toRenderRow(
  row: WebviewRow,
  activeSessionId: string | undefined,
  seen: SeenTracker,
  colorOverrides: WorkspaceColorOverrides,
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): RenderRow {
  return {
    id: row.id,
    open: row.id === activeSessionId,
    status: row.status,
    name: row.name,
    idMono: row.idMono,
    message: row.message,
    tag: row.tag,
    tagTitle: row.tagTitle,
    logo: toRenderLogo(row.logo, webview, extensionUri),
    model: row.model,
    ctxPercent: row.ctxPercent,
    cost: row.cost,
    time: row.time,
    unread: seen.isUnread(row.session),
    runs: row.runs,
    approved: row.approved,
    watched: row.watched,
    pinned: row.pinned,
    locallyWatched: row.locallyWatched,
    watcherCount: row.watcherCount,
    pendingBgTasks: row.pendingBgTasks,
    childrenBusy: row.childrenBusy,
    originLabel: row.originLabel,
    stallTooltip: row.stallTooltip,
    depth: row.depth,
    action: row.action,
    workspace: row.workspace
      ? { ...row.workspace, css: workspaceColorFor(row.workspace.slug, colorOverrides).css }
      : undefined,
    archived: row.archived,
  }
}

function toRenderGroup(
  group: WebviewGroup,
  activeSessionId: string | undefined,
  seen: SeenTracker,
  colorOverrides: WorkspaceColorOverrides,
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): RenderGroup {
  return {
    key: group.key,
    label: group.label,
    hint: group.hint,
    rows: group.rows.map(r => toRenderRow(r, activeSessionId, seen, colorOverrides, webview, extensionUri)),
  }
}

/**
 * The row pool the panel renders AND acts on: pending (still-starting) rows,
 * then live sessions the paginated summary slice hasn't reached yet, then the
 * loaded summaries. The store holds the FULL non-archived snapshot, so a
 * long-running session (e.g. a supervisor's children) that sorts past the
 * first page is still surfaced — it lands in Needs you / Running at the top,
 * never buried behind "Load more". Deduped against the loaded summaries +
 * pending rows by id.
 *
 * Shared by `post()` (render) and `runSessionAction()` (stop/archive/…) so a
 * row drawn with an action button is always resolvable when clicked —
 * previously the action path only searched `summaries`, so Stop on a pinned
 * live extra bounced with "session … no longer exists".
 */
export function visibleRows(
  storeSessions: readonly SessionDescriptor[],
  summaries: readonly SessionSummary[],
): SessionSummary[] {
  const pendingRows = storeSessions.filter(isPendingSession)
  const known = new Set<string>([...pendingRows, ...summaries].map(s => s.id))
  const liveExtras = storeSessions.filter(s => !isPendingSession(s) && isLiveSession(s) && !known.has(s.id))
  return [...pendingRows, ...liveExtras, ...summaries]
}

class SessionsWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private lane: SessionLane = "agents"
  private project: string | null = null
  private search = ""

  private summaries: SessionSummary[] = []
  private serverTotal = 0
  private loading = false
  private loadError: string | undefined
  /** "Show archived" toggle — switches the view between active-only (off,
   *  the default) and archived-only (on): the summary fetch and the model
   *  swap which set of rows is shown, they never merge. */
  private showArchived = false
  /** Clock-driven repaint so `now`-derived status (stall detection) and
   *  relative times stay honest with no daemon event to trigger a render —
   *  the webview's equivalent of the tree's TREE_REPAINT_INTERVAL_MS. */
  private repaintTimer: ReturnType<typeof setInterval> | undefined
  /** Per-slug color overrides set via the rail chip's swatch popover, persisted in globalState. */
  private colorOverrides: Record<string, number>
  /** Grace window (seconds) for the shared presence classifier — resolved once
   *  from the daemon config (`sessions.attentionDelaySec`); a session that just
   *  finished a turn stays in the Running section for this long. Defaults to
   *  the shared 60s. */
  private attentionDelaySec = DEFAULT_ATTENTION_DELAY_SEC

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: DaemonClient,
    private readonly store: SessionStore,
    private readonly filter: SessionFilterController,
    private readonly transcriptPanels: TranscriptPanels,
    private readonly seen: SeenTracker,
    private readonly globalState: vscode.Memento,
    private readonly watched: WatchedSessions | undefined,
  ) {
    this.colorOverrides = readColorOverrides(globalState)
    void resolveAttentionDelaySec().then(v => {
      if (v !== this.attentionDelaySec) {
        this.attentionDelaySec = v
        this.post()
      }
    })
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] }
    webviewView.webview.html = buildHtml(randomNonce(), webviewView.webview.cspSource)

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isWebviewToHostMessage(raw)) return
      this.handleMessage(raw)
    })

    // A hidden view stops receiving webview.postMessage traffic reliably in
    // some hosts — repaint on reveal so a webview that missed updates while
    // collapsed catches up immediately.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.post()
    })

    // Clock-driven repaint: recomputes `now`-derived status (stall) and
    // relative times even when no daemon event arrives. `post()` is cheap
    // (pure model rebuild off the already-loaded slice), so no network churn.
    this.repaintTimer = setInterval(() => this.post(), REPAINT_INTERVAL_MS)

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined
      if (this.repaintTimer) {
        clearInterval(this.repaintTimer)
        this.repaintTimer = undefined
      }
    })

    // The webview owns its own archived visibility (the "show archived"
    // toggle re-fetches summaries with includeArchived to swap to the
    // archived-only view); the store's tree slice stays off.
    if (this.store.showArchived) this.store.setShowArchived(false)

    // Initial bounded load: first page only. The list renders immediately
    // without waiting for the full daemon snapshot.
    void this.loadInitial()
  }

  /** Called by registerSessionsWebview's store/filter subscriptions — a source of truth this view depends on changed. */
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
      case "lane":
        this.lane = msg.lane
        this.post()
        return
      case "project":
        this.project = msg.slug
        this.post()
        return
      case "open":
        void this.openSession(msg.id)
        return
      case "stop":
        void this.runSessionAction(msg.id, "stop")
        return
      case "archive":
        void this.runSessionAction(msg.id, "archive")
        return
      case "unarchive":
        void this.runSessionAction(msg.id, "unarchive")
        return
      case "pin":
        void this.togglePin(msg.id, msg.pinned)
        return
      case "loadMore":
        void this.loadMore()
        return
      case "toggleArchived":
        this.showArchived = !this.showArchived
        void this.loadInitial()
        return
      case "setColor":
        void this.setWorkspaceColor(msg.slug, msg.index)
        return
    }
  }

  private async setWorkspaceColor(slug: string, index: number | null): Promise<void> {
    const next = nextColorOverrides(this.colorOverrides, slug, index)
    if (!next) return
    this.colorOverrides = next
    await this.globalState.update(COLOR_OVERRIDES_KEY, next)
    this.post()
  }

  private async refreshDaemon(): Promise<void> {
    await this.store.refreshAll()
    this.post()
  }

  private async copyClaudeSetupPrompt(): Promise<void> {
    await vscode.env.clipboard.writeText(CLAUDE_SETUP_PROMPT)
    void vscode.window.showInformationMessage("Agentproto setup prompt copied — paste it into Claude Code.")
  }

  private async openSession(id: string): Promise<void> {
    if (isPendingSession({ id })) return
    const session = await this.resolveSession(id)
    // Route through the command rather than duplicating the kind switch here —
    // agentproto.openSession (extension.ts) is the one place that decides
    // terminal vs. browser vs. transcript (sessionOpen.logic.ts).
    if (session) await vscode.commands.executeCommand("agentproto.openSession", session)
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

  private async runSessionAction(id: string, action: RowAction): Promise<void> {
    if (isPendingSession({ id })) {
      vscode.window.showWarningMessage(`agentproto: session ${id} is still starting.`)
      return
    }
    // Look the row up in the SAME pool `post()` renders from — a live session
    // pinned past the paginated slice (a "live extra") has a Stop button too,
    // and must not bounce with "no longer exists" just because it isn't in
    // `this.summaries` yet.
    const summary = visibleRows(this.store.sessions, this.summaries).find(s => s.id === id)
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
        const restart = await vscode.window.showInformationMessage(`agentproto: stopped ${label}`, "Restart")
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

  /**
   * Toggle a session's list-visibility pin (`session_set_pinned` /
   * `POST /sessions/:id/pin`). Purely a sort/display flag — quiet by design,
   * no confirmation toast (unlike stop/archive/unarchive): NEVER touches
   * keepAlive, the idle-reaper, or emits any notification. `store.refreshAll`
   * re-fetches the daemon snapshot, which cascades into `refresh()` via the
   * store's `onDidChange` subscription (registerSessionsWebview) so the row
   * moves into/out of the Pinned group on the next paint.
   */
  private async togglePin(id: string, pinned: boolean): Promise<void> {
    if (isPendingSession({ id })) {
      vscode.window.showWarningMessage(`agentproto: session ${id} is still starting.`)
      return
    }
    try {
      await this.client.setPinned(id, pinned)
      await this.store.refreshAll()
    } catch (err) {
      vscode.window.showErrorMessage(`agentproto: pin failed — ${describeError(err)}`)
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
        includeArchived: this.showArchived,
        limit: PAGE_SIZE,
        offset,
      })
      this.summaries = offset === 0 ? result.summaries : [...this.summaries, ...result.summaries]
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
   * lifecycle events, this re-fetches the first N summaries (N = rows already
   * loaded) so active/recent status changes appear without a manual reload
   * while keeping the request bounded.
   */
  private async refreshSummaries(): Promise<void> {
    if (this.loading || this.summaries.length === 0) return
    this.loading = true
    try {
      const result = await this.client.listSessionSummaries({
        includeArchived: this.showArchived,
        limit: this.summaries.length,
        offset: 0,
      })
      this.summaries = result.summaries
      this.serverTotal = result.total
      this.loadError = undefined
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err)
    } finally {
      this.loading = false
      this.post()
    }
  }

  private post(): void {
    if (!this.view) return
    const model = buildSessionsWebviewModel(
      visibleRows(this.store.sessions, this.summaries),
      this.filter.workspaces,
      {
        lane: this.lane,
        project: this.project,
        search: this.search,
        now: Date.now(),
        serverTotal: this.serverTotal,
        includeArchived: this.showArchived,
        attentionDelaySec: this.attentionDelaySec,
        // Footer counts server-paged rows only — pending + pinned live rows are
        // live extras, not paged results.
        loadedCount: this.summaries.length,
        colorOverrides: this.colorOverrides,
        watchedIds: this.watched?.watchedIds,
      },
    )
    const activeSessionId = this.transcriptPanels.activeSessionId()
    const filterActive = this.search.trim().length > 0 || this.project !== null
    const hasMore = this.summaries.length < this.serverTotal
    const message: ModelMessage = {
      type: "model",
      connection: this.store.connectionState,
      lane: model.lane,
      project: this.project,
      rail: model.rail,
      laneCounts: model.laneCounts,
      groups: model.groups.map(g =>
        toRenderGroup(g, activeSessionId, this.seen, this.colorOverrides, this.view!.webview, this.extensionUri),
      ),
      summary: summaryTextFor(model, filterActive),
      loading: this.loading,
      hasMore,
      loadError: this.loadError,
      showArchived: this.showArchived,
      palette: [...WORKSPACE_PALETTE, UNASSIGNED_COLOR_CSS],
      paletteNames: [...WORKSPACE_PALETTE_NAMES, "Unassigned gray"],
    }
    void this.view.webview.postMessage(message satisfies HostMessage)
  }
}

/**
 * Registers the WebviewViewProvider and wires every live-update source: the
 * shared SessionStore (lifecycle events + pending rows), the filter
 * controller's workspace-label cache, and the "open in tab" indicator's source
 * of truth (`TranscriptPanels.activeSessionId()`) via
 * `vscode.window.tabGroups.onDidChangeTabs`.
 */
export function registerSessionsWebview(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
  filter: SessionFilterController,
  transcriptPanels: TranscriptPanels,
  seen: SeenTracker,
  watched?: WatchedSessions,
): void {
  const provider = new SessionsWebviewProvider(
    ctx.extensionUri,
    client,
    store,
    filter,
    transcriptPanels,
    seen,
    ctx.globalState,
    watched,
  )
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider),
    store.onDidChange(() => provider.refresh()),
    filter.onDidChange(() => provider.refresh()),
    seen.onDidChange(() => provider.refresh()),
    vscode.window.tabGroups.onDidChangeTabs(() => provider.refresh()),
    // A watch/unwatch toggle repaints the eye chip without waiting for the daemon.
    ...(watched ? [watched.onDidChange(() => provider.refresh())] : []),
  )
}

function randomNonce(): string {
  return randomBytes(16).toString("hex")
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Exported so sessionsWebview.dom.test.ts can execute the exact shipped HTML/script in jsdom. */
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
  <title>agentproto sessions</title>
  <style>
    /* ── Calmed graphite palette (locked, Design B) ────────────────────
       Fixed tokens, not theme-derived: the point of Design B is a calm,
       desaturated surface where the ONE accent allowed to draw the eye is
       ochre = "needs you". */
    :root {
      --bg: #141415;
      --panel: #1b1b1c;
      --panel-2: #202021;
      --fg: #c8c8c6;
      --dim: #85857f;
      --faint: #5c5c58;
      --border: #2e2e2f;
      --hover: #232324;
      --selected: #26262a;
      --working: #7fa885;
      --awaiting: #c2a05c;
      --stalled: #bd6a5f;
      --stop-hot: #c46a60;
      /* Background tasks (pendingBgTasks / childrenBusy) — a warm amber/brown,
         distinct from the ochre "needs you" accent, so bg-task activity reads
         as its own signal rather than competing for the one accent color. */
      --bg-task: #b5854b;
      color: var(--fg);
      background-color: var(--bg);
      font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
      font-size: 13px;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    body { display: flex; flex-direction: column; background: var(--bg); color: var(--fg); line-height: 1.45; }
    .mono { font-family: "SF Mono", ui-monospace, Menlo, monospace; }

    /* ── Daemon connection / first-run state ───────────────────────── */
    #daemon-state { display: none; flex: 1 1 auto; min-height: 0; padding: 24px 18px; align-items: center; justify-content: center; }
    body.daemon-state > #rail,
    body.daemon-state > .brow2,
    body.daemon-state > #list,
    body.daemon-state > #empty,
    body.daemon-state > #footer { display: none !important; }
    body.daemon-state > #daemon-state { display: flex; }
    .daemon-card { width: min(100%, 360px); text-align: center; color: var(--fg); }
    .daemon-mark { width: 32px; height: 32px; margin: 0 auto 14px; border: 2px solid var(--faint); border-top-color: var(--awaiting); border-radius: 50%; }
    #daemon-state[data-state="connecting"] .daemon-mark { animation: agentproto-daemon-spin 1s linear infinite; }
    @keyframes agentproto-daemon-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { #daemon-state[data-state="connecting"] .daemon-mark { animation: none; } }
    .daemon-card h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .daemon-card p { margin: 8px 0 0; color: var(--dim); font-size: 12px; line-height: 1.5; }
    .daemon-command { display: block; margin: 16px 0 0; padding: 9px 10px; overflow-x: auto; text-align: left; border: 1px solid var(--border); background: var(--panel-2); color: var(--fg); font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 12px; }
    .daemon-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
    .daemon-actions button { width: 100%; min-height: 28px; padding: 4px 10px; border: 1px solid var(--border); background: var(--panel-2); color: var(--fg); cursor: pointer; font: inherit; font-size: 12px; }
    .daemon-actions button.primary { background: #33332f; }
    .daemon-actions button:hover { background: var(--hover); }
    #daemon-state[data-state="connecting"] .offline-only { display: none; }

    /* ── Project rail ──────────────────────────────────────────────── */
    #rail { display: flex; gap: 5px; padding: 8px 10px; border-bottom: 1px solid var(--border); overflow-x: auto; flex: 0 0 auto; }
    #rail::-webkit-scrollbar { display: none; }
    .pchip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px 3px 6px; border: 1px solid var(--border); border-radius: 4px; font-size: 11.5px; color: var(--dim); white-space: nowrap; user-select: none; background: transparent; }
    .pchip:hover { background: var(--hover); }
    .pchip.on { color: var(--fg); background: var(--panel-2); border-color: #3d3d40; }
    .pchip .n { color: var(--faint); font-size: 10.5px; }
    .pchip .psq { width: 6px; height: 6px; border-radius: 2px; display: inline-block; }
    .pchip .adot { width: 6px; height: 6px; border-radius: 50%; background: var(--awaiting); display: inline-block; }
    .pchip-label, .psq-btn { display: inline-flex; align-items: center; gap: 6px; padding: 0; margin: 0; border: none; background: transparent; color: inherit; font: inherit; cursor: pointer; }
    .psq-btn { padding: 3px; border-radius: 3px; }
    .psq-btn:hover { background: var(--hover); }
    .pchip:focus-visible, .segb:focus-visible, .row:focus-visible, .ghead:focus-visible, .abtn:focus-visible, .pchip-label:focus-visible, .psq-btn:focus-visible, .swatch:focus-visible, .swatch-reset:focus-visible, button:focus-visible { outline: 1px solid #6a86a8; outline-offset: -1px; }

    /* ── Color-picker popover (own absolutely-positioned element — a webview has no native popover API) ── */
    .popover { position: fixed; z-index: 50; background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); }
    .popover[hidden] { display: none; }
    .swatch-grid { display: grid; grid-template-columns: repeat(5, 20px); gap: 6px; }
    .swatch { width: 20px; height: 20px; border-radius: 4px; border: 1px solid transparent; padding: 0; cursor: pointer; }
    .swatch:hover { border-color: var(--dim); }
    .swatch.active { border-color: var(--fg); box-shadow: 0 0 0 1px var(--fg); }
    .swatch-reset { display: block; width: 100%; margin-top: 8px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: transparent; color: var(--dim); font-size: 11px; font-family: inherit; cursor: pointer; }
    .swatch-reset:hover { color: var(--fg); background: var(--hover); }

    /* ── Segmented control + inline filter ─────────────────────────── */
    .brow2 { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--border); flex: 0 0 auto; }
    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
    .segb { padding: 3px 12px; font-size: 11.5px; cursor: pointer; color: var(--dim); background: transparent; border: none; font-family: inherit; }
    .segb.on { background: var(--panel-2); color: var(--fg); font-weight: 600; }
    .segb .n { color: var(--faint); margin-left: 4px; font-size: 10.5px; }
    #q { flex: 1; background: transparent; border: none; outline: none; color: var(--fg); font-size: 12px; min-width: 40px; font-family: inherit; }
    #q::placeholder { color: var(--faint); }
    .icon-btn { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 22px; border: 1px solid var(--border); border-radius: 5px; background: transparent; color: var(--dim); cursor: pointer; font-size: 13px; font-family: inherit; padding: 0; }
    .icon-btn:hover { background: var(--hover); color: var(--fg); }
    .icon-btn.on { background: var(--panel-2); color: var(--fg); border-color: #3d3d40; }

    /* ── List ──────────────────────────────────────────────────────── */
    #list { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }
    #list::-webkit-scrollbar { width: 8px; }
    #list::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }

    /* ── Group headers (collapsible sections) ──────────────────────── */
    .ghead { display: flex; align-items: center; gap: 7px; padding: 9px 12px 5px; color: var(--dim); font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; cursor: pointer; user-select: none; }
    .ghead .tw { font-size: 8px; color: var(--faint); transition: transform 0.12s; }
    .ghead.closed .tw { transform: rotate(-90deg); }
    .ghead .n { color: var(--faint); font-weight: 400; }
    .ghead .hint { margin-left: auto; font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--faint); }
    .gbody[hidden] { display: none; }

    /* ── Rows ──────────────────────────────────────────────────────── */
    .row { display: flex; gap: 9px; padding: 8px 10px 8px 12px; cursor: pointer; position: relative; border-left: 2px solid transparent; }
    .row + .row { border-top: 1px solid #242425; }
    .row:hover { background: var(--hover); }
    .row.open { background: var(--selected); border-left-color: var(--awaiting); }
    .row.open .name > span:first-child { color: var(--fg); }
    .row.archived { opacity: 0.6; }
    .row.gone { opacity: 0; max-height: 0; padding-top: 0; padding-bottom: 0; overflow: hidden; transition: all 0.25s ease; }
    .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto; }
    .dot.working { background: var(--ws, var(--working)); animation: agentproto-pulse 2s infinite; }
    .dot.delegating { background: transparent; border: 2px solid var(--ws, var(--working)); }
    .dot.awaiting { background: var(--awaiting); }
    /* Awaiting bg — same filled-dot shape as .dot.awaiting, amber instead of
       ochre: distinguishable at a glance from "needs a human" even though the
       row itself sits in the same Quiet section as any other idle session. */
    .dot.awaiting-bg { background: var(--bg-task); }
    .dot.stalled, .dot.failed { background: var(--stalled); }
    .dot.parked { background: var(--ws, var(--faint)); opacity: 0.5; }
    .dot.idle, .dot.stopped { background: transparent; border: 1px solid var(--ws, var(--faint)); opacity: 0.7; }
    .dot.done { background: var(--ws, var(--faint)); opacity: 0.55; }
    .dot.done.unread { background: var(--ws, var(--working)); opacity: 1; border-color: var(--ws, var(--working)); }
    /* Background tasks pending/running (childrenBusy or pendingBgTasks) — an
       amber/brown tell that outranks the base status color, except while the
       row itself is actively working or needs you (those signals stay put). */
    .dot.bg { background: var(--bg-task); border-color: var(--bg-task); opacity: 1; }
    @keyframes agentproto-pulse { 50% { opacity: 0.4; } }
    @media (prefers-reduced-motion: reduce) { .dot.working { animation: none; } .spin { animation: none !important; } .bgdot { animation: none; } }
    .mid { flex: 1; min-width: 0; }
    .name { font-weight: 600; font-size: 12.5px; display: flex; gap: 6px; align-items: baseline; min-width: 0; }
    .name .id { font-weight: 400; color: var(--dim); }
    .name .ok { color: var(--working); font-weight: 400; font-size: 12px; }
    .name .runs { color: var(--faint); font-weight: 400; font-size: 11px; }
    /* "Watched" (keepAlive) — a calm, monochrome tell that someone is keeping
       this session alive/monitored; deliberately NOT the ochre "needs you". */
    .name .watch { color: var(--working); font-weight: 400; font-size: 11px; opacity: 0.85; }
    /* Live supervisor waiters (#session-visibility) — an eye + count when a wait
       long-poll / session_monitor is actively blocked on this session. Same
       calm register as .watch; it's an informational tell, not an alarm. */
    .name .eye { color: var(--working); font-weight: 400; font-size: 11px; opacity: 0.9; }
    /* Server-confirmed stall badge (turn-liveness watchdog) — a mid-turn
       session whose adapter stream has gone silent past the daemon's
       threshold with no legitimate blockedOn excuse. Ochre, like the
       "needs you" register: unlike the client-heuristic stalled DOT (a
       silence guess), this is a daemon-verified "this may be dead". */
    .name .stall { color: var(--awaiting); font-weight: 400; font-size: 11px; opacity: 0.95; }
    /* Delegating (#session-visibility) — "⟳ N children": this idle session is
       really waiting on its own busy subtree. Working-coloured so it reads as
       active work happening below it. */
    .name .deleg { color: var(--working); font-weight: 400; font-size: 11px; opacity: 0.9; }
    /* Nested subagent lineage — a faint connector before the child's name and a
       quiet left guide, so the parent→child stack reads without shouting. */
    .name .lineage { color: var(--faint); font-weight: 400; }
    .row.nested { border-left: 1px solid var(--border); }
    .msg { color: var(--dim); font-size: 12px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta-loc { margin-top: 3px; font-size: 11px; color: var(--faint); }
    .meta { display: flex; gap: 8px; margin-top: 1px; align-items: center; font-size: 11px; color: var(--faint); flex-wrap: wrap; }
    .meta .harness { display: inline-flex; align-items: center; gap: 4px; }
    .meta .logo { width: 12px; height: 12px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; color: var(--dim); }
    .meta .logo.svg svg { width: 12px; height: 12px; display: block; }
    .meta .logo.img img { width: 12px; height: 12px; object-fit: contain; border-radius: 2px; }
    .meta .logo.mono { width: 12px; height: 12px; border-radius: 50%; background: rgba(255, 255, 255, 0.08); font-size: 8px; font-weight: 700; line-height: 12px; text-align: center; letter-spacing: -0.02em; }
    .meta .model { color: var(--dim); }
    /* Background tasks pending — a small dot after the cost tag that fades in
       and out, deliberately NOT an icon, count, or bordered badge: presence is
       secondary/ambient information, not a signal competing with the row's
       name or its section/dot. */
    .meta .bgdot { width: 6px; height: 6px; border-radius: 50%; background: var(--bg-task); display: inline-block; animation: agentproto-bg-fade 1.4s ease-in-out infinite; }
    @keyframes agentproto-bg-fade { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
    /* Origin chip — the source channel (cowork/vscode/cron) on a root row,
       folded into the metadata line alongside model/cost rather than
       crowding the title. Faint, uppercase-ish tag so lineage attribution
       still reads at a glance without competing with the name. */
    .meta .origin { color: var(--faint); font-weight: 400; letter-spacing: .04em; border: 1px solid var(--faint); border-radius: 4px; padding: 0 4px; opacity: 0.8; max-width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctxbar { display: inline-flex; align-items: center; gap: 5px; }
    .ctxbar .track { width: 22px; height: 2px; background: var(--border); position: relative; }
    .ctxbar .fill { position: absolute; inset: 0 auto 0 0; background: var(--dim); }
    .right { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: 0 0 auto; }
    .time { color: var(--faint); font-size: 11px; white-space: nowrap; }

    /* ── Lifecycle actions (hover-revealed, stable slot) ───────────── */
    .acts { display: flex; gap: 2px; opacity: 0; transition: opacity 0.12s; }
    .row:hover .acts, .row.open .acts, .acts.busy { opacity: 1; }
    .abtn { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border: none; background: transparent; color: var(--dim); cursor: pointer; border-radius: 4px; padding: 0; }
    .abtn:hover { background: #2e2e30; color: var(--fg); }
    .abtn.stop:hover { color: var(--stop-hot); }
    /* Pinned state — a calm, always-on tell (once .acts is revealed) that
       this row is favorited, same ochre register as "needs you" since pin is
       an intentional operator choice, not an alarm. */
    .abtn.pin.on { color: var(--awaiting); }
    .abtn svg { width: 15px; height: 15px; display: block; }
    .spin { width: 12px; height: 12px; border: 1.5px solid var(--faint); border-top-color: var(--fg); border-radius: 50%; animation: agentproto-rot 0.8s linear infinite; }
    @keyframes agentproto-rot { to { transform: rotate(360deg); } }

    /* ── Empty + footer ────────────────────────────────────────────── */
    #empty { padding: 36px 20px; text-align: center; color: var(--faint); font-size: 12px; }
    #empty[hidden] { display: none; }
    #footer { padding: 6px 12px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
    #summary { color: var(--faint); font-size: 11px; }
    #load-more { margin-left: auto; background: transparent; border: 1px solid var(--border); color: var(--dim); font-size: 11px; padding: 3px 10px; cursor: pointer; border-radius: 4px; font-family: inherit; }
    #load-more:hover { color: var(--fg); border-color: var(--dim); }
    #load-more:disabled { opacity: 0.5; cursor: default; }
    #load-more[hidden] { display: none; }
    #spinner { color: var(--faint); font-size: 11px; }
    #spinner[hidden] { display: none; }
    #footer-error { color: var(--stalled); font-size: 11px; }
    #footer-error[hidden] { display: none; }
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
  <div id="rail" role="tablist" aria-label="Project"></div>
  <div id="color-popover" class="popover" hidden role="menu" aria-label="Workspace color">
    <div id="swatch-grid" class="swatch-grid" role="none"></div>
    <button id="swatch-reset" class="swatch-reset" type="button">Reset to auto</button>
  </div>
  <div class="brow2">
    <div class="seg" id="seg" role="tablist" aria-label="Session lane">
      <button class="segb on" type="button" data-lane="agents" role="tab">Agents<span class="n"></span></button>
      <button class="segb" type="button" data-lane="auto" role="tab">Auto<span class="n"></span></button>
    </div>
    <input id="q" placeholder="⌕ Filter…" autocomplete="off" aria-label="Filter sessions" />
    <button id="arch-toggle" class="icon-btn" type="button" title="Show archived sessions" aria-label="Show archived sessions" aria-pressed="false"></button>
  </div>
  <div id="list"></div>
  <div id="empty" hidden>No sessions match.</div>
  <div id="footer">
    <span id="summary"></span>
    <button id="load-more" hidden>Load more</button>
    <span id="spinner" hidden>Loading…</span>
    <span id="footer-error" hidden></span>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const railEl = document.getElementById('rail');
      const popoverEl = document.getElementById('color-popover');
      const swatchGridEl = document.getElementById('swatch-grid');
      const swatchResetEl = document.getElementById('swatch-reset');
      const segEl = document.getElementById('seg');
      const qEl = document.getElementById('q');
      const listEl = document.getElementById('list');
      const emptyEl = document.getElementById('empty');
      const summaryEl = document.getElementById('summary');
      const loadMoreEl = document.getElementById('load-more');
      const archToggleEl = document.getElementById('arch-toggle');
      const spinnerEl = document.getElementById('spinner');
      const footerErrorEl = document.getElementById('footer-error');
      const daemonStateEl = document.getElementById('daemon-state');
      const daemonTitleEl = document.getElementById('daemon-title');
      const daemonDescriptionEl = document.getElementById('daemon-description');

      // Section collapse is a client-only concern; persist it across the
      // frequent live re-renders so a collapsed section stays collapsed.
      const collapsed = {};

      const STOP_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="5.4" y="5.4" width="5.2" height="5.2" rx="1" fill="currentColor"/></svg>';
      const ARCH_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5h11M3.5 5v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5M6 7.5h4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5 2.8h6l1 2.2H4z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
      const UNARCH_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5h11M3.5 5v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M8 11V6.5M6 8l2-2 2 2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      // Pin (outline, unpinned → "click to pin") / PIN_FILLED_SVG (pinned →
      // "click to unpin") — same viewBox/size convention as STOP_SVG/ARCH_SVG.
      const PIN_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="6" r="3.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 9.2V14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
      const PIN_FILLED_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="6" r="3.2" fill="currentColor"/><path d="M8 9.2V14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

      archToggleEl.innerHTML = ARCH_SVG;

      function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, function (ch) {
          return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;';
        });
      }

      function actionButton(r) {
        if (r.action === 'stop') {
          return '<button class="abtn stop" type="button" title="Stop session" aria-label="Stop session" data-stop="' + escapeHtml(r.id) + '" data-action>' + STOP_SVG + '</button>';
        }
        if (r.action === 'archive') {
          return '<button class="abtn archive" type="button" title="Archive session" aria-label="Archive session" data-archive="' + escapeHtml(r.id) + '" data-action>' + ARCH_SVG + '</button>';
        }
        if (r.action === 'unarchive') {
          return '<button class="abtn unarchive" type="button" title="Unarchive session" aria-label="Unarchive session" data-unarchive="' + escapeHtml(r.id) + '" data-action>' + UNARCH_SVG + '</button>';
        }
        return '';
      }

      // Pin toggle — independent of actionButton's single stop/archive/
      // unarchive slot (a live session can be both stoppable AND pinnable),
      // so it's a SEPARATE button always present in .acts, not folded into
      // actionButton's exclusive branches.
      function pinButton(r) {
        if (r.pinned) {
          return '<button class="abtn pin on" type="button" title="Unpin session" aria-label="Unpin session" data-unpin="' + escapeHtml(r.id) + '" data-action>' + PIN_FILLED_SVG + '</button>';
        }
        return '<button class="abtn pin" type="button" title="Pin session" aria-label="Pin session" data-pin="' + escapeHtml(r.id) + '" data-action>' + PIN_SVG + '</button>';
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

      var svgCache = {};
      function applySvg(el, svg) {
        el.innerHTML = svg;
        el.dataset.loaded = '1';
        var svgEl = el.querySelector('svg');
        if (svgEl) {
          svgEl.setAttribute('width', '12');
          svgEl.setAttribute('height', '12');
          if (el.dataset.file !== 'claude.svg' && el.dataset.file !== 'openclaw.png') {
            svgEl.style.color = 'var(--fg)';
          }
        }
      }
      function loadSvg(el) {
        if (!el || el.dataset.loaded) return;
        var src = el.dataset.src;
        if (svgCache[src]) { applySvg(el, svgCache[src]); return; }
        fetch(src)
          .then(function (res) { return res.text(); })
          .then(function (svg) { svgCache[src] = svg; applySvg(el, svg); })
          .catch(function () {});
      }

      function metaLocHTML(r) {
        if (!r.tag) return '';
        return '<span class="loc"' + (r.tagTitle ? ' title="' + escapeHtml(r.tagTitle) + '"' : '') + '>' + escapeHtml(r.tag) + '</span>';
      }

      function metaHTML(r, depth) {
        var parts = [];
        var shortModel = r.model ? r.model.split('/').pop() : '';
        parts.push('<span class="harness">' + logoHtml(r.logo) + (r.model ? '<span class="model" title="' + escapeHtml(r.model) + '">' + escapeHtml(shortModel) + '</span>' : '') + '</span>');
        if (typeof r.ctxPercent === 'number') {
          parts.push('<span class="ctxbar"><span class="track"><span class="fill" style="width:' + r.ctxPercent + '%"></span></span>' + r.ctxPercent + '%</span>');
        }
        if (r.cost) parts.push('<span class="cost">' + escapeHtml(r.cost) + '</span>');
        // Background tasks pending — a small pulsing dot after cost, not an
        // icon or badge; the section/dot already carries the "needs
        // attention" signal, this is a quiet ambient tell.
        if (r.pendingBgTasks > 0) {
          parts.push('<span class="bgdot" title="' + r.pendingBgTasks + ' background task' + (r.pendingBgTasks === 1 ? '' : 's') + ' pending"></span>');
        }
        // Origin chip — only on root rows, folded into the metadata line
        // rather than the title.
        if (r.originLabel && depth === 0) {
          parts.push('<span class="origin" title="Spawned from ' + escapeHtml(r.originLabel) + '">' + escapeHtml(r.originLabel) + '</span>');
        }
        return parts.join('');
      }

      function rowHTML(r) {
        var depth = typeof r.depth === 'number' && r.depth > 0 ? r.depth : 0;
        var classes = 'row' + (r.open ? ' open' : '') + (r.archived ? ' archived' : '') + (depth > 0 ? ' nested' : '');
        // Background tasks pending/running color the dot amber — except while
        // the row is already actively working, needs you, or is itself the
        // dedicated awaiting-bg status (already amber via its own dot class).
        var hasBgWork = (r.childrenBusy > 0 || r.pendingBgTasks > 0) && r.status !== 'working' && r.status !== 'awaiting' && r.status !== 'awaiting-bg';
        var dotClasses = 'dot ' + r.status + (r.status === 'done' && r.unread ? ' unread' : '') + (hasBgWork ? ' bg' : '');
        var nameLine =
          (depth > 0 ? '<span class="lineage" aria-hidden="true">↳</span>' : '') +
          '<span>' + escapeHtml(r.name) + '</span>' +
          (r.idMono ? '<span class="id mono">· ' + escapeHtml(r.idMono) + '</span>' : '') +
          (r.watched ? '<span class="watch" title="Kept alive — the idle-reaper never retires this session">◉</span>' : '') +
          (r.locallyWatched ? '<span class="eye" title="watched — you get a notification when this session changes state">👁</span>' : '') +
          (r.status === 'delegating' ? '<span class="deleg" title="Delegating — waiting on ' + r.childrenBusy + ' child' + (r.childrenBusy === 1 ? '' : 'ren') + '">⟳' + r.childrenBusy + '</span>' : '') +
          (r.watcherCount > 0 ? '<span class="eye" title="' + r.watcherCount + ' waiter' + (r.watcherCount === 1 ? '' : 's') + ' attached via the daemon">👁' + r.watcherCount + '</span>' : '') +
          (r.stallTooltip ? '<span class="stall" title="' + escapeHtml(r.stallTooltip) + '">⚠</span>' : '') +
          (r.approved ? '<span class="ok">✓</span>' : '') +
          (r.runs ? '<span class="runs">×' + r.runs + '</span>' : '');
        var acts = pinButton(r) + actionButton(r);
        // Indent nested subagents; base padding-left is 12px (see .row CSS).
        var indent = depth > 0 ? ' style="padding-left:' + (12 + depth * 16) + 'px"' : '';
        var wsStyle = r.workspace ? ' style="--ws:' + escapeHtml(r.workspace.css) + '"' : '';
        return '<div class="' + classes + '"' + indent + ' data-id="' + escapeHtml(r.id) + '" data-status="' + r.status + '" role="listitem" tabindex="0">' +
          '<span class="' + dotClasses + '"' + wsStyle + '></span>' +
          '<div class="mid">' +
            '<div class="name">' + nameLine + '</div>' +
            (r.message ? '<div class="msg">' + escapeHtml(r.message) + '</div>' : '') +
            (metaLocHTML(r) ? '<div class="meta-loc">' + metaLocHTML(r) + '</div>' : '') +
            '<div class="meta">' + metaHTML(r, depth) + '</div>' +
          '</div>' +
          '<div class="right"><span class="time">' + escapeHtml(r.time) + '</span>' +
            '<span class="acts">' + acts + '</span></div>' +
        '</div>';
      }

      function groupHTML(g) {
        var isClosed = collapsed[g.key] === true;
        var head = '<div class="ghead' + (isClosed ? ' closed' : '') + '" data-key="' + escapeHtml(g.key) + '" role="button" tabindex="0" aria-expanded="' + (isClosed ? 'false' : 'true') + '">' +
          '<span class="tw">▾</span>' + escapeHtml(g.label) + ' <span class="n">' + g.rows.length + '</span>' +
          (g.hint ? '<span class="hint">' + escapeHtml(g.hint) + '</span>' : '') + '</div>';
        var body = '<div class="gbody" data-body="' + escapeHtml(g.key) + '"' + (isClosed ? ' hidden' : '') + '>' +
          g.rows.map(rowHTML).join('') + '</div>';
        return head + body;
      }

      function renderRail(rail, lane) {
        railEl.innerHTML = rail.map(function (e) {
          var on = (e.slug === null && currentProject === null) || (e.slug !== null && e.slug === currentProject);
          var slugAttr = e.slug === null ? '' : escapeHtml(e.slug);
          // The swatch trigger is a SIBLING button, not nested inside the label
          // button — a <button> can't contain another <button>.
          var swatch = e.css
            ? '<button type="button" class="psq-btn" data-color-trigger data-slug="' + slugAttr + '" data-index="' + e.colorIndex + '" title="Change ' + escapeHtml(e.label) + ' color" aria-label="Change ' + escapeHtml(e.label) + ' color" aria-haspopup="true">' +
                '<span class="psq" style="background:' + escapeHtml(e.css) + '"></span>' +
              '</button>'
            : '';
          return '<span class="pchip' + (on ? ' on' : '') + '" data-slug="' + slugAttr + '">' +
            swatch +
            '<button type="button" class="pchip-label" role="tab" aria-selected="' + on + '">' +
              escapeHtml(e.label) + ' <span class="n">' + e.count + '</span>' +
              (e.awaiting ? '<span class="adot" title="Awaiting you"></span>' : '') +
            '</button>' +
          '</span>';
        }).join('');
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

      var currentProject = null;
      var currentPalette = [];
      var currentPaletteNames = [];
      var popoverSlug = null;
      var popoverTrigger = null;

      function buildSwatchGrid(activeIndex) {
        swatchGridEl.innerHTML = currentPalette.map(function (css, i) {
          var isActive = i === activeIndex;
          var label = currentPaletteNames[i] || ('Color ' + (i + 1));
          return '<button type="button" class="swatch' + (isActive ? ' active' : '') + '" style="background:' + escapeHtml(css) + '" data-index="' + i + '" role="menuitemradio" aria-checked="' + isActive + '" aria-label="' + escapeHtml(label) + '" tabindex="' + (isActive ? '0' : '-1') + '"></button>';
        }).join('');
      }

      function openColorPopover(trigger) {
        var slug = trigger.getAttribute('data-slug');
        var index = parseInt(trigger.getAttribute('data-index'), 10);
        popoverSlug = slug;
        popoverTrigger = trigger;
        buildSwatchGrid(index);
        popoverEl.hidden = false;
        var rect = trigger.getBoundingClientRect();
        popoverEl.style.top = (rect.bottom + 4) + 'px';
        popoverEl.style.left = rect.left + 'px';
        var swatches = swatchGridEl.querySelectorAll('.swatch');
        var toFocus = swatches[index] || swatches[0];
        if (toFocus) toFocus.focus();
      }

      function closeColorPopover(restoreFocus) {
        if (popoverEl.hidden) return;
        popoverEl.hidden = true;
        if (restoreFocus && popoverTrigger) popoverTrigger.focus();
        popoverSlug = null;
        popoverTrigger = null;
      }

      function render(payload) {
        currentProject = payload.project === undefined ? currentProject : payload.project;
        currentPalette = payload.palette || [];
        currentPaletteNames = payload.paletteNames || [];
        // The rail (and its swatch triggers) is about to be fully rebuilt —
        // any open popover's trigger reference would otherwise go stale.
        closeColorPopover(false);
        if (renderConnection(payload) !== 'connected') return;

        // Segmented control.
        var segs = segEl.querySelectorAll('.segb');
        for (var i = 0; i < segs.length; i++) {
          var lane = segs[i].getAttribute('data-lane');
          segs[i].classList.toggle('on', lane === payload.lane);
          var nEl = segs[i].querySelector('.n');
          if (nEl) nEl.textContent = payload.laneCounts && typeof payload.laneCounts[lane] === 'number' ? payload.laneCounts[lane] : '';
        }

        renderRail(payload.rail || [], payload.lane);

        var showArchived = payload.showArchived === true;
        var groups = payload.groups || [];
        var shown = 0;
        for (var g = 0; g < groups.length; g++) shown += groups[g].rows.length;
        listEl.innerHTML = groups.map(groupHTML).join('');
        var svgs = listEl.querySelectorAll('.logo.svg');
        for (var s = 0; s < svgs.length; s++) loadSvg(svgs[s]);
        emptyEl.hidden = shown !== 0;
        emptyEl.textContent = showArchived ? 'No archived sessions.' : 'No sessions match.';
        summaryEl.textContent = payload.summary;
        archToggleEl.classList.toggle('on', showArchived);
        archToggleEl.setAttribute('aria-pressed', showArchived ? 'true' : 'false');
        var archToggleLabel = showArchived ? 'Show active sessions' : 'Show archived only';
        archToggleEl.title = archToggleLabel;
        archToggleEl.setAttribute('aria-label', archToggleLabel);
        loadMoreEl.hidden = !payload.hasMore;
        loadMoreEl.disabled = payload.loading;
        spinnerEl.hidden = !payload.loading;
        footerErrorEl.hidden = !payload.loadError;
        footerErrorEl.textContent = payload.loadError || '';
      }

      // ── Rail: project selection + color-swatch trigger ──
      railEl.addEventListener('click', function (e) {
        var trigger = e.target.closest('[data-color-trigger]');
        if (trigger) {
          openColorPopover(trigger);
          return;
        }
        var chip = e.target.closest('.pchip');
        if (!chip) return;
        var slug = chip.getAttribute('data-slug');
        currentProject = slug ? slug : null;
        vscode.postMessage({ type: 'project', slug: currentProject });
      });

      // ── Color-swatch popover: select / reset / keyboard nav / dismiss ──
      swatchGridEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.swatch');
        if (!btn || !popoverSlug) return;
        vscode.postMessage({ type: 'setColor', slug: popoverSlug, index: parseInt(btn.getAttribute('data-index'), 10) });
        closeColorPopover(true);
      });

      swatchResetEl.addEventListener('click', function () {
        if (!popoverSlug) return;
        vscode.postMessage({ type: 'setColor', slug: popoverSlug, index: null });
        closeColorPopover(true);
      });

      swatchGridEl.addEventListener('keydown', function (e) {
        var swatches = Array.prototype.slice.call(swatchGridEl.querySelectorAll('.swatch'));
        var idx = swatches.indexOf(document.activeElement);
        if (idx === -1) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          swatches[idx].click();
          return;
        }
        var cols = 5;
        var next = -1;
        if (e.key === 'ArrowRight') next = Math.min(idx + 1, swatches.length - 1);
        else if (e.key === 'ArrowLeft') next = Math.max(idx - 1, 0);
        else if (e.key === 'ArrowDown') next = Math.min(idx + cols, swatches.length - 1);
        else if (e.key === 'ArrowUp') next = Math.max(idx - cols, 0);
        else return;
        e.preventDefault();
        swatches[idx].setAttribute('tabindex', '-1');
        swatches[next].setAttribute('tabindex', '0');
        swatches[next].focus();
      });

      document.addEventListener('click', function (e) {
        if (popoverEl.hidden) return;
        if (popoverEl.contains(e.target) || (popoverTrigger && popoverTrigger.contains(e.target))) return;
        closeColorPopover(false);
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !popoverEl.hidden) {
          e.preventDefault();
          closeColorPopover(true);
        }
      });

      // ── Segmented control ──
      segEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.segb');
        if (!btn) return;
        vscode.postMessage({ type: 'lane', lane: btn.getAttribute('data-lane') });
      });

      // ── List: row open / lifecycle actions / section collapse ──
      listEl.addEventListener('click', function (e) {
        var head = e.target.closest('.ghead');
        if (head) {
          var key = head.getAttribute('data-key');
          collapsed[key] = !collapsed[key];
          head.classList.toggle('closed', collapsed[key]);
          head.setAttribute('aria-expanded', collapsed[key] ? 'false' : 'true');
          var body = listEl.querySelector('.gbody[data-body="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
          if (body) body.hidden = collapsed[key];
          return;
        }
        var action = e.target.closest('[data-action]');
        var row = e.target.closest('.row');
        if (action && row) {
          e.stopPropagation();
          if (action.hasAttribute('data-stop')) {
            row.querySelectorAll('.acts')[0].classList.add('busy');
            action.outerHTML = '<span class="spin" role="status" aria-label="Stopping"></span>';
            var msg = row.querySelector('.msg');
            if (msg) msg.textContent = 'Stopping…';
            vscode.postMessage({ type: 'stop', id: action.getAttribute('data-stop') });
          } else if (action.hasAttribute('data-archive')) {
            row.classList.add('gone');
            vscode.postMessage({ type: 'archive', id: action.getAttribute('data-archive') });
          } else if (action.hasAttribute('data-unarchive')) {
            row.classList.add('gone');
            vscode.postMessage({ type: 'unarchive', id: action.getAttribute('data-unarchive') });
          } else if (action.hasAttribute('data-pin')) {
            vscode.postMessage({ type: 'pin', id: action.getAttribute('data-pin'), pinned: true });
          } else if (action.hasAttribute('data-unpin')) {
            vscode.postMessage({ type: 'pin', id: action.getAttribute('data-unpin'), pinned: false });
          }
          return;
        }
        if (row) vscode.postMessage({ type: 'open', id: row.getAttribute('data-id') });
      });

      listEl.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var head = e.target.closest('.ghead');
        if (head) { e.preventDefault(); head.click(); return; }
        var action = e.target.closest('[data-action]');
        if (action) { e.preventDefault(); action.click(); return; }
        var row = e.target.closest('.row');
        if (!row) return;
        e.preventDefault();
        vscode.postMessage({ type: 'open', id: row.getAttribute('data-id') });
      });

      loadMoreEl.addEventListener('click', function () {
        vscode.postMessage({ type: 'loadMore' });
      });

      archToggleEl.addEventListener('click', function () {
        vscode.postMessage({ type: 'toggleArchived' });
      });

      var filterTimer = null;
      qEl.addEventListener('input', function () {
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(function () {
          vscode.postMessage({ type: 'filter', search: qEl.value.trim() });
        }, 120);
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
