/**
 * Sessions tree view (WP1, restructured for workspace grouping — see
 * .plans/agentproto-vscode-workspace-tree/PLAN.md "PR B"). TreeDataProvider
 * on view id `agentproto.sessions`.
 *
 * One grouping control — the `agentproto.sessionGrouping` setting
 * (none/workspace/origin/status, picked via agentproto.setSessionGrouping) —
 * drives `buildSessionsRoots` (sessionsGroups.logic.ts):
 *   - by status: one GroupNode per state — Awaiting you / Live / Failed /
 *     Stopped / Done — sessions bucketed by their ROOT's status.
 *   - by source: one GroupNode per origin — "Claude Code (desktop)", "VS Code
 *     extension", "cron", … — sessions bucketed by their ROOT's origin.
 *   - by workspace (default): one collapsible GroupNode per registered
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
import type { WatchedSessions } from "../services/watchedSessions.js"
import { filterSessions, filterSummary, isFilterActive } from "./sessionFilter.logic.js"
import {
  buildSessionsRoots,
  collectGroupMembership,
  groupDescriptionFor,
  isCtaNode,
  isGroupNode,
  isMachineOrigin,
  type CtaNode,
  type GroupNode,
  type RootNode,
  type SessionGrouping,
} from "./sessionsGroups.logic.js"
import {
  collapseResumeChains,
  descriptionFor,
  formatDuration,
  iconForSession,
  isSeparatorNode,
  labelFor,
  silentForMs,
  tooltipFieldsFor,
  treeContextValueFor,
  TREE_REPAINT_INTERVAL_MS,
  withArchivedTag,
  type SessionIcon,
  type SessionNode,
} from "./sessionsTree.logic.js"
import {
  DEFAULT_ATTENTION_DELAY_SEC,
  resolveAttentionDelaySec,
} from "@agentproto/runtime/session-presence"

/** Reads live (not cached): the operator can add/close a folder mid-session,
 *  and the "(open)" marker + Create-workspace CTA must track that. */
function openFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
}

const GROUPING_VALUES: readonly SessionGrouping[] = ["none", "workspace", "origin", "status"]

function isGrouping(value: unknown): value is SessionGrouping {
  return typeof value === "string" && (GROUPING_VALUES as readonly string[]).includes(value)
}

/** Resolve the single `agentproto.sessionGrouping` control, read fresh on every
 *  rebuild (same pattern as spawn.ts's holdPermissionsSetting()). Migration: if
 *  the new setting was never set, fall back to the legacy `groupByWorkspace`
 *  boolean — an explicit `false` maps to "none", otherwise "workspace". */
function groupingSetting(): SessionGrouping {
  const cfg = vscode.workspace.getConfiguration("agentproto")
  const inspected = cfg.inspect<string>("sessionGrouping")
  const explicit =
    inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue
  if (isGrouping(explicit)) return explicit
  return cfg.get<boolean>("groupByWorkspace", true) ? "workspace" : "none"
}

/** `agentproto.hideMachineSessions` — default true, read fresh on every
 *  rebuild. Safe to default on only because the tree always reports what it
 *  hid (`hiddenCount`, the view badge below) — an operator who never sees a
 *  gate-review session anywhere still sees the number change. */
