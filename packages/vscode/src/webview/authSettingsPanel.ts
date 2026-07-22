/**
 * Auth Settings webview — the richer, panel-sized counterpart to the Auth
 * Profiles tree. It reuses the same daemon reads (presets + catalog + auth
 * profiles) and the same connect/delete flows the tree's context menu drives,
 * but lays them out as a full page: providers with one-click Connect, and each
 * wallet with the exact models it bills (active vs inactive). A single panel is
 * kept per window; re-invoking reveals it.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { ProviderPresetEntry } from "../client/types.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"
import { runConnectPresetFlow, runCreateAuthProfileFlow, runDeleteAuthProfileFlow } from "../commands/authProfiles.js"
import { buildAuthSettingsHtml, buildAuthSettingsModel } from "./authSettingsPanel.logic.js"

interface InboundMessage {
  type: "connect" | "delete" | "addProfile" | "refresh"
  slug?: string
  id?: string
}

export function registerAuthSettingsPanel(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): void {
  let panel: vscode.WebviewPanel | undefined
  let presets: ProviderPresetEntry[] = []

  async function render(): Promise<void> {
    if (!panel) return
    try {
      const [presetEntries, catalog, profiles] = await Promise.all([
        client.listProviderPresets(),
        client.catalogModels(),
        client.listAuthProfiles(),
      ])
      presets = presetEntries
      const model = buildAuthSettingsModel(presetEntries, catalog, profiles)
      panel.webview.html = buildAuthSettingsHtml(model, randomBytes(16).toString("hex"))
    } catch (err) {
      const nonce = randomBytes(16).toString("hex")
      panel.webview.html = buildAuthSettingsHtml({ presets: [], wallets: [] }, nonce)
      void vscode.window.showErrorMessage(
        `agentproto: could not load auth settings — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async function onMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "connect": {
        const preset = presets.find(p => p.slug === msg.slug)
        if (preset) await runConnectPresetFlow(client, provider, preset)
        break
      }
      case "delete":
        if (msg.id) await runDeleteAuthProfileFlow(client, provider, msg.id)
        break
      case "addProfile":
        await runCreateAuthProfileFlow(client, provider)
        break
      case "refresh":
        break
    }
    // Every action ends by re-reading the daemon so the panel reflects the new
    // state (the flows already refreshed the tree).
    await render()
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.openAuthSettings", async () => {
      if (panel) {
        panel.reveal(vscode.ViewColumn.Active)
        return
      }
      panel = vscode.window.createWebviewPanel(
        "agentproto.authSettings",
        "agentproto: Auth Settings",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      )
      panel.onDidDispose(() => { panel = undefined }, undefined, ctx.subscriptions)
      panel.webview.onDidReceiveMessage(
        (m: InboundMessage) => void onMessage(m),
        undefined,
        ctx.subscriptions,
      )
      await render()
    }),
  )
}
