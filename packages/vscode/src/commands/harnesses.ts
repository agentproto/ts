/**
 * Commands for the Harnesses tree view.
 *
 * - refreshHarnesses forces the tree to reload adapters.
 * - installHarness installs a not-yet-`ready` harness via the daemon's
 *   `adapter_install` verb, then refreshes the tree.
 * - spawnWithHarness jumps into the existing spawn wizard.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import { canInstallHarness, type HarnessNode } from "../views/harnessesTree.logic.js"
import type { HarnessesTreeProvider } from "../views/harnessesTree.js"

export function registerHarnessCommands(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  provider: HarnessesTreeProvider,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.refreshHarnesses", () => {
      void provider.refresh()
    }),
    vscode.commands.registerCommand("agentproto.installHarness", (node?: HarnessNode) => {
      void installHarness(client, provider, node)
    }),
    vscode.commands.registerCommand("agentproto.spawnWithHarness", (_node?: HarnessNode) => {
      void vscode.commands.executeCommand("agentproto.spawnAgent")
    }),
  )
}

/**
 * Install the harness backing `node` via the daemon, under a progress
 * notification, then refresh the tree. Invoked from the inline/context
 * action, which only shows on installable rows — but we re-check here so a
 * command-palette or stale invocation can't drive an install on a `ready`
 * (or unknown) harness.
 */
async function installHarness(
  client: DaemonClient,
  provider: HarnessesTreeProvider,
  node?: HarnessNode,
): Promise<void> {
  const adapter = node?.adapter
  if (!adapter?.slug) {
    void vscode.window.showInformationMessage(
      "Install harness: select a harness row in the Harnesses view.",
    )
    return
  }
  if (!canInstallHarness(adapter.status)) {
    void vscode.window.showInformationMessage(
      `'${adapter.slug}' is already installed (${adapter.status ?? "unknown"}).`,
    )
    return
  }

  const slug = adapter.slug
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Installing harness '${slug}'…`,
      cancellable: false,
    },
    async () => {
      try {
        const result = await client.installAdapter(slug)
        if (result.ok) {
          void vscode.window.showInformationMessage(
            result.message || `Installed '${slug}'.`,
          )
        } else {
          void vscode.window.showErrorMessage(
            result.message || `Failed to install '${slug}'.`,
          )
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Install harness '${slug}' failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        // Always refresh — adapter_list is the source of truth for the row's
        // new status whether the install succeeded, partially applied, or the
        // served tree simply un-staled.
        await provider.refresh()
      }
    },
  )
}
