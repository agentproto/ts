/**
 * MCP tools for named auth-profile lifecycle (create / delete / list).
 *
 * A profile is a named credential the daemon owns end-to-end: the secret
 * lives in the OS keychain, its non-secret metadata in
 * `~/.agentproto/auth-profiles.json`. Only the daemon touches those, so a
 * remote client (the VS Code extension, a cloud operator) creates a profile
 * through these verbs rather than writing the files itself.
 *
 * The secret is INPUT-only: `auth_profile_create` takes a `credential`,
 * writes it to the keychain, and returns metadata + a one-way `fingerprint`
 * — never the credential. This is the same fingerprint-don't-echo discipline
 * `@agentproto/auth`'s `broker.ts` / `KeychainStore` already follow.
 *
 * All three tools defer to `@agentproto/auth`'s `createAuthProfile` /
 * `deleteAuthProfile` / `listAuthProfiles`, wired here to the real
 * `KeychainStore` + profile-store. No host options needed — the store paths
 * are fixed (`~/.agentproto`), same as every other `@agentproto/auth` reader
 * already mounted in the daemon (`session-spawn.ts`, `session-restart-core.ts`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  KeychainStore,
  addAuthProfile,
  createAuthProfile,
  deleteAuthProfile,
  getAuthProfile,
  listAuthProfiles,
  removeAuthProfile,
  AuthProfileValidationError,
  type ProfileProvisionDeps,
} from "@agentproto/auth"

/** Wire `@agentproto/auth`'s provisioning helpers to the real keychain +
 *  on-disk profile store. Shared by the MCP tools here and the HTTP routes in
 *  `http-server.ts` so both surfaces provision identically. */
export function defaultProfileProvisionDeps(): ProfileProvisionDeps {
  return {
    store: new KeychainStore(),
    getProfile: getAuthProfile,
    listProfiles: () => listAuthProfiles(),
    addProfile: addAuthProfile,
    removeProfile: removeAuthProfile,
  }
}

function text(value: string | object): {
  content: Array<{ type: "text"; text: string }>
} {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  }
}

function errorText(message: string): {
  content: Array<{ type: "text"; text: string }>
  isError: true
} {
  return { content: [{ type: "text", text: message }], isError: true }
}

export function registerAuthProfileTools(server: McpServer): void {
  // ── auth_profile_list ─────────────────────────────────────────
  server.tool(
    "auth_profile_list",
    "List the named auth profiles configured on this host (from " +
      "`~/.agentproto/auth-profiles.json`). Returns only non-secret metadata " +
      "— id, endpoint, method, credentialRef, label — never the credential " +
      "itself. Optionally filter to one billing endpoint.",
    {
      endpoint: z
        .string()
        .optional()
        .describe("Keep only profiles for this billing endpoint (e.g. anthropic)."),
    },
    async ({ endpoint }) => {
      try {
        const profiles = await listAuthProfiles(endpoint)
        return text({ profiles })
      } catch (err) {
        return errorText(
          `auth_profile_list failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  // ── auth_profile_create ───────────────────────────────────────
  server.tool(
    "auth_profile_create",
    "Create a named auth profile: write the credential to the OS keychain at " +
      "a derived slot, then record its metadata. Supports both " +
      "`oauth-bearer` (subscription) and `api-key` methods. The `credential` " +
      "is INPUT-ONLY — it is stored, never returned; the response carries a " +
      "one-way `fingerprint` so you can confirm which secret landed. Rejects " +
      "a duplicate id.",
    {
      id: z.string().describe("Stable, unique profile id (e.g. anthropic-sub)."),
      endpoint: z
        .string()
        .describe("Billing endpoint / vendor (anthropic, openrouter, moonshot, …)."),
      method: z
        .enum(["oauth-bearer", "api-key"])
        .describe("oauth-bearer for a subscription; api-key for a gateway/vendor key."),
      credential: z
        .string()
        .describe("The raw secret (subscription bearer or API key). Stored, never echoed."),
      label: z.string().optional().describe("Optional human-readable name."),
      credentialRef: z
        .string()
        .optional()
        .describe("Optional explicit keychain slot; omit to derive from endpoint+method."),
    },
    async ({ id, endpoint, method, credential, label, credentialRef }) => {
      try {
        const created = await createAuthProfile(
          {
            id,
            endpoint,
            method,
            credential,
            ...(label ? { label } : {}),
            ...(credentialRef ? { credentialRef } : {}),
          },
          defaultProfileProvisionDeps(),
        )
        return text({ profile: created })
      } catch (err) {
        if (err instanceof AuthProfileValidationError) {
          return errorText(`auth_profile_create rejected: ${err.message}`)
        }
        return errorText(
          `auth_profile_create failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  // ── auth_profile_delete ───────────────────────────────────────
  server.tool(
    "auth_profile_delete",
    "Delete a named auth profile and its keychain credential. Idempotent: a " +
      "missing id returns `{ deleted: false }`. The keychain entry is removed " +
      "only when no other profile still references the same slot.",
    {
      id: z.string().describe("The profile id to delete."),
    },
    async ({ id }) => {
      try {
        const result = await deleteAuthProfile(id, defaultProfileProvisionDeps())
        return text(result)
      } catch (err) {
        if (err instanceof AuthProfileValidationError) {
          return errorText(`auth_profile_delete rejected: ${err.message}`)
        }
        return errorText(
          `auth_profile_delete failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )
}