function hideMachineSessionsSetting(): boolean {
  return vscode.workspace.getConfiguration("agentproto").get<boolean>("hideMachineSessions", true)
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<RootNode>, vscode.Disposable {
  private readonly store: SessionStore
  private readonly filter: SessionFilterController
  private readonly seen: SeenTracker
  private readonly watched: WatchedSessions | undefined
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChange.event
  private nodes: RootNode[] = []
  // Reverse index from a session id to the GroupNode it's nested under —
  // only populated in grouped mode. See getParent.
  private groupOf = new Map<string, GroupNode>()
  private now = Date.now()
  private _hiddenCount = 0
  private _hidingMachineDefault = false
  /** Grace window (seconds) for the shared presence classifier — resolved once
   *  from the daemon config (`sessions.attentionDelaySec`), defaulting to the
   *  shared 60s when unset/overridden. A just-finished session stays `running`
   *  for this long before settling grey. */
  private attentionDelaySec = DEFAULT_ATTENTION_DELAY_SEC
  private readonly repaintTimer: ReturnType<typeof setInterval>

  constructor(
    store: SessionStore,
    filter: SessionFilterController,
    seen: SeenTracker,
    watched?: WatchedSessions,
  ) {
    this.store = store
    this.filter = filter
    this.seen = seen
    this.watched = watched
    // Resolve the configured grace window once (config doesn't change under a
    // running extension); if it differs from the default, repaint with it.
    void resolveAttentionDelaySec().then(v => {
      if (v !== this.attentionDelaySec) {
        this.attentionDelaySec = v
        this.rebuild()
      }
    })
    this.rebuild()
    this.store.onDidChange(() => this.rebuild())
    this.filter.onDidChange(() => this.rebuild())
    // A dot going hollow is a state change like any other — the operator read
    // the session, and the row must say so without waiting for the daemon to
    // happen to emit something.
    this.seen.onDidChange(() => this.rebuild())
    // A watched/unwatched toggle changes the row's contextValue (`-watched`
    // suffix → the Watch/Unwatch menu swap) and its 👁 prefix, so it is a
    // state change like any other.
    this.watched?.onDidChange(() => this.rebuild())
    // Rebuild on a clock as well as on change. Every row is rendered against
    // `now`, so the passage of time is itself a state change — one the store
    // can never report, because nothing happened. See TREE_REPAINT_INTERVAL_MS.
    this.repaintTimer = setInterval(() => this.rebuild(), TREE_REPAINT_INTERVAL_MS)
  }

  dispose(): void {
    clearInterval(this.repaintTimer)
    this._onDidChange.dispose()
  }

  /** Sessions present in the store but excluded by the current filter (this
   *  includes any hidden by the `hideMachineSessions` default below — the
   *  badge doesn't distinguish the two sources, it just has to never lie
   *  about the total). */
  get hiddenCount(): number {
    return this._hiddenCount
  }

  /** True when this rebuild's `hiddenCount` includes machine-origin sessions
   *  hidden by the `agentproto.hideMachineSessions` default (as opposed to
   *  only an explicit operator filter) — registerSessionsView's view
   *  description reads this so the default hiding itself is never silent. */
  get hidingMachineDefault(): boolean {
    return this._hidingMachineDefault
  }

  /** Current top-level nodes — used by the "Expand All" command to reveal each
   *  group (VS Code ships a collapse-all button but no expand-all). */
  get rootNodes(): readonly RootNode[] {
    return this.nodes
  }

  /** Force a rebuild from outside a store/filter/seen event — the
   *  `groupByWorkspace` / `groupByOrigin` settings and the set of open VS Code
   *  folders can all change without any of those firing. */
  refresh(): void {
    this.rebuild()
  }

  private rebuild(): void {
    this.now = Date.now()
    const all = this.store.sessions
    const hideMachineSessions = hideMachineSessionsSetting()
    // Filter first, then lay out the survivors: recency is a top-level
    // presentation split, not a filter dimension, so the divider is decided
    // from what's actually shown.
    const survivors = filterSessions(all, this.filter.state, this.filter.workspaces, {
      hideMachineSessions,
    })
    this._hiddenCount = all.length - survivors.length
    // Mirrors filterSessions' own "operator's explicit origin choice wins"
    // rule (sessionFilter.logic.ts's passesMachineDefault) — the description
    // below must say "machine sessions hidden" only while that default is
    // the thing actually doing the hiding, not whenever the setting merely
    // happens to be on.
    this._hidingMachineDefault = hideMachineSessions && (this.filter.state.origin?.length ?? 0) === 0
    // Collapse resume chains AFTER the filter (which already excludes
    // archived rows via the store's includeArchived toggle — see
    // sessionStore.ts) so a predecessor is hidden ONLY when its successor is
    // actually visible in `survivors`; a successor that got filtered out or
    // stayed archived leaves the predecessor showing instead of vanishing
    // the whole restart chain. Feed the collapsed set into the grouped-roots
    // builder so restart-chain collapse and workspace grouping compose.
    const collapsed = collapseResumeChains(survivors)
    this.nodes = buildSessionsRoots(collapsed, this.filter.workspaces, openFolderPaths(), this.now, {
      grouping: groupingSetting(),
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
    const isWatched = this.watched?.isWatched(session.id) === true
    const baseDescription = descriptionFor(session, {
      now: this.now,
      childCount: element.children.length,
    })
    // Archived rows only ever reach the tree when the "show archived"
    // toggle is on (the daemon's default list() already excludes them) —
    // visually distinct so they read as "kept around, not currently in
    // view" rather than a normal terminal session. A watched row leads its
    // description with the 👁 prefix so the eye is visible at a glance.
    const withWatch = isWatched ? `👁 ${baseDescription}` : baseDescription
    item.description = withArchivedTag(withWatch, session.archived)
    item.contextValue = treeContextValueFor(session, isWatched)
    item.tooltip = buildTooltip(session, this.now, isWatched)
    // A live row's icon comes from the SHARED dashboard presence classifier
    // (running ◉ / tending ◌ / attention ? / quiet ○) — same source as the CLI
    // table and the webview, so a supervisor with busy executors shows the
    // half-fill `tending` glyph rather than a spinner or a resting dot.
    // Terminal and stalled rows keep their richer existing icons
    // (done/stopped/failed/warning) — see iconForSession.
    item.iconPath = session.archived
      ? new vscode.ThemeIcon("archive")
      : toThemeIcon(
          iconForSession(session, this.now, this.seen.isUnread(session), this.attentionDelaySec),
        )
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
 *  same visual language VS Code's own Explorer uses for a workspace root. An
 *  origin group instead reads as a source: a plug icon + its own contextValue
 *  (no workspace inline actions apply to it) — EXCEPT a machine-origin group
 *  (isMachineOrigin, e.g. `gate`), which gets `verified` instead of `plug`:
 *  a plug reads as "a live connection to a place a person is", which is
 *  exactly the wrong read for automated push-gate reviewer bookkeeping —
 *  `verified` reads as automated verification/review, matching what these
 *  sessions actually are. */
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
  if (group.variant === "origin") {
    item.contextValue = "origin-group"
    item.iconPath = new vscode.ThemeIcon(isMachineOrigin(group.slug) ? "verified" : "plug")
  } else if (group.variant === "status") {
    item.contextValue = "status-group"
    item.iconPath = new vscode.ThemeIcon("pulse")
  } else {
    item.contextValue = "workspace-group"
    item.iconPath = new vscode.ThemeIcon(group.isOpen ? "root-folder-opened" : "root-folder")
  }
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

function toThemeIcon(icon: SessionIcon): vscode.ThemeIcon {
  if (!icon.color) return new vscode.ThemeIcon(icon.id)
  const themeColorId =
    icon.color === "error" ? "problemsErrorIcon.foreground" : "problemsWarningIcon.foreground"
  return new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(themeColorId))
}

function buildTooltip(session: SessionDescriptor, now: number, watched?: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**${labelFor(session)}**\n\n`)
  if (watched) {
    // Same vocabulary as the webview's plain-👁 chip — one watch pattern
    // across both surfaces.
    md.appendMarkdown(`👁 watched — you get a notification when this session changes state\n\n`)
  }
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
  watched?: WatchedSessions,
): void {
  const provider = new SessionsTreeProvider(store, filter, seen, watched)
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
      if (
        e.affectsConfiguration("agentproto.sessionGrouping") ||
        e.affectsConfiguration("agentproto.groupByWorkspace") ||
        e.affectsConfiguration("agentproto.hideMachineSessions")
      ) {
        provider.refresh()
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    // One control for the whole grouping dimension — a QuickPick over the four
    // mutually-exclusive modes, so the panel can never land in a confusing
    // "both toggles off" state.
    vscode.commands.registerCommand("agentproto.setSessionGrouping", async () => {
      const current = groupingSetting()
      const items: (vscode.QuickPickItem & { value: SessionGrouping })[] = [
        { value: "workspace", label: "$(root-folder) Workspace", description: "by registered workspace" },
        { value: "origin", label: "$(plug) Source", description: "by where it was launched (Claude Code, VS Code, cron…)" },
        { value: "status", label: "$(pulse) Status", description: "by state (awaiting, live, failed…)" },
        { value: "none", label: "$(list-flat) None (flat)", description: "one flat list" },
      ]
      for (const item of items) if (item.value === current) item.description += "  ✓ current"
      const pick = await vscode.window.showQuickPick(items, {
        title: "Group Sessions By",
        placeHolder: "Choose how to group the Sessions panel",
      })
      if (!pick || pick.value === current) return
      await vscode.workspace
        .getConfiguration("agentproto")
        .update("sessionGrouping", pick.value, vscode.ConfigurationTarget.Global)
    }),
    // Expand All — VS Code's tree ships a collapse-all button (showCollapseAll)
    // but no expand-all, so grouped views can only be re-opened one group at a
    // time. Reveal each top-level group expanded (VS Code caps expand depth at
    // 3, which covers a group → its sessions → one nesting level).
    vscode.commands.registerCommand("agentproto.expandAllSessions", async () => {
      for (const node of provider.rootNodes) {
        if (!isGroupNode(node)) continue
        try {
          await view.reveal(node, { expand: 3, select: false, focus: false })
        } catch {
          // reveal can reject if the node is momentarily gone (a rebuild raced
          // this loop) — skip it; the next group still expands.
        }
      }
    }),
    // Back-compat alias for the released command / any user keybinding: flip
    // between workspace grouping and the flat list via the new setting.
    vscode.commands.registerCommand("agentproto.toggleGroupByWorkspace", async () => {
      const next: SessionGrouping = groupingSetting() === "workspace" ? "none" : "workspace"
      await vscode.workspace
        .getConfiguration("agentproto")
        .update("sessionGrouping", next, vscode.ConfigurationTarget.Global)
      vscode.window.setStatusBarMessage(
        `agentproto: sessions grouped by workspace ${next === "workspace" ? "on" : "off"}`,
        3000,
      )
    }),
  )

  // The tree must never lie about hiding things: badge the count of
  // sessions the current filter excludes, and summarize the filter in the
  // view description. Both clear the moment nothing is being hidden.
  //
  // `active` covers two independent reasons hiddenCount can be nonzero: an
  // explicit operator filter (isFilterActive), and the on-by-default
  // `agentproto.hideMachineSessions` setting quietly dropping gate/review
  // sessions (provider.hidingMachineDefault). Defaulting that setting to
  // true is only safe BECAUSE this badge/description already surface
  // whatever it hides — an operator who never sees a gate session anywhere
  // still sees the count.
  const updateViewMeta = (): void => {
    const active = isFilterActive(filter.state) || provider.hidingMachineDefault
    view.badge =
      active && provider.hiddenCount > 0
        ? {
            value: provider.hiddenCount,
            tooltip: `${provider.hiddenCount} session${provider.hiddenCount === 1 ? "" : "s"} hidden by filter`,
          }
        : undefined
    const parts = [filterSummary(filter.state)].filter(Boolean)
    if (provider.hidingMachineDefault) parts.push("machine sessions hidden")
    view.description = parts.length > 0 ? parts.join(" · ") : undefined
  }
  updateViewMeta()
  ctx.subscriptions.push(provider.onDidChangeTreeData(updateViewMeta))
}
