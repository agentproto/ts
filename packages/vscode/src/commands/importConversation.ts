/**
 * agentproto.importConversation — adopt an EXTERNAL native conversation into the
 * live sessions tree by spawning a PTY that reattaches to it. Works for any
 * harness whose store declares a native reattach argv — today claude-code
 * (`claude --resume`) and hermes (`hermes --resume --tui`); read/export-only
 * harnesses (codex/opencode/…) can't be reattached and don't appear here.
 *
 * Discovery + tagging live in the runtime's `listImportCandidates` (universal
 * across `CONVERSATION_STORES`); this file is the vscode shell.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import { EMPTY_WORKSPACES } from "../services/workspaces.logic.js"
import {
  listImportCandidates,
  type ImportCandidate,
} from "../../../runtime/src/conversation-import.js"
import { resolveWorkspaceSlug } from "./spawn.logic.js"

interface ImportPick extends vscode.QuickPickItem {
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
  // The daemon's registered workspaces are the search space for cwd-scoped
  // stores (hermes); claude-code ignores them and scans globally.
  const workspaces = await client.listWorkspaces().catch(() => EMPTY_WORKSPACES)
  const cwds = (workspaces?.workspaces ?? []).map(w => w.path)

  let candidates: ImportCandidate[]
  try {
    candidates = await listImportCandidates({ cwds })
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: could not scan conversations — ${describeError(err)}`,
    )
    return
  }

  if (candidates.length === 0) {
    vscode.window.showWarningMessage(
      "agentproto: no importable conversations found (Claude Code / Hermes).",
    )
    return
  }

  const pick = await vscode.window.showQuickPick(
    candidates.map((candidate, index): ImportPick => ({
      label: candidate.preview ?? candidate.conversationId,
      description: [candidate.harnessLabel, candidate.conversationId, candidate.cwd ?? "cwd missing"].join(" · "),
      detail: [candidate.startedAt ?? candidate.lastActivityAt ?? "unknown time", candidate.filePath ?? ""]
        .filter(Boolean)
        .join(" · "),
      candidateIndex: index,
    })),
    {
      placeHolder: "Select a conversation to import (reattach as a live session)",
    },
  )
  if (!pick) return

  const candidate = candidates[pick.candidateIndex]
  if (!candidate) return

  let cwd = candidate.cwd
  if (!cwd) {
    const typed = await vscode.window.showInputBox({
      prompt: "This conversation has no recorded cwd. Enter the launch directory.",
      placeHolder: "/absolute/path/to/workspace",
    })
    if (typed === undefined) return
    if (!typed) {
      vscode.window.showWarningMessage("agentproto: import cancelled — a cwd is required for this conversation.")
      return
    }
    cwd = typed
  }

  const workspaceSlug = resolveWorkspaceSlug(workspaces ?? EMPTY_WORKSPACES, cwd)

  try {
    const session = await client.spawnTerminal({
      argv: candidate.attachArgv,
      cwd,
      ...(workspaceSlug ? { workspaceSlug } : {}),
      label: candidate.preview ?? candidate.conversationId,
    })
    await store.refreshAll()
    void vscode.window.showInformationMessage(
      `agentproto: imported ${candidate.harnessLabel} conversation ${candidate.conversationId} as ${session.label ?? session.id}`,
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
