/**
 * Auth profile commands: refresh the auth profiles tree and open the
 * configuration flow for a profile or preset.
 */

import * as vscode from "vscode"

import type { AuthProfileNode } from "../views/authProfilesTree.logic.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"

export function registerAuthProfileCommands(
  ctx: vscode.ExtensionContext,
  provider: AuthProfilesTreeProvider,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.refreshAuthProfiles", () => {
      void provider.refresh()
    }),
    vscode.commands.registerCommand("agentproto.configureAuthProfile", (node?: AuthProfileNode) => {
      void vscode.window.showInformationMessage("Configure auth profile: not yet implemented")
    }),
  )
}
