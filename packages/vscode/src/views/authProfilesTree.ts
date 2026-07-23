/**
 * Auth Profiles tree view — shows provider presets and catalog-derived model
 * profiles under view id `agentproto.authProfiles`.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { AuthProfileSummary } from "../client/types.js"
import {
  buildPresetNodes,
  buildProfileNodesWithProfiles,
  isAuthProfileGroup,
  presetConnectionIcon,
  presetRowDescription,
  presetTooltip,
  profileContextValue,
  profileRowDescription,
  profileRowTooltip,
  servicedModelDescription,
  servicedModelIcon,
  servicedModelsByProfile,
  type AuthProfileGroup,
  type AuthProfileNode,
  type AuthProfileTreeNode,
  type ServicedModel,
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
  private servicedByProfile = new Map<string, ServicedModel[]>()
  private profilesById = new Map<string, AuthProfileSummary>()
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
      const [presetEntries, catalog, authProfiles] = await Promise.all([
        this.client.listProviderPresets(),
        this.client.catalogModels(),
        this.client.listAuthProfiles(),
      ])
      this.servicedByProfile = servicedModelsByProfile(catalog)
      this.profilesById = new Map(authProfiles.map(p => [p.id, p]))
      this.presets = buildPresetNodes(presetEntries, authProfiles)
      this.profiles = buildProfileNodesWithProfiles(catalog, authProfiles).map(profile => ({
        kind: "profile",
        ...profile,
      }))
    } catch {
      this.loadError = true
      this.presets = []
      this.profiles = []
      this.servicedByProfile = new Map()
      this.profilesById = new Map()
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
      item.description = presetRowDescription(preset, element.connected)
      item.tooltip = new vscode.MarkdownString(presetTooltip(preset))
      item.iconPath = new vscode.ThemeIcon(presetConnectionIcon(element.connected))
      // Split by connection so the menu offers "Connect" only where it applies,
      // and clicking an unconnected preset jumps straight into the connect flow
      // (bound to this endpoint) rather than the generic create wizard.
      item.contextValue = element.connected ? "auth-preset-connected" : "auth-preset-unconnected"
      if (!element.connected) {
        item.command = {
          command: "agentproto.connectAuthProfile",
          title: "Connect a profile",
          arguments: [element],
        }
      }
      return item
    }

    if (element.kind === "profile-model") {
      const model = element.model
      const item = new vscode.TreeItem(model.product)
      item.id = `profile-model:${element.profileId}:${model.ref}`
      item.description = servicedModelDescription(model)
      item.tooltip = new vscode.MarkdownString(
        [`**${model.product}**`, ``, `- Ref: \`${model.ref}\``, `- Route: ${model.route}`, `- Vendor: ${model.vendor}`].join("\n"),
      )
      item.iconPath = new vscode.ThemeIcon(servicedModelIcon(model))
      item.contextValue = "auth-profile-model"
      return item
    }

    // A profile node — expandable when it services at least one model.
    const serviced = this.servicedByProfile.get(element.profileId) ?? []
    const summary = this.profilesById.get(element.profileId)
    const collapsibleState =
      serviced.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    const item = new vscode.TreeItem(element.profileId, collapsibleState)
    item.id = `profile:${element.profileId}`
    item.description = profileRowDescription(element.routesCount, summary)
    item.tooltip = new vscode.MarkdownString(
      profileRowTooltip(element.profileId, element.routesCount, summary),
    )
    // A disabled profile reads as muted/off; an enabled one keeps the account
    // glyph. The context value drives the enable/disable menu split (WS2).
    item.iconPath = new vscode.ThemeIcon(summary?.disabled ? "circle-slash" : "account")
    item.contextValue = profileContextValue(summary)
    return item
  }

  getChildren(element?: AuthProfileTreeNode): AuthProfileTreeNode[] {
    if (this.loadError) {
      return [{ kind: "presets", label: "Could not load auth profiles" }]
    }

    if (!element) {
      return [PRESETS_GROUP, PROFILES_GROUP]
    }

    if (isAuthProfileGroup(element)) {
      return element.kind === "presets" ? this.presets : this.profiles
    }

    // Expanding a profile node reveals the models it can bill.
    if (element.kind === "profile") {
      const serviced = this.servicedByProfile.get(element.profileId) ?? []
      return serviced.map(model => ({ kind: "profile-model", profileId: element.profileId, model }))
    }

    return []
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
