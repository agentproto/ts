/**
 * agentproto.restartSession — revive an exited/killed/error session via the
 * MCP-only `session_restart` tool (there is no HTTP restart route). The
 * daemon has no status guard of its own — restarting a still-alive session
 * would silently spawn a duplicate — so `canRestart` (sessionRestart.logic.ts)
 * is the gate that keeps this command from being a foot-gun, both for a
 * direct tree-item arg and for the command-palette quick-pick. Restart
 * always mints a NEW session id (continuity is via adapter/PTY resume, never
 * id reuse), so on success we reveal/open THAT id, not the one we restarted.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import { resolveSessionArg } from "./sessionActions.js"
import { describeSession } from "./sessionActions.logic.js"
import { canRestart, describeRestart, parseRestartResult } from "./sessionRestart.logic.js"

export function registerSessionRestart(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.restartSession", (arg: unknown) =>
      restartSessionCommand(client, store, arg),
    ),
  )
}

async function restartSessionCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(arg, store, "Select a session to restart", canRestart)
  if (!session) return

  if (!canRestart(session)) {
    vscode.window.showWarningMessage(
      `agentproto: ${describeSession(session)} is still live — restart only applies to an exited/killed/error session.`,
    )
    return
  }

  try {
    const raw = await client.mcpCall("session_restart", { idOrName: session.id })
    const result = parseRestartResult(raw)
    if (!result) {
      vscode.window.showErrorMessage(
        `agentproto: restart of ${describeSession(session)} returned an unrecognised result.`,
      )
      return
    }
    await store.refreshAll()
    vscode.window.showInformationMessage(describeRestart(session, result))
    await vscode.commands.executeCommand("agentproto.openTranscript", result.id)
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: restart of ${describeSession(session)} failed — ${describeError(err)}`,
    )
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
