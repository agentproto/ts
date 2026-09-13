/**
 * agentproto.searchTranscripts — InputBox → federated GET /brain/query →
 * QuickPick of hits → open the picked session's transcript. Additive,
 * separate flow: does NOT touch the sessions tree's SessionFilterState
 * (sessionFilter.logic.ts) — this is a one-shot search over ALL session
 * transcripts (every workspace brain), not a tree filter.
 *
 * Picking a hit reuses the exact "open transcript by bare sessionId"
 * mechanism every other command already uses:
 * `vscode.commands.executeCommand("agentproto.openTranscript", sessionId)`
 * (see importConversation.ts, sessionRestart.ts, spawn.ts, …).
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { WorkspacePinStore } from "../services/workspacePin.js"
import { hitsToQuickPickItems, type SearchTranscriptsPick } from "./searchTranscripts.logic.js"

export function registerSearchTranscriptsCommand(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  workspacePin?: WorkspacePinStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.searchTranscripts", () =>
      searchTranscripts(client, workspacePin),
    ),
  )
}

async function searchTranscripts(
  client: DaemonClient,
  workspacePin?: WorkspacePinStore,
): Promise<void> {
  const q = await vscode.window.showInputBox({
    prompt: "Search all session transcripts…",
    placeHolder: "Search all session transcripts…",
  })
  if (!q) return

  let result: Awaited<ReturnType<DaemonClient["searchTranscripts"]>>
  try {
    result = await client.searchTranscripts(q)
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: brain search failed — ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }

  if (result.hits.length === 0) {
    vscode.window.showInformationMessage(`agentproto: no transcript hits for "${q}".`)
    return
  }

  const callerWorkspace = workspacePin?.get()
  const items: (SearchTranscriptsPick & vscode.QuickPickItem)[] = hitsToQuickPickItems(
    result.hits,
    callerWorkspace,
  )

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `${result.hits.length} transcript hit(s) for "${q}"`,
    matchOnDescription: true,
    matchOnDetail: true,
  })
  if (!pick) return

  const hit = result.hits[pick.hitIndex]
  if (!hit) return

  const target = hit.sessionId ?? hit.sourceId
  void vscode.commands.executeCommand("agentproto.openTranscript", target)
}
