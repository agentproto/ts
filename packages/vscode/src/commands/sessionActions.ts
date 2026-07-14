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

/** Resolve a command arg to a SessionDescriptor: direct arg, else quick-pick (default: live sessions only). */
export async function resolveSessionArg(
  arg: unknown,
  store: SessionStore,
  placeHolder: string,
  filter: (session: SessionDescriptor) => boolean = isLiveSession,
): Promise<SessionDescriptor | undefined> {
  const direct = normalizeSessionArg(arg)
  if (direct) return direct
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

async function killSessionCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(arg, store, "Select a session to kill")
  if (!session) return
  const label = describeSession(session)
  const confirm = await vscode.window.showWarningMessage(`SIGTERM session ${label}?`, { modal: true }, "Kill")
  if (confirm !== "Kill") return
  try {
    await client.kill(session.id)
    vscode.window.showInformationMessage(`agentproto: killed ${label}`)
    await store.refreshAll()
  } catch (err) {
    vscode.window.showErrorMessage(`agentproto: kill failed — ${describeError(err)}`)
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
