/**
 * agentproto.renameSession — the sessions-tree context-menu twin of the
 * transcript header's click-to-edit (SPEC-3 FIX B). Prompts for a new name and
 * writes it via `PATCH /sessions/:id` (`DaemonClient.renameSession`).
 *
 * Writes `label`, not `title`: the daemon flags a `session_rename` write with
 * `renamedByUser`, which makes a user's `label` out-rank the derived `title`
 * in every display chain (`sessionDisplayName`) — so writing it guarantees the
 * rename shows, while the auto-derived `title` stays as the fallback (a SPAWN
 * label, unflagged, now sorts BELOW the title instead). An emptied box clears
 * the label — the row reverts to the derived title / the friendly `adapter ·
 * id` fallback.
 *
 * Any session can be renamed (live, awaiting, done, archived) — it's pure
 * display state, never a daemon action, so there's no status guard. The live
 * `session:renamed` event flows back through the store's poll loop and
 * repaints the tree; `store.refreshAll()` is a belt-and-braces immediate
 * refresh for the common case where the user is watching the row they edited.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import { sessionDisplayName } from "../client/sessionName.js"
import { resolveSessionArg } from "./sessionActions.js"
import { describeSession } from "./sessionActions.logic.js"

export function registerSessionRename(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.renameSession", (arg: unknown) =>
      renameSessionCommand(client, store, arg),
    ),
  )
}

async function renameSessionCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(
    arg,
    store,
    "Select a session to rename",
    () => true,
    client,
  )
  if (!session) return

  // Prefill with the CURRENT editable name (label, else the derived title) —
  // never the adapter·id fallback, which the user shouldn't accidentally
  // commit as a real name. `undefined` when neither is set → an empty box.
  const current = session.label ?? session.title
  const next = await vscode.window.showInputBox({
    prompt: `Rename ${describeSession(session)}`,
    placeHolder: `e.g. ${sessionDisplayName(session)}`,
    value: current ?? "",
    // A rename box the user opened and dismissed with Escape returns undefined;
    // an emptied box that they confirm returns "" (an intentional clear).
    ignoreFocusOut: false,
  })
  if (next === undefined) return

  try {
    await client.renameSession(session.id, { label: next.trim() })
    await store.refreshAll()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    vscode.window.showErrorMessage(`agentproto: rename failed — ${message}`)
  }
}
