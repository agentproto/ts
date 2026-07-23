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
import { pickAndConnectLocalLogin } from "./localLogin.js"
import {
  buildModelPickItems,
  resolveModelSelection,
  toggleModelInAllowlist,
} from "./authProfileModelPicker.logic.js"
import { profileCuratedIds } from "../views/authProfilesTree.logic.js"

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
    vscode.commands.registerCommand("agentproto.connectLocalLogin", () => {
      void pickAndConnectLocalLogin(client, provider)
    }),
    vscode.commands.registerCommand("agentproto.connectAuthProfile", (node?: AuthProfileNode) => {
      // Reached from an unconnected preset row (click or context menu). With a
      // preset in hand the method + endpoint are known, so skip straight to
      // id → label → credential. Without one (defensive), fall back to the
      // full wizard.
      if (node?.kind === "preset") {
        void runConnectPresetFlow(client, provider, node.preset)
      } else {
        void runCreateAuthProfileFlow(client, provider)
      }
    }),
    vscode.commands.registerCommand("agentproto.deleteAuthProfile", (node?: AuthProfileNode) => {
      if (node?.kind === "profile") void runDeleteAuthProfileFlow(client, provider, node.profileId)
    }),
    vscode.commands.registerCommand("agentproto.enableAuthProfile", (node?: AuthProfileNode) => {
      if (node?.kind === "profile") {
        void runSetAuthProfileEnabledFlow(client, provider, node.profileId, true)
      }
    }),
    vscode.commands.registerCommand("agentproto.disableAuthProfile", (node?: AuthProfileNode) => {
      if (node?.kind === "profile") {
        void runSetAuthProfileEnabledFlow(client, provider, node.profileId, false)
      }
    }),
    vscode.commands.registerCommand("agentproto.setAuthProfileModels", (node?: AuthProfileNode) => {
      if (node?.kind === "profile") void runSetAuthProfileModelsFlow(client, provider, node.profileId)
    }),
  )
}

/**
 * The "+" model picker (WS4 phase 2) — reachable from a profile row's inline
 * "+" / context menu and the webview's "+ Models" button. Fetches the profile's
 * FULL provider model list from the WS4 read tool, opens a multi-select
 * QuickPick pre-checked with the current allowlist, and writes the result via
 * WS3's `setAuthProfileModels`. 100% catalog-sourced — nothing hardcoded.
 */
