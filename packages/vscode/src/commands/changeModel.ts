/**
 * Click-the-model-chip flow, triggered by the transcript panel's
 * `changeModel` webview message (see transcriptPanel.ts's
 * `handleWebviewMessage`). Fetches this session's own adapter listing,
 * builds the provider-grouped quick-pick (changeModel.logic.ts — current
 * model marked, cross-mode/arg-strategy/route-mismatch rows flagged
 * restart-required), and — on a live-switchable pick — calls the daemon's
 * mid-session `setModel` through the controller. A synthetic "Change route"
 * top-row hands off to the route chip picker instead of picking a model.
 * Never optimistic: on success the chip refreshes from the next daemon-driven
 * `sessionUpdate`, not a local write here.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { TranscriptPanelController } from "../webview/transcriptPanelController.js"
import {
  buildChangeModelPlaceHolder,
  makeChangeRouteItem,
  mapChangeModelQuickPickItems,
} from "./changeModel.logic.js"

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

  const items = [makeChangeRouteItem(), ...mapChangeModelQuickPickItems(adapter, session)]

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: buildChangeModelPlaceHolder(session),
  })
  // A separator row can't actually be returned by showQuickPick (vscode
  // never resolves a Separator-kind item as a selection), but the guard
  // costs nothing and keeps this branch honest about what "picked" means.
  if (!picked || picked.kind !== undefined) return

  if (picked.openRouteChip) {
    await vscode.commands.executeCommand("agentproto.configureSessionAxis", {
      sessionId: session.id,
      axis: "route",
    })
    return
  }

  if (picked.model === undefined) return

  if (picked.restartRequired) {
    const go = await vscode.window.showWarningMessage(
      `Switching to "${picked.model}" restarts the session — the conversation carries over. Continue?`,
      { modal: true },
      "Restart & switch",
    )
    if (go !== "Restart & switch") return
    try {
      const result = await client.restartSessionWithOverride(session.id, { model: picked.model })
      await vscode.commands.executeCommand("agentproto.openTranscript", result.id)
      void vscode.window.showInformationMessage(
        `agentproto: restarted as ${result.label ?? result.id}` +
          (result.resumeVia ? ` (${result.resumeVia})` : "") +
          ".",
      )
    } catch (err) {
      void vscode.window.showErrorMessage(
        `agentproto: restart failed — ${describeError(err)}`,
      )
    }
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
