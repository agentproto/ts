/**
 * Status-bar item showing this window's pinned target workspace (WorkspacePinStore)
 * — `$(root-folder) <slug>` when pinned, `$(root-folder) Auto` otherwise. Click
 * runs `agentproto.selectWorkspace`. The human-visible counterpart to the
 * client-side-only pin: the whole point of the pin is that it's per-window and
 * never touches the daemon's global `active` workspace, so there must be
 * somewhere on screen that says what it currently resolves to.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { WorkspacesConfig } from "../client/types.js"
import { EMPTY_WORKSPACES } from "../services/workspaces.logic.js"
import { buildPinStatusText } from "../services/workspacePin.logic.js"
import type { WorkspacePinStore } from "../services/workspacePin.js"

const STATUS_BAR_PRIORITY = 50

export function registerWorkspacePinStatusBar(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  pinStore: WorkspacePinStore,
): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY)
  item.command = "agentproto.selectWorkspace"
  item.tooltip = "agentproto: target workspace for this window's spawns — click to change"

  let config: WorkspacesConfig = EMPTY_WORKSPACES

  const paint = (): void => {
    item.text = buildPinStatusText(config, pinStore.get())
    item.show()
  }

  const refresh = async (): Promise<void> => {
    try {
      config = await client.listWorkspaces()
    } catch {
      // Old daemon with no /workspaces route, or unreachable — degrade to
      // rendering the bare slug (or Auto) rather than hide the item.
      config = EMPTY_WORKSPACES
    }
    paint()
  }

  ctx.subscriptions.push(item)
  ctx.subscriptions.push(pinStore.onDidChange(() => void refresh()))
  void refresh()
}
