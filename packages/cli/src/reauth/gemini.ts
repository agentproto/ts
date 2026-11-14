import { readRecipeLoginJson } from "@agentproto/secrets/provision/recipe"
import {
  asRecord,
  createLoginDocumentAdapter,
  jwtClaims,
  parseJsonDocument,
  type LoginDocument,
} from "./login-document.js"

export function parseGeminiLogin(raw: unknown): LoginDocument {
  const doc = asRecord(parseJsonDocument(raw))
  if (typeof doc.access_token !== "string" || doc.access_token === "") throw new Error("no access_token")
  const sub = jwtClaims(doc.id_token)?.sub
  return {
    secret: doc.access_token,
    ...(typeof doc.expiry_date === "number" ? { expiresAtMs: doc.expiry_date } : {}),
    ...(typeof sub === "string" && sub !== "" ? { accountId: sub } : {}),
    hasRefreshToken: typeof doc.refresh_token === "string" && doc.refresh_token !== "",
  }
}

/** Gemini CLI's Google login (`~/.gemini/oauth_creds.json`). It has no login
 *  subcommand: the login runs inside the interactive CLI, so it is manual. */
export function createGeminiReauthAdapter(read: () => Promise<unknown | undefined> = readLogin) {
  return createLoginDocumentAdapter({
    source: "gemini",
    aliases: ["google"],
    displayName: "Gemini CLI",
    parse: parseGeminiLogin,
    read,
    login: {
      kind: "manual",
      instructions:
        "The Gemini CLI has no login command that can be run from here. Start `gemini`, choose " +
        '"Login with Google" (use /auth to switch), finish the browser sign-in, then exit it.',
    },
    selfRefreshing: true,
    identityNote: "the Gemini login document carries no account subject",
  })
}

async function readLogin(): Promise<unknown | undefined> {
  try {
    return await readRecipeLoginJson("gemini")
  } catch {
    return undefined
  }
}

export const geminiReauth = createGeminiReauthAdapter()