export async function runSetAuthProfileModelsFlow(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
  profileId: string,
): Promise<void> {
  try {
    const profiles = await client.listAuthProfiles()
    const summary = profiles.find(p => p.id === profileId)
    if (!summary) {
      void vscode.window.showErrorMessage(`Auth profile "${profileId}" not found.`)
      return
    }

    const { models } = await client.getCatalogProviderModels(summary.endpoint)
    if (models.length === 0) {
      void vscode.window.showInformationMessage(
        `No catalog models found for provider "${summary.endpoint}" — nothing to curate.`,
      )
      return
    }

    const current = profileCuratedIds(summary)
    // The QuickPick's own type-to-filter over matchOnDescription/Detail is the
    // pagination here: even OpenRouter's thousands of rows stay usable because
    // the list is virtualized + filterable, and the current allowlist is sorted
    // to the top. We never render the rows anywhere else (no logging).
    const items = buildModelPickItems(models, current).map(i => ({
      label: i.label,
      ...(i.description ? { description: i.description } : {}),
      ...(i.detail ? { detail: i.detail } : {}),
      picked: i.picked,
      id: i.id,
    }))

    const picked = await vscode.window.showQuickPick(items, {
      title: `Allowed models for "${profileId}" (${summary.endpoint})`,
      placeHolder: `Type to filter ${models.length} model${
        models.length === 1 ? "" : "s"
      } · pick the ones this wallet may use (select none to allow all)`,
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
    })
    if (picked === undefined) return // dismissed — leave the allowlist untouched

    const write = resolveModelSelection(picked.map(p => p.id))
    await client.setAuthProfileModels(profileId, write.mode, write.ids)
    void vscode.window.showInformationMessage(
      write.mode === "all"
        ? `"${profileId}" now allows all eligible models.`
        : `"${profileId}" now allows ${write.ids.length} model${write.ids.length === 1 ? "" : "s"}.`,
    )
    await provider.refresh()
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not set allowed models for "${profileId}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/**
 * Toggle a single model id in a profile's allowlist (WS4) — the webview's
 * per-chip add/remove affordance. Reads the profile's current curation, flips
 * membership of `modelId`, and writes it back; emptying the allowlist reverts
 * to servicing everything (see `toggleModelInAllowlist`).
 */
export async function runToggleAuthProfileModelFlow(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
  profileId: string,
  modelId: string,
): Promise<void> {
  try {
    const profiles = await client.listAuthProfiles()
    const summary = profiles.find(p => p.id === profileId)
    if (!summary) {
      void vscode.window.showErrorMessage(`Auth profile "${profileId}" not found.`)
      return
    }
    const write = toggleModelInAllowlist(profileCuratedIds(summary), modelId)
    await client.setAuthProfileModels(profileId, write.mode, write.ids)
    await provider.refresh()
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not update allowed models for "${profileId}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/**
 * Enable or disable a whole auth profile (WS2) — reachable from a profile
 * row's context menu. A disabled profile's models drop to non-runnable
 * (distinct from the derived `runnable` flag). Metadata-only; the credential
 * is untouched.
 */
export async function runSetAuthProfileEnabledFlow(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
  profileId: string,
  enabled: boolean,
): Promise<void> {
  try {
    await client.setAuthProfileEnabled(profileId, enabled)
    void vscode.window.showInformationMessage(
      `${enabled ? "Enabled" : "Disabled"} auth profile "${profileId}".`,
    )
    await provider.refresh()
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not ${enabled ? "enable" : "disable"} "${profileId}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/**
 * Connect a provider preset: create an api-key profile already bound to the
 * preset's endpoint, so the user only supplies id/label/credential instead of
 * re-choosing the method and endpoint they just clicked. This is the direct
 * answer to "a preset with no profile connected is unclear" — the preset row
 * now leads straight to the credential.
 */
export async function runConnectPresetFlow(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
  preset: { slug: string; name?: string },
): Promise<void> {
  const method: AuthMethod = "api-key"
  const endpoint = preset.slug

  const existing = await client.listAuthProfiles().catch(() => [])
  const existingIds = existing.map(p => p.id)
  const id = await vscode.window.showInputBox({
    title: `Connect ${preset.name ?? preset.slug} (1/3): id`,
    prompt: "A stable, unique id for this profile",
    value: suggestProfileId(method, endpoint),
    validateInput: v => validateProfileId(v, existingIds),
  })
  if (!id) return

  const label = await vscode.window.showInputBox({
    title: `Connect ${preset.name ?? preset.slug} (2/3): label (optional)`,
    prompt: "A human-readable name (optional — press Enter to skip)",
    placeHolder: `e.g. ${preset.name ?? preset.slug} API Key`,
  })
  if (label === undefined) return

  const credential = await vscode.window.showInputBox({
    title: `Connect ${preset.name ?? preset.slug} (3/3): credential`,
    prompt: `Paste the ${preset.name ?? preset.slug} API key`,
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
      `Could not connect ${preset.slug}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Delete a named auth profile after a modal confirm — reachable from a
 *  profile row's context menu. */
export async function runDeleteAuthProfileFlow(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
  profileId: string,
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Delete auth profile "${profileId}"? Sessions billing it will need another wallet.`,
    { modal: true },
    "Delete",
  )
  if (confirm !== "Delete") return
  try {
    await client.deleteAuthProfile(profileId)
    void vscode.window.showInformationMessage(`Deleted auth profile "${profileId}".`)
    await provider.refresh()
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not delete "${profileId}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
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
  // Step 1 — method. Lead with the zero-friction "use my existing local login"
  // shortcut (source-backed, no token to paste); picking it diverts to that
  // flow and skips the rest of the wizard.
  const methodPick = await vscode.window.showQuickPick(
    [
      {
        label: "$(sign-in) Use my existing local login…",
        description: "no token to paste",
        detail: "Reuse your local Claude Code login — a self-refreshing subscription, nothing to paste.",
        localLogin: true as const,
      },
      ...methodChoices().map(c => ({
        label: c.label,
        description: c.description,
        detail: c.detail,
        method: c.method,
      })),
    ],
    { title: "Add auth profile (1/5): method", placeHolder: "How does this profile authenticate?" },
  )
  if (!methodPick) return
  if ("localLogin" in methodPick) {
    await pickAndConnectLocalLogin(client, provider)
    return
  }
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
