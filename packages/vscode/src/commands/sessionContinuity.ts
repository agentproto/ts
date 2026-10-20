/**
 * VS Code commands for context continuity: Compact and Continue fresh.
 *
 * These are narrow, explicit actions surfaced on the sessions panel context
 * menu. They call the daemon's MCP tools and report outcomes via the standard
 * VS Code message API.
 */

import * as vscode from "vscode"
import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import { previousContinuationSession } from "../views/sessionContinuation.logic.js"
import type { SessionStore } from "../services/sessionStore.js"
import { resolveSessionArg } from "./sessionActions.js"

export function registerSessionContinuityCommands(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
  getActiveTranscriptSessionId: () => string | undefined = () => undefined,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.compactSession", (arg: unknown) =>
      compactSessionCommand(client, store, arg ?? getActiveTranscriptSessionId()),
    ),
    vscode.commands.registerCommand("agentproto.continueSessionFresh", (arg: unknown) =>
      continueSessionFreshCommand(client, store, arg ?? getActiveTranscriptSessionId()),
    ),
    vscode.commands.registerCommand("agentproto.openContinuationPrevious", (arg: unknown) =>
      openContinuationPreviousCommand(store, arg ?? getActiveTranscriptSessionId()),
    ),
  )
}

async function compactSessionCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(
    arg,
    store,
    "Select a session to compact",
    () => true,
    client,
  )
  if (!session) return
  try {
    const result = await client.mcpCall<{
      sessionId: string
      compactRequested: boolean
      note?: string
    }>("session_compact", { idOrName: session.id })
    vscode.window.showInformationMessage(
      `Compact requested for ${result.sessionId}. ${result.note ?? ""}`,
    )
  } catch (err) {
    vscode.window.showErrorMessage(
      `Compact failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function continueSessionFreshCommand(
  client: DaemonClient,
  store: SessionStore,
  arg: unknown,
): Promise<void> {
  const session = await resolveSessionArg(
    arg,
    store,
    "Select a session to continue fresh",
    () => true,
    client,
  )
  if (!session) return
  try {
    const result = await client.mcpCall<{
      continuedFrom: string
      continuedTo: string
      checkpointId: string
      checkpointPath: string
    }>("session_continue_fresh", { idOrName: session.id })
    vscode.window.showInformationMessage(
      `Continued fresh: ${result.continuedFrom} → ${result.continuedTo} (checkpoint ${result.checkpointId})`,
    )
  } catch (err) {
    vscode.window.showErrorMessage(
      `Continue fresh failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Open the session this one was continued from (follow `continuedFrom`).
 *  The tree passes a `↻` row's arg; the transcript panel passes the active
 *  session id. Resolves against the store first, then routes through
 *  `agentproto.openSession` so terminal/browser/transcript routing stays
 *  identical to clicking a regular row. */
async function openContinuationPreviousCommand(store: SessionStore, arg: unknown): Promise<void> {
  const session = await resolveSessionArg(
    arg,
    store,
    "Select a session to open the previous one for",
    () => true,
  )
  if (!session) return
  if (!session.continuedFrom) {
    vscode.window.showInformationMessage(
      `${session.label ?? session.title ?? session.id} is not a continuation of another session.`,
    )
    return
  }
  const previous = previousContinuationSession(session, id =>
    store.sessions.find(s => s.id === id),
  )
  if (!previous) {
    vscode.window.showInformationMessage(
      `Previous session ${session.continuedFrom} is not in the session list (forgotten or archived-hidden).`,
    )
    return
  }
  await vscode.commands.executeCommand("agentproto.openSession", previous)
}

/** Type guard used by tree/webview renderers that want to know whether a
 *  context-continuity action is available for a session row. */
export function sessionSupportsContinuityActions(
  desc: SessionDescriptor,
): { compact: boolean; continueFresh: boolean } {
  const live =
    desc.kind === "agent-cli" &&
    (desc.status === "running" || desc.status === "starting")
  return {
    compact: live,
    continueFresh: live,
  }
}
