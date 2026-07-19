/**
 * agentproto.selectWorkspace — picks this window's pinned target workspace.
 *
 * Deliberately client-side only: it writes to WorkspacePinStore
 * (workspaceState), never to the daemon's global `active` workspace (the
 * footgun the workspace-cwd audit identified — a mutation from any window
 * would move where every OTHER window's un-cwd'd spawn lands). See
 * spawn.ts's use of WorkspacePinStore for where the pin actually takes
 * effect.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import { EMPTY_WORKSPACES } from "../services/workspaces.logic.js"
import { mapWorkspacePinQuickPickItems } from "../services/workspacePin.logic.js"
import type { WorkspacePinStore } from "../services/workspacePin.js"

export function registerSelectWorkspaceCommand(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  pinStore: WorkspacePinStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.selectWorkspace", async () => {
      let config
      try {
        config = await client.listWorkspaces()
      } catch {
        // Old daemon with no /workspaces route, or unreachable — degrade to
        // an Auto-only picker rather than block the command.
        config = EMPTY_WORKSPACES
      }
      const picked = await vscode.window.showQuickPick(mapWorkspacePinQuickPickItems(config), {
        placeHolder: "Select the target workspace for this window's spawns",
      })
      if (!picked) return
      await pinStore.set(picked.slug)
    }),
  )
}
