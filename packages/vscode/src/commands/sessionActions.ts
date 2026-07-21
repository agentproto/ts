/**
 * agentproto.promptSession / interruptSession / killSession. Every command
 * accepts a tree-item arg shaped `{ session }`, a raw SessionDescriptor, or
 * undefined — the last falls back to a quick-pick of live sessions
 * (normalizeSessionArg + resolveSessionArg in sessionActions.logic.ts /
 * below, pure and unit-tested).
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import {
  describeSession,
  isLiveSession,
  mapSessionsToQuickPickItems,
  normalizeSessionArg,
} from "./sessionActions.logic.js"
import { interpretStopChoice, STOP_AND_SILENCE_BUTTON, STOP_BUTTON } from "./stopConfirm.logic.js"

export function registerSessionActions(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.promptSession", (arg: unknown) =>
      promptSessionCommand(client, store, arg),
    ),
    vscode.commands.registerCommand("agentproto.interruptSession", (arg: unknown) =>
      interruptSessionCommand(client, store, arg),
    ),
    vscode.commands.registerCommand("agentproto.killSession", (arg: unknown) =>
      killSessionCommand(client, store, arg),
    ),
    vscode.commands.registerCommand("agentproto.copySessionId", (arg: unknown) =>
      copySessionIdCommand(store, arg),
    ),
  )
}

/** Quick-pick a session from a list; shown when a command needs one and got no arg. */
export async function pickSession(
  sessions: SessionDescriptor[],
  placeHolder: string,
): Promise<SessionDescriptor | undefined> {
  if (sessions.length === 0) {
    vscode.window.showWarningMessage("agentproto: no matching sessions.")
    return undefined
  }
  const picked = await vscode.window.showQuickPick(mapSessionsToQuickPickItems(sessions), {
    placeHolder,
  })
  return picked?.session
}

/**
 * Resolve a command arg to a SessionDescriptor: a tree node / descriptor, else
 * a bare session-id string, else a quick-pick (default: live sessions only).
 *
 * The bare-id arm matters: programmatic callers pass an id string, not a
 * descriptor — `agentproto.restartSession` reveals the session it just minted,
 * and spawn's "Open transcript" toast action reveals the one it just spawned.
 * Without it, `normalizeSessionArg` rejects the string (it only unwraps
 * objects) and the caller silently falls through to a QuickPick over EVERY
 * session — so the one thing the user asked to see is the one thing they then
 * have to hunt for. Falls back to the store first (no round-trip) and only
 * then to the daemon, since a just-restarted id may not be in the local
 * snapshot yet.
 */
export async function resolveSessionArg(
  arg: unknown,
  store: SessionStore,
  placeHolder: string,
  filter: (session: SessionDescriptor) => boolean = isLiveSession,
  client?: DaemonClient,
): Promise<SessionDescriptor | undefined> {
  const direct = normalizeSessionArg(arg)
  if (direct) return direct
  if (typeof arg === "string" && arg.length > 0) {
    const known = store.sessions.find(s => s.id === arg)
    if (known) return known
    if (client) {
      try {
        return await client.getSession(arg)
      } catch {
        // Unknown id — fall through to the picker rather than dead-ending.
      }
    }
  }
  return pickSession(store.sessions.filter(filter), placeHolder)
}

async function promptSessionCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(arg, store, "Select a session to prompt")
  if (!session) return
  const text = await vscode.window.showInputBox({
    prompt: `Prompt ${describeSession(session)}`,
    placeHolder: "Type a prompt…",
  })
  if (!text) return
  client
    .prompt(session.id, text, { wait: false })
    .catch(err => vscode.window.showErrorMessage(`agentproto: prompt failed — ${describeError(err)}`))
  vscode.window.showInformationMessage(`agentproto: prompt queued for ${describeSession(session)}`)
}

async function interruptSessionCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(arg, store, "Select a session to interrupt")
  if (!session) return
  const text = await vscode.window.showInputBox({
    prompt: `Interrupt ${describeSession(session)}`,
    placeHolder: "redirects the in-flight turn onto this prompt",
  })
  if (!text) return
  client
    .prompt(session.id, text, { interrupt: true, wait: false })
    .catch(err => vscode.window.showErrorMessage(`agentproto: interrupt failed — ${describeError(err)}`))
  vscode.window.showInformationMessage(`agentproto: interrupt queued for ${describeSession(session)}`)
}

/**
 * "Stop", not "Kill" — every other button in this UI is named for what the
 * user wants (prompt, interrupt, restart), and only this one was named for
 * the signal the daemon happens to send. `SIGTERM session foo?` asked the
 * user to know Unix to end an agent. The command id, the client method and
 * the daemon's `killed` status keep the old vocabulary: that's the wire, and
 * it isn't what's on screen.
 */
async function killSessionCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(arg, store, "Select a session to stop")
  if (!session) return
  const label = describeSession(session)

  if (confirmStopSetting()) {
    const choice = await vscode.window.showWarningMessage(
      `Stop session ${label}?`,
      { modal: true, detail: "The agent is terminated. Its transcript stays readable, and Restart can revive it." },
      STOP_BUTTON,
      STOP_AND_SILENCE_BUTTON,
    )
    const decision = interpretStopChoice(choice)
    if (!decision.stop) return
    if (decision.silence) {
      await vscode.workspace
        .getConfiguration("agentproto")
        .update("confirmStop", false, vscode.ConfigurationTarget.Global)
    }
  }

  try {
    await client.kill(session.id)
    await store.refreshAll()
    await notifyStopped(session.id, label)
  } catch (err) {
    vscode.window.showErrorMessage(`agentproto: stop failed — ${describeError(err)}`)
  }
}

/**
 * Copy a session's daemon id (`sess_…`) to the clipboard. The row's secondary
 * line trades the id for isolation info (worktree/in-place), and the tooltip
 * shows it but can't be selected — so this is the affordance that hands the
 * full handle to a `curl`/`agentproto sessions` invocation. Accepts a tree
 * node, a descriptor, or a bare id, same as the other session commands; with
 * no arg it quick-picks over ALL sessions (id is as meaningful on a finished
 * session as a live one).
 */
async function copySessionIdCommand(store: SessionStore, arg: unknown): Promise<void> {
  const session = await resolveSessionArg(arg, store, "Select a session to copy its id", () => true)
  if (!session) return
  await vscode.env.clipboard.writeText(session.id)
  vscode.window.showInformationMessage(`agentproto: copied session id ${session.id}`)
}

/** Read fresh each stop — it's a setting the user can flip from the modal itself mid-session. */
function confirmStopSetting(): boolean {
  return vscode.workspace.getConfiguration("agentproto").get<boolean>("confirmStop", true)
}

/**
 * The confirm's job — "you might not have meant that" — moves downstream
 * once it's silenced: this toast is the safety net that's left, so it offers
 * Restart on every stop, confirmed or silent, rather than only the silent
 * path.
 */
async function notifyStopped(sessionId: string, label: string): Promise<void> {
  const action = await vscode.window.showInformationMessage(`agentproto: stopped ${label}`, "Restart")
  if (action === "Restart") {
    await vscode.commands.executeCommand("agentproto.restartSession", sessionId)
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
