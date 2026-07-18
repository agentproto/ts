/**
 * Click-the-model-chip flow, triggered by the transcript panel's
 * `changeModel` webview message (see transcriptPanel.ts's
 * `handleWebviewMessage`). Fetches this session's own adapter listing,
 * builds the provider-grouped quick-pick (changeModel.logic.ts — current
 * model marked, cross-mode/arg-strategy rows flagged restart-required),
 * and — on a live-switchable pick — calls the daemon's mid-session
 * `setModel` through the controller. Never optimistic: on success the chip
 * refreshes from the next daemon-driven `sessionUpdate`, not a local write
 * here.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { TranscriptPanelController } from "../webview/transcriptPanelController.js"
import { buildChangeModelPlaceHolder, mapChangeModelQuickPickItems } from "./changeModel.logic.js"

export async function runChangeModelFlow(
  controller: TranscriptPanelController,
  client: DaemonClient,
): Promise<void> {
  const session = controller.session
  if (!session.adapterSlug) {
    void vscode.window.showWarningMessage(
      "agentproto: this session has no adapter recorded — nothing to switch.",
    )
    return
  }

  const adapters = await client.listAdapters().catch(err => {
    void vscode.window.showErrorMessage(
      `agentproto: couldn't load adapters — ${describeError(err)}`,
    )
    return undefined
  })
  if (!adapters) return

  const adapter = adapters.find(a => a.slug === session.adapterSlug)
  if (!adapter) {
    void vscode.window.showWarningMessage(
      `agentproto: adapter "${session.adapterSlug}" is no longer installed.`,
    )
    return
  }

  const items = mapChangeModelQuickPickItems(adapter, session)
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      `agentproto: ${adapter.slug} declares no model menu to switch between.`,
    )
    return
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: buildChangeModelPlaceHolder(session),
  })
  // A separator row can't actually be returned by showQuickPick (vscode
  // never resolves a Separator-kind item as a selection), but the guard
  // costs nothing and keeps this branch honest about what "picked" means.
  if (!picked || picked.kind !== undefined || picked.model === undefined) return

  if (picked.restartRequired) {
    void vscode.window.showWarningMessage(
      `agentproto: switching to "${picked.model}" needs a restart — this session's adapter can't ` +
        "apply it live. Restarting with an overridden model isn't wired up yet.",
    )
    return
  }

  const result = await controller.setModel(picked.model)
  if (!result.applied) {
    void vscode.window.showWarningMessage(
      `agentproto: model switch to "${picked.model}" didn't apply` +
        (result.reason ? ` — ${result.reason}` : "") +
        ".",
    )
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
