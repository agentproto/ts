/**
 * agentproto.archiveSession / agentproto.unarchiveSession — housekeeping
 * only, via the MCP-only `session_archive`/`session_unarchive` tools. Unlike
 * `session_restart`, the daemon DOES guard archive server-side (refuses a
 * still-alive session), so a rejected archive surfaces the daemon's own
 * message rather than a client-invented one; `canArchive`/`canUnarchive`
 * (sessionArchive.logic.ts) still gate the command up front so the
 * quick-pick / tree action never even offers the wrong verb.
 *
 * Archiving drops the row out of the store's next refresh (the daemon's
 * default `list()` already excludes it) — no special-case removal needed
 * here, `store.refreshAll()` is enough. Unarchiving only becomes visible
 * again once the "show archived" toggle is on (see sessionStore.ts's
 * `showArchived` / the `agentproto.toggleShowArchived` command).
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import { resolveSessionArg } from "./sessionActions.js"
import { describeSession } from "./sessionActions.logic.js"
import { canArchive, canUnarchive } from "./sessionArchive.logic.js"

export function registerSessionArchive(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.archiveSession", (arg: unknown) =>
      archiveSessionCommand(client, store, arg),
    ),
    vscode.commands.registerCommand("agentproto.unarchiveSession", (arg: unknown) =>
      unarchiveSessionCommand(client, store, arg),
    ),
  )
}

async function archiveSessionCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(arg, store, "Select a session to archive", canArchive)
  if (!session) return

  if (!canArchive(session)) {
    vscode.window.showWarningMessage(
      `agentproto: ${describeSession(session)} can't be archived — only an exited/killed/error session may be archived.`,
    )
    return
  }

  try {
    await client.archiveSession(session.id)
    await store.refreshAll()
    vscode.window.showInformationMessage(`agentproto: archived ${describeSession(session)}`)
  } catch (err) {
    vscode.window.showErrorMessage(`agentproto: archive failed — ${describeError(err)}`)
  }
}

async function unarchiveSessionCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(arg, store, "Select a session to unarchive", canUnarchive)
  if (!session) return

  if (!canUnarchive(session)) {
    vscode.window.showWarningMessage(`agentproto: ${describeSession(session)} is not archived.`)
    return
  }

  try {
    await client.unarchiveSession(session.id)
    await store.refreshAll()
    vscode.window.showInformationMessage(`agentproto: unarchived ${describeSession(session)}`)
  } catch (err) {
    vscode.window.showErrorMessage(`agentproto: unarchive failed — ${describeError(err)}`)
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
