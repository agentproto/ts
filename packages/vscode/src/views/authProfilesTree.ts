/**
 * Auth Profiles tree view — shows provider presets and catalog-derived model
 * profiles under view id `agentproto.authProfiles`.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type {
  AuthProfileSummary,
  CatalogModelsResponse,
} from "../client/types.js"
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
import {
  buildCatalogPricingIndex,
  emptyPricingIndex,
  lookupModelPricing,
  modelRowDescription,
  parseDiscoveredModels,
  resolveRouterModelChildren,
  routerContextValue,
  routerDescription,
  routerIcon,
  routerLabel,
  routerServing,
  routerTooltip,
  type CatalogPricingIndex,
  type DiscoveredModel,
  type LlmEndpointStatusResult,
  type ModelsFetcher,
} from "./localRouterTree.logic.js"

const PRESETS_GROUP: AuthProfileGroup = { kind: "presets", label: "Provider Presets" }
const PROFILES_GROUP: AuthProfileGroup = { kind: "profiles", label: "Model Profiles" }

async function defaultFetchModels(baseUrl: string): Promise<DiscoveredModel[]> {
  const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5_000) })
  if (!res.ok) {
    throw new Error(`GET ${baseUrl}/v1/models failed: HTTP ${res.status}`)
  }
  return parseDiscoveredModels(await res.json())
}

export class AuthProfilesTreeProvider
  implements vscode.TreeDataProvider<AuthProfileTreeNode>, vscode.Disposable
{
  private readonly client: DaemonClient
  private readonly fetchModels: ModelsFetcher
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChange.event

  private presets: AuthProfileNode[] = []
  private profiles: AuthProfileNode[] = []
  private servicedByProfile = new Map<string, ServicedModel[]>()
  private profilesById = new Map<string, AuthProfileSummary>()
  private loadError = false
  // Kept for the Local Router's discovered-model pricing cross-reference — the
  // same catalog the profiles tree is already built from, so no extra fetch.
  private catalog: CatalogModelsResponse = { vendors: [] }
  // Pricing keyed by every id a discovered model might carry (route ref /
  // vendor/product / product), plus per-product vendor sets so an owned_by-aware
  // lookup can disambiguate. Rebuilt with the catalog so the router-model rows
  // render prices without walking the catalog per item.
  private pricingIndex: CatalogPricingIndex = emptyPricingIndex()
  private routerStatus: LlmEndpointStatusResult | null = null

  constructor(client: DaemonClient, fetchModels: ModelsFetcher = defaultFetchModels) {
    this.client = client
    this.fetchModels = fetchModels
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
      this.catalog = catalog
      this.pricingIndex = buildCatalogPricingIndex(catalog)
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
      this.catalog = { vendors: [] }
      this.pricingIndex = emptyPricingIndex()
    }
    // The Local Router lives on its OWN fetch: an older daemon without the
    // llm_endpoint_* verbs (or a transient failure) must not blank the auth
    // tree, so its status is resolved independently and degrades to "stopped".
    try {
      this.routerStatus = await this.client.llmEndpointStatus()
    } catch {
      this.routerStatus = null
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

    // The Local Router node — a top-level sibling of the two groupings that
    // renders the llm-endpoint proxy's lifecycle status. Expandable (to its
    // discovered models) only when it's up AND its /v1/models probe passed.
    if (element.kind === "router") {
      const status = this.routerStatus
      const collapsibleState = routerServing(status)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
      const item = new vscode.TreeItem(routerLabel(status), collapsibleState)
      item.id = "local-router"
      item.description = routerDescription(status)
      item.tooltip = new vscode.MarkdownString(routerTooltip(status))
      item.iconPath = new vscode.ThemeIcon(routerIcon(status))
      // Drives the start/stop menu split (start-when-stopped, stop-when-running).
      item.contextValue = routerContextValue(status)
      return item
    }

    // A discovered model the proxy currently serves, with catalog pricing
    // cross-referenced for display.
    if (element.kind === "router-model") {
      const model = element.model
      const pricing = lookupModelPricing(this.pricingIndex, model.id, model.ownedBy)
      const item = new vscode.TreeItem(model.id)
      item.id = `router-model:${model.id}`
      item.description = modelRowDescription(model, pricing)
      item.tooltip = new vscode.MarkdownString(
        [
          `**${model.id}**`,
          ``,
          ...(model.ownedBy ? [`- Owned by: ${model.ownedBy}`] : []),
          `- Pricing: ${pricing ? `$${pricing.inPer1M} in / $${pricing.outPer1M} out per 1M tokens` : "no catalog pricing"}`,
        ].join("\n"),
      )
      item.iconPath = new vscode.ThemeIcon("symbol-method")
      item.contextValue = "local-router-model"
      return item
    }

    // A "loading…"/"unavailable"/"no models" placeholder child.
    if (element.kind === "router-message") {
      const item = new vscode.TreeItem(element.message)
      item.id = `router-message:${element.message}`
      item.iconPath = new vscode.ThemeIcon("info")
      item.contextValue = "local-router-message"
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

  getChildren(element?: AuthProfileTreeNode): vscode.ProviderResult<AuthProfileTreeNode[]> {
    if (!element) {
      // The Local Router sits alongside the two auth groupings and stays
      // present even when the auth load failed — it's on an independent fetch,
      // so a router that's up is still usable while the profiles tree recovers.
      const roots: AuthProfileTreeNode[] = this.loadError
        ? [{ kind: "presets", label: "Could not load auth profiles" }]
        : [PRESETS_GROUP, PROFILES_GROUP]
      roots.push({ kind: "router" })
      return roots
    }

    // Expanding the Local Router fetches its live /v1/models. Returning the
    // promise lets VS Code render the rest of the tree immediately and only
    // spin on the router's own children (async, never blocks siblings).
    if (element.kind === "router") {
      return this.loadRouterChildren()
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

  /** Fetch + build the Local Router's discovered-model children. Only reached
   *  when the node is expandable (running & healthy); the orchestration
   *  (resolveRouterModelChildren) surfaces a mid-poll failure or a missing
   *  address as a placeholder message rather than a silently-empty node. */
  private loadRouterChildren(): Promise<AuthProfileTreeNode[]> {
    return resolveRouterModelChildren(this.routerStatus, this.fetchModels)
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
