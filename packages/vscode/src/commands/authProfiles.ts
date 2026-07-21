/**
 * Auth profile commands: refresh the auth profiles tree and drive the
 * multi-step "create auth profile" flow (QuickPick + InputBox), calling the
 * daemon's `auth_profile_create` verb. All decisions live in the pure
 * `authProfileFlow.logic.ts`; this file is the vscode shell.
 *
 * The credential is captured with a password-style InputBox and passed
 * straight to the daemon — it is never logged, echoed, or persisted here.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { AuthMethod } from "../client/types.js"
import type { AuthProfileNode } from "../views/authProfilesTree.logic.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"
import {
  buildCreateRequest,
  endpointChoices,
  methodChoices,
  successMessage,
  suggestProfileId,
  validateCredential,
  validateEndpoint,
  validateProfileId,
  SUBSCRIPTION_ENDPOINT,
} from "./authProfileFlow.logic.js"
import {
  credentialSourceChoices,
  loginCommandFor,
} from "./authProfileConnect.logic.js"

export function registerAuthProfileCommands(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.refreshAuthProfiles", () => {
      void provider.refresh()
    }),
    vscode.commands.registerCommand("agentproto.configureAuthProfile", (_node?: AuthProfileNode) => {
      void runCreateAuthProfileFlow(client, provider)
    }),
  )
}

/**
 * The create flow: method → endpoint → id → label → credential → create.
 * Returns early (silently) whenever the user dismisses a step. On success it
 * shows a fingerprint-only confirmation and refreshes the tree.
 */
export async function runCreateAuthProfileFlow(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): Promise<void> {
  // Step 1 — method.
  const methodPick = await vscode.window.showQuickPick(
    methodChoices().map(c => ({
      label: c.label,
      description: c.description,
      detail: c.detail,
      method: c.method,
    })),
    { title: "Add auth profile (1/5): method", placeHolder: "How does this profile authenticate?" },
  )
  if (!methodPick) return
  const method: AuthMethod = methodPick.method

  // Step 2 — endpoint. A subscription is always `anthropic`, so skip the
  // picker; an api-key offers the provider presets + a custom escape hatch.
  let endpoint: string
  if (method === "oauth-bearer") {
    endpoint = SUBSCRIPTION_ENDPOINT
  } else {
    const presets = await client.listProviderPresets().catch(() => [])
    const endpointPick = await vscode.window.showQuickPick(
      endpointChoices(method, presets).map(c => ({
        label: c.label,
        ...(c.description ? { description: c.description } : {}),
        endpoint: c.endpoint,
        custom: c.custom,
      })),
      { title: "Add auth profile (2/5): endpoint", placeHolder: "Which billing endpoint?" },
    )
    if (!endpointPick) return
    if (endpointPick.custom) {
      const custom = await vscode.window.showInputBox({
        title: "Add auth profile (2/5): custom endpoint",
        placeHolder: "e.g. requesty",
        validateInput: validateEndpoint,
      })
      if (!custom) return
      endpoint = custom.trim()
    } else {
      endpoint = endpointPick.endpoint ?? ""
    }
  }

  // Step 3 — id. Pre-fill a convention-matching suggestion; validate against
  // the existing profiles so a collision is caught before the round-trip.
  const existing = await client.listAuthProfiles().catch(() => [])
  const existingIds = existing.map(p => p.id)
  const id = await vscode.window.showInputBox({
    title: "Add auth profile (3/5): id",
    prompt: "A stable, unique id for this profile",
    value: suggestProfileId(method, endpoint),
    validateInput: v => validateProfileId(v, existingIds),
  })
  if (!id) return

  // Step 4 — label (optional).
  const label = await vscode.window.showInputBox({
    title: "Add auth profile (4/5): label (optional)",
    prompt: "A human-readable name (optional — press Enter to skip)",
    placeHolder: method === "oauth-bearer" ? "e.g. Anthropic Subscription" : "e.g. OpenRouter API Key",
  })
  if (label === undefined) return

  // Step 5 — credential. For a subscription endpoint with a first-class
  // login (`claude setup-token`), offer to run it and capture the token it
  // prints rather than forcing a hand-found token; everything else pastes.
  let credentialPrompt =
    method === "oauth-bearer" ? "Paste the subscription bearer token" : "Paste the API key"
  const login = loginCommandFor(endpoint, method)
  if (login) {
    const sourcePick = await vscode.window.showQuickPick(
      credentialSourceChoices(login).map(c => ({
        label: c.label,
        description: c.description,
        detail: c.detail,
        source: c.source,
      })),
      {
        title: "Add auth profile (5/5): credential",
        placeHolder: "How do you want to supply the token?",
      },
    )
    if (!sourcePick) return
    if (sourcePick.source === "login") {
      const terminal = vscode.window.createTerminal({ name: "agentproto: log in" })
      terminal.show(true)
      terminal.sendText(login.commandLine)
      credentialPrompt = login.instruction
    }
  }

  const credential = await vscode.window.showInputBox({
    title: "Add auth profile (5/5): credential",
    prompt: credentialPrompt,
    password: true,
    ignoreFocusOut: true,
    validateInput: validateCredential,
  })
  if (!credential) return

  const request = buildCreateRequest({ id, endpoint, method, credential, label })

  try {
    const created = await client.createAuthProfile(request)
    void vscode.window.showInformationMessage(successMessage(created))
    await provider.refresh()
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not create auth profile: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
