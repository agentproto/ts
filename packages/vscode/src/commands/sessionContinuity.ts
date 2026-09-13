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
