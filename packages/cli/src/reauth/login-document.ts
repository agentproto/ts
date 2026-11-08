/**
 * Shared shape of the file/keychain-backed logins (Claude Code, Codex, Gemini):
 * one JSON login document written by the vendor's own CLI. A source module
 * only says where that document is, how to read the expiry and identity out of
 * it, and which command logs in again; this builds the {@link ReauthAdapter}.
 *
 * Tokens are read only to fingerprint them and to read their expiry: nothing
 * returned from here carries one.
 */

import { createHash } from "node:crypto"
import {
  deriveAuthState,
  type ParentAccountInfo,
  type ReauthAdapter,
  type ReauthLoginPlan,
  type ReauthVerification,
} from "@agentproto/auth"

export interface LoginDocument {
  /** One-way digest input: changes whenever the login is replaced or refreshed. */
  secret: string
  /** Epoch ms. */
  expiresAtMs?: number
  /** Opaque account id from the document, when it carries one. */
  accountId?: string
  /** The document holds a refresh token. */
  hasRefreshToken: boolean
}

export interface LoginDocumentSource {
  source: string
  aliases?: readonly string[]
  displayName: string
  /** Parse the raw login document. Throws when it is not a usable login. */
  parse(raw: unknown): LoginDocument
  /** The raw document, or undefined when no login is stored. */
  read(): Promise<unknown | undefined>
  /** The vendor CLI invocation that logs in again, or manual instructions. */
  login: ReauthLoginPlan
  /** The CLI renews the access token itself (see `ParentAccountInfo.selfRefreshing`). */
  selfRefreshing?: boolean
  /** Said when the document carries no account identity to compare. */
  identityNote: string
}

const digest = (secret: string) => createHash("sha256").update(secret).digest("hex").slice(0, 16)

/** `exp` (epoch seconds) of a JWT, in ms, without verifying it. */
export function jwtExpiryMs(jwt: unknown): number | undefined {
  const claims = jwtClaims(jwt)
  return typeof claims?.exp === "number" ? claims.exp * 1000 : undefined
}

export function jwtClaims(jwt: unknown): Record<string, unknown> | undefined {
  if (typeof jwt !== "string") return undefined
  const part = jwt.split(".")[1]
  if (!part) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
}

export function parseJsonDocument(raw: unknown): unknown {
  return typeof raw === "string" ? JSON.parse(raw) : raw
}

export function createLoginDocumentAdapter(spec: LoginDocumentSource, now: () => number = Date.now): ReauthAdapter {
  async function inspect(): Promise<ParentAccountInfo> {
    let raw: unknown
    try {
      raw = await spec.read()
    } catch (err) {
      return { loggedIn: false, note: `${spec.displayName} login unreadable: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (raw === undefined) return { loggedIn: false, note: `no ${spec.displayName} login is stored on this host` }
    let doc: LoginDocument
    try {
      doc = spec.parse(raw)
    } catch (err) {
      return { loggedIn: false, note: `${spec.displayName} login is not usable: ${err instanceof Error ? err.message : String(err)}` }
    }
    return {
      loggedIn: true,
      ...(doc.accountId !== undefined ? { id: doc.accountId } : {}),
      ...(doc.expiresAtMs !== undefined ? { expiresAtMs: doc.expiresAtMs } : {}),
      fingerprint: digest(doc.secret),
      ...(spec.selfRefreshing && doc.hasRefreshToken ? { selfRefreshing: true } : {}),
      ...(spec.selfRefreshing && doc.hasRefreshToken
        ? { note: `${spec.displayName} renews this access token itself; log in again only if it fails` }
        : doc.expiresAtMs === undefined
          ? { note: "the login document carries no expiry" }
          : {}),
    }
  }

  return {
    source: spec.source,
    ...(spec.aliases ? { aliases: spec.aliases } : {}),
    displayName: spec.displayName,
    inspect,
    plan: () => spec.login,
    async verify(_target, before): Promise<ReauthVerification> {
      const after = await inspect()
      const checked: string[] = []
      const notChecked: string[] = []
      const problems: string[] = []
      if (!after.loggedIn) {
        problems.push(`no usable ${spec.displayName} login is stored after the login${after.note ? ` (${after.note})` : ""}`)
      } else {
        checked.push(`a ${spec.displayName} login is stored`)
        if (!before.loggedIn) {
          checked.push("a login now exists where none was stored before")
        } else if (before.fingerprint !== undefined && before.fingerprint === after.fingerprint) {
          problems.push("the stored login did not change: the login did not complete")
        } else {
          checked.push("the stored login was replaced")
        }
        if (!after.selfRefreshing && deriveAuthState(after.expiresAtMs, now()) === "expired") {
          problems.push("the stored login is already expired")
        } else if (after.expiresAtMs !== undefined) {
          checked.push(`the stored login expires ${new Date(after.expiresAtMs).toISOString()}`)
        } else {
          notChecked.push("expiry: the login document carries none")
        }
        if (before.id !== undefined && after.id !== undefined) {
          if (before.id === after.id) checked.push("the login is for the same account as before")
          else problems.push("the login is for a different account than the one stored before")
        } else {
          notChecked.push(`which account was meant: ${spec.identityNote}`)
        }
      }
      notChecked.push("that the provider accepts the new login: it was not exercised against the provider")
      return {
        status: problems.length > 0 ? "failed" : "verified",
        checked,
        notChecked,
        problems,
        sideEffects: [],
        parent: after,
      }
    },
  }
}
