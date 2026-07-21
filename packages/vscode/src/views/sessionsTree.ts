/**
 * Sessions tree view (WP1, restructured for workspace grouping — see
 * .plans/agentproto-vscode-workspace-tree/PLAN.md "PR B"). TreeDataProvider
 * on view id `agentproto.sessions`.
 *
 * Two top-level shapes, chosen by the `agentproto.groupByWorkspace` setting
 * (default true) via `buildSessionsRoots` (sessionsGroups.logic.ts):
 *   - grouped (default): one collapsible GroupNode per registered
 *     agentproto workspace, sessions assigned by cwd→longest-prefix (NOT the
 *     unreliable per-session workspaceSlug), plus a trailing "default
 *     (unassigned)" group for sessions matching no workspace. The group(s)
 *     matching an open VS Code folder are marked `(open)`, sorted first, and
 *     expanded by default. An open, unregistered folder gets a "Create
 *     workspace here" CTA row instead (agentproto.createWorkspace).
 *   - flat (toggle off, agentproto.toggleGroupByWorkspace): today's
 *     behavior, unchanged.
 * Inside each group (or at the top level when flat), sessions are still
 * listed split by recency across a divider row (last 24h above, older
 * below) and nested by parentSessionId into orchestrator subtrees — that
 * part is untouched, reused via sessionsTree.logic.ts's buildSessionRows.
 *
 * All mapping/sorting/filtering/grouping rules live in sessionsTree.logic.ts
 * and sessionsGroups.logic.ts (no vscode import there) so they're
 * unit-testable; this file only wraps that data into
 * vscode.TreeItem/ThemeIcon/MarkdownString and drives the view's
 * badge/description.
 *
 * Recency is a divider, not an accordion: the old LAST 7 DAYS / OLDER group
 * nodes made every session cost an extra expand and let a collapsed group hide
 * live sessions outright. The separator row carries the same information as a
 * single rule and can't hide anything.
 *
 * A single click opens the transcript: every session TreeItem sets
 * `command` to agentproto.openTranscript with the tree node as its arg —
 * normalizeSessionArg (sessionActions.logic.ts) already unwraps a node
 * shaped `{ session }`, so passing the node through works unchanged. The
 * separator row never gets a command (nothing to open); a GroupNode's
 * default expand/collapse is VS Code's own click behavior; a CtaNode's click
 * runs agentproto.createWorkspace.
 */

import * as vscode from "vscode"

import type { SessionFilterController } from "../commands/sessionFilter.js"
import type { SessionDescriptor } from "../client/types.js"
import { isPendingSession } from "../services/pending.logic.js"
import type { SeenTracker } from "../services/seen.js"
import type { SessionStore } from "../services/sessionStore.js"
import { filterSessions, filterSummary, isFilterActive } from "./sessionFilter.logic.js"
import {
  buildSessionsRoots,
  collectGroupMembership,
  groupDescriptionFor,
  isCtaNode,
  isGroupNode,
  type CtaNode,
  type GroupNode,
  type RootNode,
} from "./sessionsGroups.logic.js"
import {
  collapseResumeChains,
  descriptionFor,
  formatDuration,
  iconFor,
  isSeparatorNode,
  labelFor,
  silentForMs,
  tooltipFieldsFor,
  treeContextValueFor,
  TREE_REPAINT_INTERVAL_MS,
  withArchivedTag,
  type SessionNode,
} from "./sessionsTree.logic.js"

/** Reads live (not cached): the operator can add/close a folder mid-session,
 *  and the "(open)" marker + Create-workspace CTA must track that. */
function openFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
}

/** `agentproto.groupByWorkspace` — default true (see package.json). Read
 *  fresh on every rebuild rather than cached, same pattern as
 *  spawn.ts's holdPermissionsSetting(). */
