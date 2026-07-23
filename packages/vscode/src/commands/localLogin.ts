/**
 * "Use my existing local login" — the vscode shell that turns a
 * {@link LocalLoginRecipe} into a source-backed auth profile, plus the
 * activation-time auto-adopt policy (`agentproto.autoAdoptLocalLogin`).
 *
 * A source-backed profile stores NO secret: the daemon resolves the bearer
 * fresh from the local CLI login on every spawn. So this file never reads,
 * prompts for, or handles a credential — detection only probes whether a login
 * EXISTS, never its value, and deliberately ignores ambient env keys (e.g.
 * ANTHROPIC_API_KEY), matching the daemon's own guard against them.
 *
 * All decisions live in the pure `authProfileFlow.logic.ts`; this is the I/O.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { AuthProfilesTreeProvider } from "../views/authProfilesTree.js"
import {
  autoAdoptDecision,
  buildLocalLoginRequest,
  successMessage,
  LOCAL_LOGIN_RECIPES,
  type AutoAdoptMode,
  type LocalLoginRecipe,
} from "./authProfileFlow.logic.js"

/** The Claude Code recipe — the first-class, spawnable local login and the
 *  only one the auto-adopt policy considers. */
const CLAUDE_CODE_RECIPE = LOCAL_LOGIN_RECIPES.find(r => r.source === "claude-code-oauth")!

/** globalState key: whether we've already run the one-time auto-adopt pass, so
 *  "ask" prompts once rather than on every activation. */
const AUTO_ADOPT_DONE_KEY = "agentproto.autoAdoptLocalLogin.done"

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p
}

/** Does the macOS login keychain hold a generic-password item for `service`?
 *  Uses `security find-generic-password` WITHOUT `-w`, so it reads only the
 *  item's presence (attributes), never the stored secret, and never prompts. */
function keychainItemExists(service: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile("security", ["find-generic-password", "-s", service], err => resolve(!err))
  })
}

/**
 * Best-effort probe for whether a local login for `recipe` exists on this
 * host, WITHOUT reading the secret: the credential file's presence, or — for a
 * CLI that keeps its token in the macOS keychain (Claude Code) — the keychain
 * item's presence. A false negative just means we don't auto-offer; the user
 * can still connect manually.
 */
export async function detectLocalLogin(recipe: LocalLoginRecipe): Promise<boolean> {
  if (existsSync(expandHome(recipe.credentialFile))) return true
  if (recipe.keychainService && process.platform === "darwin") {
    return keychainItemExists(recipe.keychainService)
  }
  return false
}

/**
 * Create the source-backed profile for `recipe` (no credential prompt) and
 * report the outcome. Mirrors `runConnectPresetFlow`'s success/error handling.
 */
export async function runConnectLocalLoginFlow(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
  recipe: LocalLoginRecipe,
): Promise<void> {
  const existing = await client.listAuthProfiles().catch(() => [])
  if (existing.some(p => p.id === recipe.id)) {
    void vscode.window.showInformationMessage(
      `Auth profile "${recipe.id}" is already connected.`,
    )
    return
  }
  try {
    const created = await client.createAuthProfile(buildLocalLoginRequest(recipe))
    void vscode.window.showInformationMessage(successMessage(created))
    await provider.refresh()
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not connect ${recipe.label}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Drive a QuickPick of the local logins, then connect the chosen one. This is
 *  the `agentproto.connectLocalLogin` command handler and the webview button
 *  target. */
export async function pickAndConnectLocalLogin(
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    LOCAL_LOGIN_RECIPES.map(r => ({
      label: r.pickLabel,
      detail: r.detail,
      recipe: r,
    })),
    {
      title: "Use my existing login",
      placeHolder: "Reuse a CLI you're already signed into — the token refreshes itself",
    },
  )
  if (!pick) return
  await runConnectLocalLoginFlow(client, provider, pick.recipe)
}

/**
 * Activation-time auto-adopt of a local Claude Code login, gated by
 * `agentproto.autoAdoptLocalLogin` ("auto" | "ask" | "off", default "ask").
 * Runs once per install (globalState flag) so "ask" never nags. In "auto" it
 * silently creates the source-backed profile when a login is present and no
 * anthropic profile exists; in "ask" it offers a one-time prompt. Adopting the
 * sole anthropic profile makes it the default wallet via the daemon's existing
 * single-eligible-profile precedence — no separate default-file write. Never
 * throws into activation.
 */
export async function maybeAutoAdoptLocalLogin(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  provider: AuthProfilesTreeProvider,
): Promise<void> {
  const mode = vscode.workspace
    .getConfiguration("agentproto")
    .get<AutoAdoptMode>("autoAdoptLocalLogin", "ask")
  if (mode === "off") return
  if (ctx.globalState.get<boolean>(AUTO_ADOPT_DONE_KEY)) return

  try {
    const [loginDetected, anthropicProfiles] = await Promise.all([
      detectLocalLogin(CLAUDE_CODE_RECIPE),
      client.listAuthProfiles("anthropic").catch(() => []),
    ])
    const decision = autoAdoptDecision(mode, {
      loginDetected,
      anthropicProfileExists: anthropicProfiles.length > 0,
    })
    if (decision === "skip") {
      // A login we could act on but chose not to (already have a wallet, or no
      // login yet) shouldn't burn the one-time flag — conditions may change.
      return
    }

    // From here we will either create or prompt exactly once — burn the flag so
    // "ask" can't re-nag on the next activation.
    await ctx.globalState.update(AUTO_ADOPT_DONE_KEY, true)

    if (decision === "prompt") {
      const choice = await vscode.window.showInformationMessage(
        "agentproto: a Claude Code login was found on this machine. Use it to bill agent " +
          "sessions? It refreshes automatically — no token to paste.",
        "Use my Claude Code login",
        "Not now",
      )
      if (choice !== "Use my Claude Code login") return
    }
    await runConnectLocalLoginFlow(client, provider, CLAUDE_CODE_RECIPE)
  } catch {
    // Auto-adopt is a convenience; never let it break activation.
  }
}
