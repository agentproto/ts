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

/** Codex's login (`~/.codex/auth.json`, written by `codex login`). */
export function createCodexReauthAdapter(read: () => Promise<unknown | undefined> = readLogin) {
  return createLoginDocumentAdapter({
    source: "codex",
    aliases: ["openai"],
    displayName: "Codex",
    parse: parseCodexLogin,
    read,
    login: {
      kind: "command",
      command: "codex",
      args: ["login"],
      description: "codex login (opens a browser; sign in with the ChatGPT account to use)",
    },
    selfRefreshing: true,
    identityNote: "the Codex login document carries no account id",
  })
}

async function readLogin(): Promise<unknown | undefined> {
  try {
    return await readRecipeLoginJson("codex", "oauth-subscription")
  } catch {
    return undefined
  }
}

export const codexReauth = createCodexReauthAdapter()
