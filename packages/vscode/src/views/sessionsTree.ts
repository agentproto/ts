/**
 * Sessions tree view (WP1). TreeDataProvider on view id `agentproto.sessions`.
 * Sessions are filtered (SessionFilterController's SessionFilterState),
 * bucketed by recency (LAST 7 DAYS / OLDER, top level only), and within a
 * bucket nested by parentSessionId into orchestrator subtrees. All
 * mapping/sorting/filtering rules live in sessionsTree.logic.ts and
 * sessionFilter.logic.ts (no vscode import there) so they're
 * unit-testable; this file only wraps that data into
 * vscode.TreeItem/ThemeIcon/MarkdownString and drives the view's
 * badge/description.
 *
 * A single click opens the transcript: every session TreeItem sets
 * `command` to agentproto.openTranscript with the tree node as its arg —
 * normalizeSessionArg (sessionActions.logic.ts) already unwraps a node
 * shaped `{ session }`, so passing the node through works unchanged. Bucket
 * group nodes never get a command (nothing to open).
 */

import * as vscode from "vscode"

import type { SessionFilterController } from "../commands/sessionFilter.js"
import { workspaceLabelFor } from "../services/workspaces.logic.js"
import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import { filterSessions, filterSummary, isFilterActive } from "./sessionFilter.logic.js"
import {
  buildBucketedTree,
  contextValueFor,
  descriptionFor,
  iconFor,
  labelFor,
  tooltipFieldsFor,
  type BucketNode,
  type SessionNode,
  type TreeNode,
} from "./sessionsTree.logic.js"

function isBucketNode(node: TreeNode): node is BucketNode {
  return "kind" in node && node.kind === "bucket"
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly store: SessionStore
  private readonly filter: SessionFilterController
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChange.event
  private nodes: TreeNode[] = []
  private now = Date.now()
  private _hiddenCount = 0

  constructor(store: SessionStore, filter: SessionFilterController) {
    this.store = store
    this.filter = filter
    this.rebuild()
    this.store.onDidChange(() => this.rebuild())
    this.filter.onDidChange(() => this.rebuild())
  }

  /** Sessions present in the store but excluded by the current filter. */
  get hiddenCount(): number {
    return this._hiddenCount
  }

  private rebuild(): void {
    this.now = Date.now()
    const all = this.store.sessions
    // Filter first, then bucket the survivors (buckets are a top-level
    // grouping, not a filter dimension).
    const survivors = filterSessions(all, this.filter.state, this.filter.workspaces)
    this._hiddenCount = all.length - survivors.length
    this.nodes = buildBucketedTree(survivors, this.now)
    this._onDidChange.fire()
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (isBucketNode(element)) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded)
      // Deliberately NOT prefixed "session-": every view/item/context menu
      // entry in package.json gates on `viewItem =~ /^session-/`, and a
      // bucket header must never pick up per-session inline actions
      // (open transcript / prompt / interrupt / kill).
      item.contextValue = "bucket"
      return item
    }

    const session = element.session
    const collapsibleState =
      element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    const item = new vscode.TreeItem(labelFor(session), collapsibleState)
    item.id = session.id
    item.description = descriptionFor(session, {
      workspaceLabel: workspaceLabelFor(this.filter.workspaces, session),
      now: this.now,
    })
    item.contextValue = contextValueFor(session)
    item.tooltip = buildTooltip(session)
    item.iconPath = toThemeIcon(iconFor(session))
    // Single click opens the transcript — the inline $(open-preview) icon
    // (view/item/context menu, wired in package.json) remains as a second
    // way to trigger the same command.
    item.command = {
      command: "agentproto.openTranscript",
      title: "Open Transcript",
      arguments: [element],
    }
    return item
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) return this.nodes
    return element.children
  }

  getParent(element: TreeNode): TreeNode | undefined {
    if (isBucketNode(element)) return undefined
    const parentId = element.session.parentSessionId
    if (parentId) {
      const parent = findNode(this.nodes, parentId)
      if (parent) return parent
    }
    // No parentSessionId (or it's dangling) — element is a bucket root.
    for (const node of this.nodes) {
      if (isBucketNode(node) && node.children.includes(element)) return node
    }
    return undefined
  }
}

function findNode(nodes: readonly TreeNode[], id: string): SessionNode | undefined {
  for (const node of nodes) {
    if (!isBucketNode(node) && node.session.id === id) return node
    const found = findNode(node.children, id)
    if (found) return found
  }
  return undefined
}

function toThemeIcon(icon: ReturnType<typeof iconFor>): vscode.ThemeIcon {
  if (!icon.color) return new vscode.ThemeIcon(icon.id)
  const themeColorId =
    icon.color === "error" ? "problemsErrorIcon.foreground" : "problemsWarningIcon.foreground"
  return new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(themeColorId))
}

function buildTooltip(session: SessionDescriptor): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**${labelFor(session)}**\n\n`)
  for (const field of tooltipFieldsFor(session)) {
    md.appendMarkdown(`- **${field.label}:** ${field.value}\n`)
  }
  return md
}

export function registerSessionsView(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
  filter: SessionFilterController,
): void {
  const provider = new SessionsTreeProvider(store, filter)
  const view = vscode.window.createTreeView("agentproto.sessions", {
    treeDataProvider: provider,
    showCollapseAll: true,
  })
  ctx.subscriptions.push(view)

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
