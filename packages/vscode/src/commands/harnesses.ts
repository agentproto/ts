/**
 * Commands for the Harnesses tree view.
 *
 * - refreshHarnesses forces the tree to reload adapters.
 * - installHarness is a placeholder for future package-manager integration.
 * - spawnWithHarness jumps into the existing spawn wizard.
 */

import * as vscode from "vscode"

import type { HarnessNode } from "../views/harnessesTree.logic.js"
import type { HarnessesTreeProvider } from "../views/harnessesTree.js"

export function registerHarnessCommands(
  ctx: vscode.ExtensionContext,
  provider: HarnessesTreeProvider,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.refreshHarnesses", () => {
      void provider.refresh()
    }),
    vscode.commands.registerCommand("agentproto.installHarness", () => {
      void vscode.window.showInformationMessage("Install harness: not yet implemented")
    }),
    vscode.commands.registerCommand("agentproto.spawnWithHarness", (_node?: HarnessNode) => {
      void vscode.commands.executeCommand("agentproto.spawnAgent")
    }),
  )
}
