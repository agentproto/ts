/**
 * agentproto.cleanEndedSessions — bulk-archive every ENDED session in one
 * action, so the Sessions panel stops accreting done/stopped/failed rows. It's
 * the safe half of "clean up": archive is reversible (unarchive), and the
 * daemon's `session_gc` only ever touches terminal sessions — a live one is
 * never at risk. Worktree GC is a separate, per-repo dry-run flow (not here).
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import { canArchive } from "./sessionArchive.logic.js"

export function registerSessionCleanup(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.cleanEndedSessions", () =>
      cleanEndedSessions(client, store),
    ),
  )
}

async function cleanEndedSessions(client: DaemonClient, store: SessionStore): Promise<void> {
  const eligible = store.sessions.filter(canArchive).length
  if (eligible === 0) {
    vscode.window.showInformationMessage("agentproto: no ended sessions to clean up.")
    return
  }
  const choice = await vscode.window.showWarningMessage(
    `Archive ${eligible} ended session${eligible === 1 ? "" : "s"}? They stay readable and can be unarchived.`,
    { modal: true },
    "Archive",
  )
  if (choice !== "Archive") return

  try {
    const res = await client.gcSessions()
    await store.refreshAll()
    vscode.window.showInformationMessage(
      `agentproto: archived ${res.count} ended session${res.count === 1 ? "" : "s"}.`,
    )
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: clean-up failed — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
