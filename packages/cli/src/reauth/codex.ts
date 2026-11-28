import { readFile } from "node:fs/promises"
import { codexAuthFilePath, resolveCodexHome, type ReauthTarget } from "@agentproto/auth"
import { readRecipeLoginJson } from "@agentproto/secrets/provision/recipe"
import {
  asRecord,
  createLoginDocumentAdapter,
  jwtExpiryMs,
  parseJsonDocument,
  type LoginDocument,
} from "./login-document.js"

export function parseCodexLogin(raw: unknown): LoginDocument {
  const tokens = asRecord(asRecord(parseJsonDocument(raw)).tokens)
  if (typeof tokens.access_token !== "string" || tokens.access_token === "") throw new Error("no tokens.access_token")
  const expiresAtMs = jwtExpiryMs(tokens.access_token)
  return {
    secret: tokens.access_token,
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    ...(typeof tokens.account_id === "string" && tokens.account_id !== "" ? { accountId: tokens.account_id } : {}),
    hasRefreshToken: typeof tokens.refresh_token === "string" && tokens.refresh_token !== "",
  }
}

/** Codex's login (`<codex home>/auth.json`, written by `codex login`; the home
 *  is `~/.codex` unless the profile carries its own `codexHome`). */
export function createCodexReauthAdapter(read: (target?: ReauthTarget) => Promise<unknown | undefined> = readLogin) {
  return createLoginDocumentAdapter({
    source: "codex",
    aliases: ["openai"],
    displayName: "Codex",
    parse: parseCodexLogin,
    read,
    login: target => {
      const home = target.profile?.codexHome
      if (home === undefined) {
        return {
          kind: "command",
          command: "codex",
          args: ["login"],
          description: "codex login (opens a browser; sign in with the ChatGPT account to use)",
        }
      }
      const dir = resolveCodexHome(home)
      return {
        kind: "command",
        command: "codex",
        args: ["login"],
        env: { CODEX_HOME: dir },
        description: `codex login in ${dir} (opens a browser; sign in with the ChatGPT account, and workspace, of this profile)`,
      }
    },
    selfRefreshing: true,
    identityNote: "the Codex login document carries no account id",
  })
}

async function readLogin(target?: ReauthTarget): Promise<unknown | undefined> {
  const home = target?.profile?.codexHome
  if (home !== undefined) {
    try {
      return await readFile(codexAuthFilePath(resolveCodexHome(home)), "utf8")
    } catch {
      return undefined
    }
  }
  try {
    return await readRecipeLoginJson("codex", "oauth-subscription")
  } catch {
    return undefined
  }
}

export const codexReauth = createCodexReauthAdapter()
