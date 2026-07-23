/**
 * The first-run / re-runnable ONBOARDING wizard (WS6) — the vscode shell around
 * `onboarding.logic.ts`. Registered as `agentproto.runOnboarding`, so it's both
 * the activation first-run entry point and a command the user can re-invoke any
 * time to wire up credentials they've since added.
 *
 * Flow: scan (`auth_discover_credentials`) → show found-but-not-imported
 * credentials for one-click import (`auth_profile_import`, which stamps
 * `origin`) → offer the existing "use my existing local login" and "paste a
 * key" flows as fallbacks. No secret is handled here — import is by reference,
 * daemon-side.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"
import {
  buildImportRequest,
  importSuccessMessage,
  planOnboarding,
  type ImportableCredential,
} from "./onboarding.logic.js"
import { runCreateAuthProfileFlow } from "./authProfiles.js"
import { pickAndConnectLocalLogin } from "./localLogin.js"

export function registerOnboardingCommand(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.runOnboarding", () => {
      void runOnboarding(client, provider)
    }),
  )
}

/** One QuickPick row per importable credential. */
interface ImportPickItem extends vscode.QuickPickItem {
  cred: ImportableCredential
}

/**
 * Drive the onboarding wizard. Silently returns on any dismissal. Every daemon
 * call is guarded so a single failure surfaces a message rather than aborting
 * the whole wizard.
 */
export async function runOnboarding(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): Promise<void> {
  const [discovered, profiles] = await Promise.all([
    client.discoverCredentials().catch(() => []),
    client.listAuthProfiles().catch(() => []),
  ])
  const plan = planOnboarding(discovered, profiles)

  if (plan.detectedClaudeCodeLogin) {
    void vscode.window.showInformationMessage(
      "Detected your local Claude Code login — you can import it below to bill your subscription.",
    )
  }

  // Step 1 — import found-but-not-imported credentials (multi-select).
  if (plan.hasImportable) {
    const picks = await vscode.window.showQuickPick<ImportPickItem>(
      plan.importable.map(cred => ({
        label:
          cred.method === "oauth-bearer"
            ? `$(sign-in) ${cred.endpoint} — ${cred.origin}`
            : `$(key) ${cred.endpoint} — ${cred.origin}`,
        description: cred.method,
        detail: cred.hint,
        picked: true,
        cred,
      })),
      {
        title: "Onboarding: import discovered credentials",
        placeHolder: "Select the credentials to import as auth profiles",
        canPickMany: true,
      },
    )
    if (picks && picks.length > 0) {
      for (const pick of picks) {
        try {
          const created = await client.importCredential(buildImportRequest(pick.cred))
          void vscode.window.showInformationMessage(importSuccessMessage(created))
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Could not import ${pick.cred.endpoint} (${pick.cred.origin}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
      await provider.refresh()
    }
  } else {
    void vscode.window.showInformationMessage(
      "No new local credentials to import — every discovered credential is already wired to a profile.",
    )
  }

  // Step 2 — offer the follow-up affordances: adopt a local login, or paste an
  // additional key. These reuse the existing flows verbatim.
  const next = await vscode.window.showQuickPick(
    [
      {
        label: "$(sign-in) Use my existing local login…",
        detail: "Adopt a CLI login (Claude Code / Codex / Gemini) as a self-refreshing profile.",
        action: "local" as const,
      },
      {
        label: "$(key) Paste an additional API key…",
        detail: "Add a gateway or vendor key by hand.",
        action: "paste" as const,
      },
      { label: "$(check) Done", action: "done" as const },
    ],
    {
      title: "Onboarding: anything else?",
      placeHolder: "Add another credential, or finish",
    },
  )
  if (!next || next.action === "done") return
  if (next.action === "local") {
    await pickAndConnectLocalLogin(client, provider)
  } else {
    await runCreateAuthProfileFlow(client, provider)
  }
}
