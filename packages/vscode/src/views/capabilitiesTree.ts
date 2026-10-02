/**
 * Capabilities view (read-only): imported MCP servers, bundles, skills per
 * harness, and what the session selected in the Sessions view actually
 * received. Tree-building rules live in capabilitiesTree.logic.ts.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import {
  buildCapabilitiesTree,
  selectedSessionIdOf,
  type CapabilitiesSnapshot,
  type CapabilityNode,
} from "./capabilitiesTree.logic.js"

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class CapabilitiesTreeProvider implements vscode.TreeDataProvider<CapabilityNode>, vscode.Disposable {
  private roots: CapabilityNode[] = []
  private sessionId: string | undefined
  private sessionLabel: string | undefined
  private seq = 0
  private readonly _onDidChange = new vscode.EventEmitter<CapabilityNode | undefined>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(private readonly client: DaemonClient) {
    void this.refresh()
  }

  dispose(): void {
    this._onDidChange.dispose()
  }

  setSession(id: string | undefined, label?: string): void {
    if (id === this.sessionId) return
    this.sessionId = id
    this.sessionLabel = label
    void this.refresh()
  }

  async refresh(): Promise<void> {
    const seq = ++this.seq
    const snapshot: CapabilitiesSnapshot = {}
    const sessionId = this.sessionId
    const [inventory, bundles, session] = await Promise.allSettled([
      this.client.capabilitiesInventory(),
      this.client.listBundles(),
      sessionId ? this.client.sessionCapabilities(sessionId) : Promise.resolve(undefined),
    ])
    // A newer refresh (another selection) superseded this one while it was in flight.
    if (seq !== this.seq) return
    if (inventory.status === "fulfilled") snapshot.inventory = inventory.value
    else snapshot.inventoryError = message(inventory.reason)
    if (bundles.status === "fulfilled") snapshot.bundles = bundles.value
    else snapshot.bundlesError = message(bundles.reason)
    if (sessionId) {
      const label = this.sessionLabel ?? sessionId
      snapshot.session =
        session.status === "fulfilled"
          ? { id: sessionId, label, capabilities: session.value }
          : { id: sessionId, label, error: message(session.reason) }
    }
    this.roots = buildCapabilitiesTree(snapshot)
    this._onDidChange.fire(undefined)
  }

  getTreeItem(node: CapabilityNode): vscode.TreeItem {
    const state = !node.children
      ? vscode.TreeItemCollapsibleState.None
      : node.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    const item = new vscode.TreeItem(node.label, state)
    item.id = node.id
    item.description = node.description
    if (node.tooltip) item.tooltip = new vscode.MarkdownString(node.tooltip)
    item.iconPath = new vscode.ThemeIcon(node.icon)
    return item
  }

  getChildren(node?: CapabilityNode): CapabilityNode[] {
    return node ? (node.children ?? []) : this.roots
  }
}

export function registerCapabilitiesView(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  sessionsView: { onDidChangeSelection: vscode.Event<{ readonly selection: readonly unknown[] }> },
): CapabilitiesTreeProvider {
  const provider = new CapabilitiesTreeProvider(client)
  const view = vscode.window.createTreeView("agentproto.capabilities", {
    treeDataProvider: provider,
    showCollapseAll: true,
  })
  ctx.subscriptions.push(
    view,
    provider,
    sessionsView.onDidChangeSelection(e => {
      const first = e.selection[0] as { session?: { label?: string; name?: string } } | undefined
      provider.setSession(selectedSessionIdOf(e.selection), first?.session?.label ?? first?.session?.name)
    }),
    vscode.commands.registerCommand("agentproto.refreshCapabilities", () => provider.refresh()),
  )
  return provider
}
