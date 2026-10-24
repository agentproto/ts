/**
 * Local Router commands — start / stop the daemon-supervised
 * `@agentproto/llm-endpoint` proxy sidecar from the auth profiles tree's
 * Local Router node. Thin vscode shells over the daemon's
 * `llm_endpoint_start` / `llm_endpoint_stop` verbs; the tree refreshes after
 * each so the status row + discovered models repaint.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"
import type { LocalRouterNode } from "../views/localRouterTree.logic.js"
import type { UpstreamLinkInfo } from "../client/types.js"
import {
  buildLinkQuickPickItems,
  localRouterErrorMessage,
  noEligibleProfilesPlaceholder,
  reloadLlmEndpointPacksMessage,
  setUpstreamLinkMessage,
  startLlmEndpointMessage,
  stopLlmEndpointMessage,
  testLlmEndpointUpstreamMessage,
} from "./localRouter.logic.js"

export function registerLocalRouterCommands(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.startLlmEndpoint", () => {
      void runStartLlmEndpoint(client, provider)
    }),
    vscode.commands.registerCommand("agentproto.stopLlmEndpoint", () => {
      void runStopLlmEndpoint(client, provider)
    }),
    vscode.commands.registerCommand("agentproto.reloadLlmEndpointPacks", () => {
      void runReloadLlmEndpointPacks(client, provider)
    }),
    vscode.commands.registerCommand("agentproto.testLlmEndpointUpstream", (node?: LocalRouterNode) => {
      if (node?.kind === "router-upstream") {
        void runTestLlmEndpointUpstream(client, provider, node.upstream.provider)
      }
    }),
    vscode.commands.registerCommand("agentproto.linkLlmEndpointUpstream", (node?: LocalRouterNode) => {
      if (node?.kind === "router-upstream") {
        void runLinkLlmEndpointUpstream(client, provider, node.upstream.provider)
      }
    }),
  )
}

export async function runStartLlmEndpoint(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): Promise<void> {
  try {
    const desc = await client.llmEndpointStart()
    void vscode.window.showInformationMessage(startLlmEndpointMessage(desc))
    await provider.refresh()
  } catch (err) {
    void vscode.window.showErrorMessage(localRouterErrorMessage("start", err))
  }
}

export async function runStopLlmEndpoint(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): Promise<void> {
  try {
    await client.llmEndpointStop()
    void vscode.window.showInformationMessage(stopLlmEndpointMessage())
    await provider.refresh()
  } catch (err) {
    void vscode.window.showErrorMessage(localRouterErrorMessage("stop", err))
  }
}

export async function runReloadLlmEndpointPacks(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): Promise<void> {
  try {
    const result = await client.llmEndpointReloadPacks()
    void vscode.window.showInformationMessage(reloadLlmEndpointPacksMessage(result))
    await provider.refresh()
  } catch (err) {
    void vscode.window.showErrorMessage(localRouterErrorMessage("reload", err))
  }
}

export async function runTestLlmEndpointUpstream(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
  upstream: string,
): Promise<void> {
  try {
    const result = await client.llmEndpointTestUpstream(upstream)
    void vscode.window.showInformationMessage(testLlmEndpointUpstreamMessage(result))
    await provider.refresh()
  } catch (err) {
    void vscode.window.showErrorMessage(localRouterErrorMessage("test", err))
  }
}

/**
 * Link an upstream to an eligible auth-profile (or unlink to the env key) via a
 * QuickPick of profiles the daemon reports eligible for that upstream. Persists
 * the link, surfaces the restart-required outcome, and — when a restart is
 * needed — offers to restart the router right away (stop → start, preserving the
 * running port). Refreshes the tree so the row repaints.
 */
export async function runLinkLlmEndpointUpstream(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
  upstream: string,
): Promise<void> {
  try {
    const links = await client.llmEndpointListLinks()
    const info: UpstreamLinkInfo = links.upstreams.find(u => u.provider === upstream) ?? {
      provider: upstream,
      linkedProfile: links.links[upstream] ?? null,
      eligible: [],
    }
    const items = buildLinkQuickPickItems(info).map(item => ({
      label: item.label,
      description: item.description,
      picked: item.picked,
      profileId: item.profileId,
    }))
    const placeholder =
      info.eligible.length > 0
        ? `Link ${upstream} to an auth-profile (or use its env key)`
        : noEligibleProfilesPlaceholder(upstream)
    const choice = await vscode.window.showQuickPick(items, {
      title: `Link credential — ${upstream}`,
      placeHolder: placeholder,
    })
    if (!choice) return // user dismissed the picker
    const result = await client.llmEndpointSetUpstreamLink(upstream, choice.profileId)
    await provider.refresh()
    if (result.restartRequired) {
      const restart = await vscode.window.showInformationMessage(
        setUpstreamLinkMessage(result),
        "Restart Router",
      )
      if (restart === "Restart Router") {
        await runRestartForLink(client, provider)
      }
      return
    }
    void vscode.window.showInformationMessage(setUpstreamLinkMessage(result))
  } catch (err) {
    void vscode.window.showErrorMessage(localRouterErrorMessage("link", err))
  }
}

/** Restart the router to apply a just-persisted link: stop, then start on the
 *  same port the running child bound (access tokens can't be recovered — they
 *  are never surfaced — so a token-gated router must be restarted by hand). */
async function runRestartForLink(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): Promise<void> {
  try {
    const status = await client.llmEndpointStatus()
    await client.llmEndpointStop()
    const desc = await client.llmEndpointStart(
      typeof status.port === "number" ? { port: status.port } : {},
    )
    void vscode.window.showInformationMessage(startLlmEndpointMessage(desc))
    await provider.refresh()
  } catch (err) {
    void vscode.window.showErrorMessage(localRouterErrorMessage("start", err))
  }
}
