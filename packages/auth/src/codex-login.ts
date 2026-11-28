/**
 * Codex login helpers: where a profile's Codex login lives and what it says.
 *
 * Codex binds a ChatGPT login to ONE workspace: the workspace is the
 * `tokens.account_id` of `<CODEX_HOME>/auth.json` (sent as the
 * `chatgpt-account-id` header). The `forced_chatgpt_workspace_id` config key is
 * a guard, not a selector: codex logs out when the stored workspace is not in
 * the list. So one login per workspace means one Codex home per workspace, and
 * a profile points at its home with `codexHome` (see `AuthProfile.codexHome`).
 *
 * How the workspace is chosen (checked against the open-source codex tree,
 * `codex-rs/login`, on 2026-11-28; the installed binary is 0.170.0):
 *  - ESTABLISHED (read in the source): the workspace is carried by the stored
 *    login (`tokens.account_id`, the id token's `chatgpt_account_id`). The
 *    `forced_chatgpt_workspace_id` config key (with `forced_login_method`) is
 *    an allow-list: at start-up `enforce_login_restrictions` compares the
 *    stored workspace with it and LOGS OUT on a mismatch (it deletes
 *    `auth.json`), so it must not be used here as a per-spawn selector.
 *    A newer codex can also switch the stored workspace without a new login
 *    (a token exchange that rewrites `auth.json`); that mutates the shared
 *    login and is not a per-spawn choice either.
 *  - NOT VERIFIED (no login was run): that the id token's `organizations`
 *    `id` equals the account id. Titles are only displayed; a workspace pin
 *    matches `tokens.account_id`, which is also what the usage endpoint's
 *    `ChatGPT-Account-Id` header takes.
 * Hence one Codex home per workspace, chosen by `codexHome`.
 *
 * Nothing here returns a token to a caller that only describes a login:
 * {@link describeCodexLogin} drops it. {@link readCodexLogin} does carry the
 * access token (the quota reader needs it) and must not be logged.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import type { SubaccountPin } from "./profile-types.js"

/** The JWT claim namespace OpenAI uses for ChatGPT account data. */
const AUTH_CLAIM = "https://api.openai.com/auth"

export interface CodexWorkspaceInfo {
  title?: string
  role?: string
  isDefault?: boolean
}

export interface CodexLoginInfo {
  /** The ChatGPT access token. SECRET: never log or return over a wire. */
  accessToken: string
  /** The active workspace (`tokens.account_id`, else the id-token claim). */
  accountId?: string
  /** Workspaces the id-token lists (display only; titles, no ids). */
  workspaces: CodexWorkspaceInfo[]
}

/** Non-secret view of a login, safe to list or log. */
export interface CodexLoginDescription {
  accountId?: string
  workspaces: CodexWorkspaceInfo[]
}

/**
 * The Codex home for a profile: its `codexHome` (`~` expanded), else an
 * absolute `CODEX_HOME` from `env`, else `~/.codex`. Throws on a relative
 * path, which would depend on the daemon's working directory.
 */
export function resolveCodexHome(
  codexHome: string | undefined,
  opts: { home?: string; env?: Record<string, string | undefined> } = {},
): string {
  const home = opts.home ?? homedir()
  const env = opts.env ?? process.env
  if (codexHome === undefined || codexHome.trim() === "") {
    const fromEnv = env.CODEX_HOME
    return fromEnv && isAbsolute(fromEnv) ? fromEnv : resolve(home, ".codex")
  }
  const raw = codexHome.trim()
  if (raw === "~") return home
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2))
  if (!isAbsolute(raw)) {
    throw new Error(`codexHome must be an absolute path or start with "~/" (got "${raw}")`)
  }
  return resolve(raw)
}

export function codexAuthFilePath(codexHome: string): string {
  return join(codexHome, "auth.json")
}

function decodeJwtClaims(jwt: unknown): Record<string, unknown> | undefined {
  if (typeof jwt !== "string") return undefined
  const part = jwt.split(".")[1]
  if (!part) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Parse a raw `auth.json`. Defensive: undefined unless a non-empty
 *  `tokens.access_token` is present; a bad id token only empties `workspaces`. */
export function parseCodexLoginDocument(raw: string): CodexLoginInfo | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (doc === null || typeof doc !== "object") return undefined
  const tokens = (doc as Record<string, unknown>).tokens
  if (tokens === null || typeof tokens !== "object") return undefined
  const t = tokens as Record<string, unknown>
  if (typeof t.access_token !== "string" || t.access_token === "") return undefined

  const claim = decodeJwtClaims(t.id_token)?.[AUTH_CLAIM]
  const authClaim =
    claim !== null && typeof claim === "object" ? (claim as Record<string, unknown>) : undefined
  const workspaces: CodexWorkspaceInfo[] = []
  const orgs = authClaim?.organizations
  if (Array.isArray(orgs)) {
    for (const o of orgs) {
      if (o === null || typeof o !== "object") continue
      const org = o as Record<string, unknown>
      workspaces.push({
        ...(typeof org.title === "string" ? { title: org.title } : {}),
        ...(typeof org.role === "string" ? { role: org.role } : {}),
        ...(typeof org.is_default === "boolean" ? { isDefault: org.is_default } : {}),
      })
    }
  }
  const accountId =
    typeof t.account_id === "string" && t.account_id !== ""
      ? t.account_id
      : typeof authClaim?.chatgpt_account_id === "string"
        ? authClaim.chatgpt_account_id
        : undefined
  return { accessToken: t.access_token, ...(accountId !== undefined ? { accountId } : {}), workspaces }
}

/** Read `<codexHome>/auth.json`. Never throws; undefined when absent/unusable. */
export async function readCodexLogin(codexHome: string): Promise<CodexLoginInfo | undefined> {
  try {
    return parseCodexLoginDocument(await readFile(codexAuthFilePath(codexHome), "utf8"))
  } catch {
    return undefined
  }
}

/** The login without its token. */
export function describeCodexLogin(info: CodexLoginInfo): CodexLoginDescription {
  return {
    ...(info.accountId !== undefined ? { accountId: info.accountId } : {}),
    workspaces: info.workspaces.map(w => ({ ...w })),
  }
}

/**
 * A profile's workspace pin must name the workspace the login is bound to.
 * Fail-loud: a mismatch would bill the other subscription.
 */
export function checkCodexWorkspacePin(
  info: CodexLoginInfo,
  pin: Pick<SubaccountPin, "kind" | "id">,
): { ok: true } | { ok: false; message: string } {
  if (pin.kind !== "workspace") {
    return { ok: false, message: `a Codex profile pins a "workspace", not "${pin.kind}"` }
  }
  if (info.accountId === pin.id) return { ok: true }
  return {
    ok: false,
    message:
      `the Codex login in this profile's home is workspace "${info.accountId ?? "unknown"}", ` +
      `but the profile pins workspace "${pin.id}". Log in to that workspace in this home ` +
      `(CODEX_HOME=<home> codex login) or fix the pin.`,
  }
}
