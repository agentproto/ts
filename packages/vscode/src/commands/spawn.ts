/**
 * agentproto.spawnAgent — quick-pick wizard: adapter → model → mode (only
 * when the adapter declares any) → cwd → label → initial prompt, then
 * POST /sessions/agent. Escape at any step aborts the whole wizard; an
 * empty input box means "use the adapter default" and continues.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import {
  assembleSpawnOptions,
  CUSTOM_MODEL_LABEL,
  mapAdapterQuickPickItems,
  mapModeQuickPickItems,
  mapModelQuickPickItems,
  type SpawnAdapterInfo,
  type SpawnWizardAnswers,
} from "./spawn.logic.js"

export function registerSpawnCommand(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.spawnAgent", () => runSpawnWizard(client, store)),
  )
}

async function runSpawnWizard(client: DaemonClient, store: SessionStore): Promise<void> {
  let adapters: SpawnAdapterInfo[]
  try {
    adapters = (await client.listAdapters()) as SpawnAdapterInfo[]
  } catch (err) {
    vscode.window.showErrorMessage(`agentproto: could not list adapters — ${describeError(err)}`)
    return
  }
  if (adapters.length === 0) {
    vscode.window.showWarningMessage("agentproto: no adapters installed on the daemon.")
    return
  }

  const adapterPick = await vscode.window.showQuickPick(mapAdapterQuickPickItems(adapters), {
    placeHolder: "Select an agent adapter to spawn",
  })
  if (!adapterPick) return

  const answers: SpawnWizardAnswers = { adapter: adapterPick.adapter.slug }

  const modelPick = await vscode.window.showQuickPick(
    mapModelQuickPickItems(adapterPick.adapter.models ?? []),
    { placeHolder: "Select a model (Escape for adapter default)" },
  )
  if (!modelPick) return
  if (modelPick.custom) {
    const custom = await vscode.window.showInputBox({
      prompt: "Custom model id (leave empty for adapter default)",
    })
    if (custom === undefined) return
    if (custom) answers.model = custom
  } else if (modelPick.label !== CUSTOM_MODEL_LABEL) {
    answers.model = modelPick.label
  }

  const modeItems = mapModeQuickPickItems(adapterPick.adapter.modes)
  if (modeItems.length > 0) {
    const modePick = await vscode.window.showQuickPick(modeItems, { placeHolder: "Select a mode" })
    if (!modePick) return
    answers.mode = modePick.mode
  }

  const defaultCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""
  const cwd = await vscode.window.showInputBox({ prompt: "Working directory", value: defaultCwd })
  if (cwd === undefined) return
  if (cwd) answers.cwd = cwd

  const label = await vscode.window.showInputBox({ prompt: "Session label (optional)" })
  if (label === undefined) return
  if (label) answers.label = label

  const prompt = await vscode.window.showInputBox({ prompt: "Initial prompt (optional)" })
  if (prompt === undefined) return
  if (prompt) answers.prompt = prompt

  try {
    const session = await client.spawnAgent(assembleSpawnOptions(answers))
    void vscode.window
      .showInformationMessage(`agentproto: spawned ${session.label ?? session.id}`, "Open transcript")
      .then(choice => {
        if (choice === "Open transcript") {
          void vscode.commands.executeCommand("agentproto.openTranscript", session.id)
        }
      })
    await vscode.commands.executeCommand("agentproto.sessions.focus")
    await store.refreshAll()
  } catch (err) {
    vscode.window.showErrorMessage(`agentproto: spawn failed — ${describeError(err)}`)
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
