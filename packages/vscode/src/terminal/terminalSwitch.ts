/**
 * agentproto.openTerminal — the conversation ↔ terminal switch (WP5). Opens
 * a REAL VS Code terminal (`Pseudoterminal`, not xterm-in-a-webview)
 * mirroring one session: a live PTY mirror for `pty:true` sessions, or the
 * agent's pre-colored streamed output for agent-cli sessions (which have no
 * PTY anywhere — see terminalSwitch.logic.ts's `notPtyMessage`). One
 * terminal per session id; re-invoking reveals the existing one rather than
 * opening a duplicate. The tree's single-click still opens the CONVERSATION
 * webview (agentproto.openTranscript, unchanged) — this command is reached
 * from the tree's inline context menu and the transcript panel's editor
 * title bar instead, so it reads as a switch between two views of one
 * session rather than a second, unrelated feature.
 */

import * as vscode from "vscode"

import { resolveSessionArg } from "../commands/sessionActions.js"
import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import { createAgentMirrorPty } from "./agentMirror.js"
import { createPtyMirrorPty } from "./ptyMirror.js"
import { pickTransport, terminalDisplayName } from "./terminalSwitch.logic.js"

export interface TerminalSwitch {
  open(session: SessionDescriptor): void
  moveLocation(): Promise<void>
}

export function registerTerminalSwitch(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
  /**
   * Session id of the currently focused transcript panel, if any
   * (`TranscriptPanels.activeSessionId`). A plain `editor/title` menu
   * command is invoked with NO argument, so this is what lets that entry
   * point target "this" session instead of falling straight to a quick-pick.
   */
  getActiveTranscriptSessionId: () => string | undefined = () => undefined,
): TerminalSwitch {
  const terminals = new Map<string, vscode.Terminal>()
  /** Tracked location of each agentproto terminal we created. Default is editor (WP1). */
  const locations = new Map<string, "editor" | "panel">()

  function updateTerminalContext(): void {
    const active = vscode.window.activeTerminal
    const isOurs = active ? [...terminals.values()].some(term => term === active) : false
    void vscode.commands.executeCommand("setContext", "agentproto.terminalFocused", isOurs)
  }

  ctx.subscriptions.push(
    vscode.window.onDidCloseTerminal(closed => {
      for (const [id, term] of terminals) {
        if (term === closed) {
          terminals.delete(id)
          locations.delete(id)
          updateTerminalContext()
          return
        }
      }
    }),
    vscode.window.onDidChangeActiveTerminal(() => updateTerminalContext()),
  )

  const terminalSwitch: TerminalSwitch = {
    open(session: SessionDescriptor): void {
      const existing = terminals.get(session.id)
      if (existing) {
        existing.show()
        return
      }
      const pty =
        pickTransport(session) === "pty"
          ? createPtyMirrorPty(client, session)
          : createAgentMirrorPty(client, store, session)
      const terminal = vscode.window.createTerminal({
        name: terminalDisplayName(session),
        pty,
        location: { viewColumn: vscode.ViewColumn.Beside },
      })
      terminals.set(session.id, terminal)
      locations.set(session.id, "editor")
      terminal.show()
    },

    async moveLocation(): Promise<void> {
      const active = vscode.window.activeTerminal
      if (!active) {
        void vscode.window.showInformationMessage("agentproto: no active terminal to move.")
        return
      }
      let sessionId: string | undefined
      for (const [id, term] of terminals) {
        if (term === active) {
          sessionId = id
          break
        }
      }
      if (!sessionId) {
        void vscode.window.showInformationMessage(
          "agentproto: the active terminal is not an agentproto terminal.",
        )
        return
      }
      const current = locations.get(sessionId) ?? "editor"
      if (current === "editor") {
        await vscode.commands.executeCommand("workbench.action.terminal.moveToPanel")
        locations.set(sessionId, "panel")
      } else {
        await vscode.commands.executeCommand("workbench.action.terminal.moveToEditor")
        locations.set(sessionId, "editor")
      }
    },
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.openTerminal", async (arg: unknown) => {
      const session = await resolveSessionArg(
        arg ?? getActiveTranscriptSessionId(),
        store,
        "Select a session to open its terminal",
        () => true,
        client,
      )
      if (session) terminalSwitch.open(session)
    }),
    vscode.commands.registerCommand("agentproto.moveTerminalLocation", () => terminalSwitch.moveLocation()),
  )

  return terminalSwitch
}
