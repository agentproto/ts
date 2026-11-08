import { readRecipeLoginJson } from "@agentproto/secrets/provision/recipe"
import {
  asRecord,
  createLoginDocumentAdapter,
  parseJsonDocument,
  type LoginDocument,
} from "./login-document.js"

export const CLAUDE_CODE_OAUTH_SOURCE = "claude-code-oauth"

export function parseClaudeCodeLogin(raw: unknown): LoginDocument {
  const oauth = asRecord(asRecord(parseJsonDocument(raw)).claudeAiOauth)
  if (typeof oauth.accessToken !== "string" || oauth.accessToken === "") throw new Error("no claudeAiOauth.accessToken")
  return {
    secret: oauth.accessToken,
    ...(typeof oauth.expiresAt === "number" ? { expiresAtMs: oauth.expiresAt } : {}),
    hasRefreshToken: typeof oauth.refreshToken === "string" && oauth.refreshToken !== "",
  }
}

/** Claude Code's login (macOS Keychain, else `~/.claude/.credentials.json`). */
export function createClaudeCodeReauthAdapter(read: () => Promise<unknown | undefined> = readLogin) {
  return createLoginDocumentAdapter({
    source: CLAUDE_CODE_OAUTH_SOURCE,
    aliases: ["claude-code", "claude", "anthropic"],
    displayName: "Claude Code",
    parse: parseClaudeCodeLogin,
    read,
    login: {
      kind: "command",
      command: "claude",
      args: ["auth", "login"],
      description: "claude auth login (opens a browser; sign in with the Claude account to use)",
    },
    // agentproto injects the stored access token as the bearer, and Claude
    // Code only renews it while it runs: an expired token is a real failure.
    identityNote: "Claude Code's login document carries no account identity",
  })
}

async function readLogin(): Promise<unknown | undefined> {
  try {
    return await readRecipeLoginJson(CLAUDE_CODE_OAUTH_SOURCE)
  } catch {
    return undefined
  }
}

export const claudeCodeReauth = createClaudeCodeReauthAdapter()
