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
import {
  localRouterErrorMessage,
  startLlmEndpointMessage,
  stopLlmEndpointMessage,
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
