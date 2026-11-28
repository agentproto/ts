/**
 * Spawn-time check of a Codex profile's own login.
 *
 * A `source: "codex"` profile may carry a `codexHome` (the directory holding
 * its `auth.json`) and a `workspace` pin (the login's `tokens.account_id`).
 * Both are verified here, fail-loud, BEFORE a spawn commits to the profile: a
 * missing login or a login bound to another workspace would otherwise bill the
 * wrong subscription. Reads the login file only to check it; nothing is
 * returned but a path.
 */

import { readFile } from "node:fs/promises"
import { readRecipeLoginJson } from "@agentproto/secrets/provision/recipe"
import {
  checkCodexWorkspacePin,
  codexAuthFilePath,
  readCodexLogin,
  resolveCodexHome,
  type AuthProfile,
  type CodexLoginInfo,
} from "@agentproto/auth"
import { SubscriptionSourceError } from "./spawn-defaults.js"

export type CodexProfileLogin =
  /** The profile declares nothing: the caller keeps its default login check. */
  | { handled: false }
  /** Verified. `loginHome` is set only when the profile carries a `codexHome`. */
  | { handled: true; loginHome?: string }

export async function resolveCodexProfileLogin(
  profile: AuthProfile,
  deps: {
    readLogin?: (codexHome: string) => Promise<CodexLoginInfo | undefined>
    env?: Record<string, string | undefined>
    home?: string
  } = {},
): Promise<CodexProfileLogin> {
  if (profile.source !== "codex") return { handled: false }
  if (profile.codexHome === undefined && profile.subaccount === undefined) return { handled: false }

  let home: string
  try {
    home = resolveCodexHome(profile.codexHome, {
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.home ? { home: deps.home } : {}),
    })
  } catch (err) {
    throw new SubscriptionSourceError(
      "auth_source_unresolved",
      `profile "${profile.id}": ${err instanceof Error ? err.message : String(err)}.`,
    )
  }
  const login = await (deps.readLogin ?? readCodexLogin)(home)
  if (!login) {
    throw new SubscriptionSourceError(
      "auth_source_unresolved",
      `no Codex login for profile "${profile.id}" in ${home} — run \`CODEX_HOME=${home} codex login\` ` +
        `and sign in with the ChatGPT account (workspace) this profile is for.`,
      { command: `CODEX_HOME=${home} codex login`, source: "codex", reason: "missing" },
    )
  }
  if (profile.subaccount !== undefined) {
    const verdict = checkCodexWorkspacePin(login, profile.subaccount)
    if (!verdict.ok) {
      throw new SubscriptionSourceError("auth_source_unresolved", `profile "${profile.id}": ${verdict.message}`)
    }
  }
  return profile.codexHome !== undefined ? { handled: true, loginHome: home } : { handled: true }
}

/**
 * The host's raw login JSON for the box-login bridge: the recipe's default
 * file, or `<hostLoginHome>/auth.json` for a profile with its own home.
 */
export function readHostLoginJson(
  decl: { recipe: string; methodId?: string },
  hostLoginHome?: string,
): Promise<string> {
  return hostLoginHome !== undefined
    ? readFile(codexAuthFilePath(hostLoginHome), "utf8")
    : readRecipeLoginJson(decl.recipe, decl.methodId)
}
