/**
 * agentproto.switchHarness — restart a live session onto the opposite
 * harness. PTY terminal sessions resume into ACP/conversation when a
 * recoverable id exists; agent-cli sessions restart into a PTY when the
 * provider-native resume id is already known.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"
import { resolveSessionArg } from "./sessionActions.js"
import { describeSession } from "./sessionActions.logic.js"
import { parseRestartResult, describeRestart } from "./sessionRestart.logic.js"
import { planHarnessSwitch } from "./switchHarness.logic.js"

export function registerSwitchHarness(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
  getActiveTranscriptSessionId: () => string | undefined = () => undefined,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.switchHarness", async (arg: unknown) => {
      const session = await resolveSessionArg(
        arg ?? getActiveTranscriptSessionId(),
        store,
        "Select a session to switch harness",
        () => true,
        client,
      )
      if (!session) return

      const plan = planHarnessSwitch(session)
      if (plan.disabledReason) {
        vscode.window.showWarningMessage(`agentproto: ${plan.disabledReason}`)
        return
      }

      try {
        const raw = await client.mcpCall("session_restart", {
          idOrName: session.id,
          ...(plan.overrides ?? {}),
        })
        const restarted = parseRestartResult(raw)
        if (!restarted) {
          vscode.window.showErrorMessage(
            `agentproto: switch of ${describeSession(session)} returned an unrecognised result.`,
          )
          return
        }
        await store.refreshAll()
        vscode.window.showInformationMessage(describeRestart(session, restarted))
        await vscode.commands.executeCommand(
          plan.target === "terminal" ? "agentproto.openTerminal" : "agentproto.openTranscript",
          restarted.id,
        )
      } catch (err) {
        vscode.window.showErrorMessage(
          `agentproto: switch of ${describeSession(session)} failed — ${describeError(err)}`,
        )
      }
    }),
  )
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