function groupByWorkspaceSetting(): boolean {
  return vscode.workspace.getConfiguration("agentproto").get<boolean>("groupByWorkspace", true)
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<RootNode>, vscode.Disposable {
  private readonly store: SessionStore
  private readonly filter: SessionFilterController
  private readonly seen: SeenTracker
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChange.event
  private nodes: RootNode[] = []
  // Reverse index from a session id to the GroupNode it's nested under —
  // only populated in grouped mode. See getParent.
  private groupOf = new Map<string, GroupNode>()
  private now = Date.now()
  private _hiddenCount = 0
  private readonly repaintTimer: ReturnType<typeof setInterval>

  constructor(store: SessionStore, filter: SessionFilterController, seen: SeenTracker) {
    this.store = store
    this.filter = filter
    this.seen = seen
    this.rebuild()
    this.store.onDidChange(() => this.rebuild())
    this.filter.onDidChange(() => this.rebuild())
    // A dot going hollow is a state change like any other — the operator read
    // the session, and the row must say so without waiting for the daemon to
    // happen to emit something.
    this.seen.onDidChange(() => this.rebuild())
    // Rebuild on a clock as well as on change. Every row is rendered against
    // `now`, so the passage of time is itself a state change — one the store
    // can never report, because nothing happened. See TREE_REPAINT_INTERVAL_MS.
    this.repaintTimer = setInterval(() => this.rebuild(), TREE_REPAINT_INTERVAL_MS)
  }

  dispose(): void {
    clearInterval(this.repaintTimer)
    this._onDidChange.dispose()
  }

  /** Sessions present in the store but excluded by the current filter. */
  get hiddenCount(): number {
    return this._hiddenCount
  }

  /** Force a rebuild from outside a store/filter/seen event — the
   *  `groupByWorkspace` setting and the set of open VS Code folders can both
   *  change without any of those firing. */
  refresh(): void {
    this.rebuild()
  }

  private rebuild(): void {
    this.now = Date.now()
    const all = this.store.sessions
    // Filter first, then lay out the survivors: recency is a top-level
    // presentation split, not a filter dimension, so the divider is decided
    // from what's actually shown.
    const survivors = filterSessions(all, this.filter.state, this.filter.workspaces)
    this._hiddenCount = all.length - survivors.length
    // Collapse resume chains AFTER the filter (which already excludes
    // archived rows via the store's includeArchived toggle — see
    // sessionStore.ts) so a predecessor is hidden ONLY when its successor is
    // actually visible in `survivors`; a successor that got filtered out or
    // stayed archived leaves the predecessor showing instead of vanishing
    // the whole restart chain. Feed the collapsed set into the grouped-roots
    // builder so restart-chain collapse and workspace grouping compose.
    const collapsed = collapseResumeChains(survivors)
    this.nodes = buildSessionsRoots(collapsed, this.filter.workspaces, openFolderPaths(), this.now, {
      groupByWorkspace: groupByWorkspaceSetting(),
      filterActive: isFilterActive(this.filter.state),
    })
    this.groupOf = collectGroupMembership(this.nodes.filter(isGroupNode))
    this._onDidChange.fire()
  }

  getTreeItem(element: RootNode): vscode.TreeItem {
    if (isSeparatorNode(element)) {
      const item = new vscode.TreeItem("", vscode.TreeItemCollapsibleState.None)
      // The rule goes in `description`, not `label`: description renders in
      // descriptionForeground (dim), which is what makes the row read as a
      // divider instead of as another session.
      item.description = element.label
      item.id = element.id
      // Deliberately NOT prefixed "session-": every view/item/context menu
      // entry in package.json gates on `viewItem =~ /^session-/`, and the
      // divider must never pick up per-session inline actions (open
      // transcript / prompt / interrupt / kill).
      item.contextValue = "separator"
      // No `command`: clicking a divider does nothing.
      return item
    }

    if (isGroupNode(element)) return groupTreeItem(element)
    if (isCtaNode(element)) return ctaTreeItem(element)

    const session = element.session
    const collapsibleState =
      element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    const item = new vscode.TreeItem(labelFor(session), collapsibleState)
    item.id = session.id
    const baseDescription = descriptionFor(session, {
      now: this.now,
      childCount: element.children.length,
    })
    // Archived rows only ever reach the tree when the "show archived"
    // toggle is on (the daemon's default list() already excludes them) —
    // visually distinct so they read as "kept around, not currently in
    // view" rather than a normal terminal session.
    item.description = withArchivedTag(baseDescription, session.archived)
    item.contextValue = treeContextValueFor(session)
    item.tooltip = buildTooltip(session, this.now)
    item.iconPath = session.archived
      ? new vscode.ThemeIcon("archive")
      : toThemeIcon(iconFor(session, this.now, this.seen.isUnread(session)))
    // Single click opens the transcript — the inline $(open-preview) icon
    // (view/item/context menu, wired in package.json) remains as a second
    // way to trigger the same command.
    //
    // Except on an optimistic row: there is no session behind it yet, so a
    // click could only open a transcript for an id the daemon has never heard
    // of. Leaving `command` unset makes the row inert rather than a trap —
    // it's there to say "coming up", and it'll be a real row in a moment.
    if (!isPendingSession(session)) {
      item.command = {
        command: "agentproto.openTranscript",
        title: "Open Transcript",
        arguments: [element],
      }
    }
    return item
  }

  getChildren(element?: RootNode): RootNode[] {
    if (!element) return this.nodes
    if (isSeparatorNode(element) || isCtaNode(element)) return []
    return element.children
  }

  getParent(element: RootNode): RootNode | undefined {
    if (isSeparatorNode(element) || isGroupNode(element) || isCtaNode(element)) return undefined
    const parentId = element.session.parentSessionId
    if (parentId) {
      const parent = findNode(this.nodes, parentId)
      if (parent) return parent
    }
    // No parentSessionId (or it's dangling): a root within its group (or, in
    // flat mode, a genuine top-level row — groupOf is empty there).
    return this.groupOf.get(element.session.id)
  }
}

function findNode(nodes: readonly RootNode[], id: string): SessionNode | undefined {
  for (const node of nodes) {
    if (isSeparatorNode(node) || isCtaNode(node)) continue
    if (isGroupNode(node)) {
      const found = findNode(node.children, id)
      if (found) return found
      continue
    }
    if (node.session.id === id) return node
    const found = findNode(node.children, id)
    if (found) return found
  }
  return undefined
}

/** Open/closed root-folder icon doubles as the "(open)" marker at a glance,
 *  same visual language VS Code's own Explorer uses for a workspace root. */
function groupTreeItem(group: GroupNode): vscode.TreeItem {
  const collapsibleState =
    group.children.length > 0
      ? group.isOpen
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None
  const item = new vscode.TreeItem(group.label, collapsibleState)
  item.id = group.id
  item.description = groupDescriptionFor(group.count)
  item.contextValue = "workspace-group"
  item.iconPath = new vscode.ThemeIcon(group.isOpen ? "root-folder-opened" : "root-folder")
  return item
}

function ctaTreeItem(cta: CtaNode): vscode.TreeItem {
  const item = new vscode.TreeItem(cta.label, vscode.TreeItemCollapsibleState.None)
  item.id = cta.id
  item.contextValue = "create-workspace-cta"
  item.iconPath = new vscode.ThemeIcon("add")
  item.command = {
    command: "agentproto.createWorkspace",
    title: "Create Workspace Here",
    arguments: [cta],
  }
  return item
}

function toThemeIcon(icon: ReturnType<typeof iconFor>): vscode.ThemeIcon {
  if (!icon.color) return new vscode.ThemeIcon(icon.id)
  const themeColorId =
    icon.color === "error" ? "problemsErrorIcon.foreground" : "problemsWarningIcon.foreground"
  return new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(themeColorId))
}

