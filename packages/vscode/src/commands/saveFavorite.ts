/**
 * agentproto.saveFavorite — "Save as favorite…" from a sessions-tree row.
 * The authoring loop the spawn presets always lacked (audit T1 #2): derive a
 * reusable `UserPreset` from a session you liked, name it, and POST it via
 * `DaemonClient.saveUserPreset`. Once saved it renders pinned atop the "+"
 * spawn flow (prependPresetGroup) and re-spawns with zero further input.
 *
 * Any session with a resolvable descriptor qualifies — capturing spawn axes
 * is pure read state, never a daemon action, so there's no status guard.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import { sessionDisplayName } from "../client/sessionName.js"
import { resolveSessionArg } from "./sessionActions.js"
import { describeSession } from "./sessionActions.logic.js"
import { presetFromSession, slugifyPresetId } from "./saveFavorite.logic.js"

export function registerSaveFavorite(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.saveFavorite", (arg: unknown) =>
      saveFavoriteCommand(client, store, arg),
    ),
  )
}

async function saveFavoriteCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(
    arg,
    store,
    "Select a session to save as a favorite",
    () => true,
    client,
  )
  if (!session) return

  const label = await vscode.window.showInputBox({
    prompt: `Save ${describeSession(session)} as a favorite`,
    placeHolder: "Favorite name — e.g. Fast Opus · this repo",
    value: sessionDisplayName(session),
    ignoreFocusOut: false,
  })
  if (label === undefined) return
  const trimmed = label.trim()
  if (!trimmed) {
    vscode.window.showWarningMessage("agentproto: a favorite needs a name.")
    return
  }

  const id = slugifyPresetId(trimmed)
  if (!id) {
    vscode.window.showWarningMessage(
      "agentproto: that name has no letters or digits to build an id from — pick another.",
    )
    return
  }

  const preset = presetFromSession(session, { id, label: trimmed })
  try {
    await client.saveUserPreset(preset)
    vscode.window.showInformationMessage(
      `agentproto: saved favorite "${trimmed}" — it's pinned atop the + spawn menu.`,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    vscode.window.showErrorMessage(`agentproto: could not save favorite — ${message}`)
  }
}
