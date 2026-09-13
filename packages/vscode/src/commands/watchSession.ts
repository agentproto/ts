/**
 * agentproto.watchSession / agentproto.unwatchSession — pin an eye on a
 * session so its slide into needs-you / stalled / parked-bg / failed / done
 * raises a toast instead of going unnoticed (see services/watchedSessions.ts).
 *
 * Both commands accept the tree-node arg every other session command takes
 * (normalizeSessionArg unwraps `{ session }`), a raw SessionDescriptor, or a
 * bare session-id string, falling back to a quick-pick of live sessions when
 * invoked from the command palette with no arg.
 */

import * as vscode from "vscode"

import type { SessionStore } from "../services/sessionStore.js"
import type { WatchedSessions } from "../services/watchedSessions.js"
import { describeSession, isLiveSession } from "./sessionActions.logic.js"
import { resolveSessionArg } from "./sessionActions.js"

export function registerWatchSessionCommands(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
  watched: WatchedSessions,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.watchSession", (arg: unknown) =>
      watchSessionCommand(store, watched, arg),
    ),
    vscode.commands.registerCommand("agentproto.unwatchSession", (arg: unknown) =>
      unwatchSessionCommand(store, watched, arg),
    ),
  )
}

async function watchSessionCommand(
  store: SessionStore,
  watched: WatchedSessions,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(arg, store, "Select a session to watch", isLiveSession)
  if (!session) return
  if (watched.isWatched(session.id)) {
    vscode.window.setStatusBarMessage(
      `agentproto: ${describeSession(session)} is already watched`,
      3000,
    )
    return
  }
  watched.toggle(session.id)
  vscode.window.setStatusBarMessage(`agentproto: watching ${describeSession(session)} 👁`, 3000)
}

async function unwatchSessionCommand(
  store: SessionStore,
  watched: WatchedSessions,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(arg, store, "Select a session to unwatch", isLiveSession)
  if (!session) return
  if (!watched.isWatched(session.id)) {
    vscode.window.setStatusBarMessage(
      `agentproto: ${describeSession(session)} is not watched`,
      3000,
    )
    return
  }
  watched.toggle(session.id)
  vscode.window.setStatusBarMessage(`agentproto: stopped watching ${describeSession(session)}`, 3000)
}