function buildTooltip(session: SessionDescriptor, now: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**${labelFor(session)}**\n\n`)
  for (const field of tooltipFieldsFor(session)) {
    md.appendMarkdown(`- **${field.label}:** ${field.value}\n`)
  }
  // The duration is the fact the user judges on — "no output for 20h" settles
  // "is it working?" in a way a spinner never can.
  const silent = silentForMs(session, now)
  if (silent !== undefined) {
    md.appendMarkdown(`- **silent for:** ${formatDuration(silent)}\n`)
  }
  return md
}

export function registerSessionsView(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
  filter: SessionFilterController,
  seen: SeenTracker,
): void {
  const provider = new SessionsTreeProvider(store, filter, seen)
  const view = vscode.window.createTreeView("agentproto.sessions", {
    treeDataProvider: provider,
    showCollapseAll: true,
  })
  // The provider owns a repaint interval — it must be disposed, or the timer
  // outlives deactivation and keeps rebuilding a tree nobody is watching.
  ctx.subscriptions.push(view, provider)

  // Neither of these fires the provider's own store/filter/seen events, so
  // without an explicit rebuild the tree would only catch up on the next
  // 30s repaint tick (TREE_REPAINT_INTERVAL_MS) — noticeable lag for a
  // toolbar toggle or opening a second folder.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("agentproto.groupByWorkspace")) provider.refresh()
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    vscode.commands.registerCommand("agentproto.toggleGroupByWorkspace", async () => {
      const cfg = vscode.workspace.getConfiguration("agentproto")
      const next = !cfg.get<boolean>("groupByWorkspace", true)
      await cfg.update("groupByWorkspace", next, vscode.ConfigurationTarget.Global)
      vscode.window.setStatusBarMessage(
        `agentproto: sessions grouped by workspace ${next ? "on" : "off"}`,
        3000,
      )
    }),
  )

  // The tree must never lie about hiding things: badge the count of
  // sessions the current filter excludes, and summarize the filter in the
  // view description. Both clear the moment the filter goes inactive.
  const updateViewMeta = (): void => {
    const active = isFilterActive(filter.state)
    view.badge =
      active && provider.hiddenCount > 0
        ? {
            value: provider.hiddenCount,
            tooltip: `${provider.hiddenCount} session${provider.hiddenCount === 1 ? "" : "s"} hidden by filter`,
          }
        : undefined
    view.description = active ? filterSummary(filter.state) : undefined
  }
  updateViewMeta()
  ctx.subscriptions.push(provider.onDidChangeTreeData(updateViewMeta))
}
