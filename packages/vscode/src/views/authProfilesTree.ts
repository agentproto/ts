/**
 * Auth Profiles tree view — shows provider presets and catalog-derived model
 * profiles under view id `agentproto.authProfiles`.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import {
  buildPresetNodes,
  buildProfileNodes,
  isAuthProfileGroup,
  presetDescription,
  presetIcon,
  presetTooltip,
  profileDescription,
  profileTooltip,
  type AuthProfileGroup,
  type AuthProfileNode,
  type AuthProfileTreeNode,
} from "./authProfilesTree.logic.js"

const PRESETS_GROUP: AuthProfileGroup = { kind: "presets", label: "Provider Presets" }
const PROFILES_GROUP: AuthProfileGroup = { kind: "profiles", label: "Model Profiles" }

export class AuthProfilesTreeProvider
  implements vscode.TreeDataProvider<AuthProfileTreeNode>, vscode.Disposable
{
  private readonly client: DaemonClient
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChange.event

  private presets: AuthProfileNode[] = []
  private profiles: AuthProfileNode[] = []
  private loadError = false

  constructor(client: DaemonClient) {
    this.client = client
    void this.refresh()
  }

  dispose(): void {
    this._onDidChange.dispose()
  }

  async refresh(): Promise<void> {
    this.loadError = false
    try {
      const [presetEntries, catalog] = await Promise.all([
        this.client.listProviderPresets(),
        this.client.catalogModels(),
      ])
      this.presets = buildPresetNodes(presetEntries)
      this.profiles = buildProfileNodes(catalog).map(profile => ({
        kind: "profile",
        ...profile,
      }))
    } catch {
      this.loadError = true
      this.presets = []
      this.profiles = []
    }
    this._onDidChange.fire()
  }

  getTreeItem(element: AuthProfileTreeNode): vscode.TreeItem {
    if (isAuthProfileGroup(element)) {
      const collapsibleState = this.loadError
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded
      const item = new vscode.TreeItem(element.label, collapsibleState)
      item.id = element.kind
      item.iconPath = new vscode.ThemeIcon("folder")
      item.contextValue = "auth-profiles-group"
      return item
    }

    if (element.kind === "preset") {
      const preset = element.preset
      const item = new vscode.TreeItem(preset.name ?? preset.slug)
      item.id = `preset:${preset.slug}`
      item.description = presetDescription(preset)
      item.tooltip = new vscode.MarkdownString(presetTooltip(preset))
      item.iconPath = new vscode.ThemeIcon(presetIcon(preset))
      item.contextValue = "auth-preset"
      return item
    }

    const item = new vscode.TreeItem(element.profileId)
    item.id = `profile:${element.profileId}`
    item.description = profileDescription(element.routesCount)
    item.tooltip = new vscode.MarkdownString(profileTooltip(element.profileId, element.routesCount))
    item.iconPath = new vscode.ThemeIcon("account")
    item.contextValue = "auth-profile"
    return item
  }

  getChildren(element?: AuthProfileTreeNode): AuthProfileTreeNode[] {
    if (this.loadError) {
      return [{ kind: "presets", label: "Could not load auth profiles" }]
    }

    if (!element) {
      return [PRESETS_GROUP, PROFILES_GROUP]
    }

    if (!isAuthProfileGroup(element)) {
      return []
    }

    return element.kind === "presets" ? this.presets : this.profiles
  }
}

export function registerAuthProfilesView(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
): AuthProfilesTreeProvider {
  const provider = new AuthProfilesTreeProvider(client)
  const view = vscode.window.createTreeView("agentproto.authProfiles", {
    treeDataProvider: provider,
    showCollapseAll: false,
  })

  ctx.subscriptions.push(view, provider)
  return provider
}
