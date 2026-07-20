/**
 * Harnesses tree view — shows adapters from the daemon's adapter_list MCP tool.
 * Pure logic lives in harnessesTree.logic.ts; this file only wraps it into
 * vscode.TreeItem / ThemeIcon / MarkdownString.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { AdapterInfo } from "../client/types.js"
import {
  harnessDescription,
  harnessIcon,
  harnessTooltip,
  sortAdapters,
  type HarnessNode,
} from "./harnessesTree.logic.js"

export type { HarnessNode }

const EMPTY_SLUG = "__no_adapters__"

export class HarnessesTreeProvider implements vscode.TreeDataProvider<HarnessNode>, vscode.Disposable {
  private readonly client: DaemonClient
  private adapters: AdapterInfo[] = []
  private readonly _onDidChange = new vscode.EventEmitter<HarnessNode | undefined>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(client: DaemonClient) {
    this.client = client
    void this.refresh()
  }

  dispose(): void {
    this._onDidChange.dispose()
  }

  async refresh(): Promise<void> {
    try {
      this.adapters = sortAdapters(await this.client.listAdapters())
    } catch {
      this.adapters = []
    }
    this._onDidChange.fire(undefined)
  }

  getTreeItem(element: HarnessNode): vscode.TreeItem {
    if (element.adapter.slug === EMPTY_SLUG) {
      return new vscode.TreeItem("No adapters found")
    }

    const icon = harnessIcon(element.adapter)
    const item = new vscode.TreeItem(element.adapter.slug)
    item.description = harnessDescription(element.adapter)
    item.tooltip = new vscode.MarkdownString(harnessTooltip(element.adapter))
    item.contextValue = "harness"
    item.iconPath = new vscode.ThemeIcon(icon.id)
    return item
  }

  getChildren(element?: HarnessNode): HarnessNode[] {
    if (element) return []
    if (this.adapters.length === 0) {
      return [{ adapter: { slug: EMPTY_SLUG } }]
    }
    return this.adapters.map(adapter => ({ adapter }))
  }
}

export function registerHarnessesView(ctx: vscode.ExtensionContext, client: DaemonClient): HarnessesTreeProvider {
  const provider = new HarnessesTreeProvider(client)
  const view = vscode.window.createTreeView("agentproto.harnesses", {
    treeDataProvider: provider,
    showCollapseAll: false,
  })
  ctx.subscriptions.push(view, provider)
  return provider
}
