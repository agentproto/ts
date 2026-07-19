/**
 * agentproto.importConversation — adopt a Claude-native jsonl transcript into
 * the live sessions tree by spawning a PTY session that resumes the chosen
 * conversation id (`claude --resume <id>`).
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import { EMPTY_WORKSPACES } from "../services/workspaces.logic.js"
import { listClaudeConversationCandidates } from "../../../runtime/src/claude-conversation-import.js"
import { resolveWorkspaceSlug } from "./spawn.logic.js"

interface ImportPick {
  label: string
  description?: string
  detail?: string
  candidateIndex: number
}

export function registerImportConversationCommand(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.importConversation", () =>
      importConversation(client, store),
    ),
  )
}

async function importConversation(client: DaemonClient, store: SessionStore): Promise<void> {
  let candidates
  try {
    candidates = await listClaudeConversationCandidates()
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: could not scan Claude conversations — ${describeError(err)}`,
    )
    return
  }

  if (candidates.length === 0) {
    vscode.window.showWarningMessage("agentproto: no Claude conversations found under ~/.claude/projects.")
    return
  }

  const pick = await vscode.window.showQuickPick(
    candidates.map((candidate, index): ImportPick => ({
      label: candidate.preview ?? candidate.conversationId,
      description: [candidate.conversationId, candidate.cwd ?? "cwd missing"].join(" · "),
      detail: [candidate.firstContentAt ?? "unknown time", candidate.filePath].join(" · "),
      candidateIndex: index,
    })),
    {
      placeHolder: "Select a Claude conversation to import",
    },
  )
  if (!pick) return

  const candidate = candidates[pick.candidateIndex]
  if (!candidate) return

  let cwd = candidate.cwd
  if (!cwd) {
    const typed = await vscode.window.showInputBox({
      prompt: "This transcript has no cwd on any content line. Enter the launch directory.",
      placeHolder: "/absolute/path/to/workspace",
    })
    if (typed === undefined) return
    if (!typed) {
      vscode.window.showWarningMessage("agentproto: import cancelled — a cwd is required for this transcript.")
      return
    }
    cwd = typed
  }

  let workspaceSlug: string | undefined
  try {
    const workspaces = await client.listWorkspaces()
    workspaceSlug = resolveWorkspaceSlug(workspaces ?? EMPTY_WORKSPACES, cwd)
  } catch {
    workspaceSlug = undefined
  }

  try {
    const session = await client.spawnTerminal({
      argv: ["claude", "--resume", candidate.conversationId],
      cwd,
      ...(workspaceSlug ? { workspaceSlug } : {}),
      label: candidate.preview ?? candidate.conversationId,
    })
    await store.refreshAll()
    void vscode.window.showInformationMessage(
      `agentproto: imported ${candidate.conversationId} as ${session.label ?? session.id}`,
      "Open transcript",
    ).then(choice => {
      if (choice === "Open transcript") {
        void vscode.commands.executeCommand("agentproto.openTranscript", session.id)
      }
    })
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: import of ${candidate.conversationId} failed — ${describeError(err)}`,
    )
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
