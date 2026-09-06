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
  credentialIdentity,
  deleteAuthProfile,
  getAuthProfile,
  listAuthProfiles,
  refreshAuthProfileModels,
  removeAuthProfile,
  setAuthProfileEnabled,
  setAuthProfileModels,
  AuthProfileValidationError,
  type AuthProfile,
  type CredentialStore,
  type ProfileProvisionDeps,
} from "@agentproto/auth"
import {
  importDiscoveredCredential,
  CredentialImportError,
} from "./credential-discovery.js"
import { buildCatalogProviderModels } from "./catalog-provider-models.js"
import { paginate, pageParamsShape, toolText } from "./tool-envelope.js"

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

/** How a profile's stored secret can be identified (WS5). `stored` ⇒ the
 *  keychain held a secret and `fingerprint`/`last4` were computed from it;
 *  `self-refreshing` ⇒ a source-backed profile with no stored secret to
 *  fingerprint; `unavailable` ⇒ a credential-backed profile whose secret
 *  could not be read (fail loud — never guessed, never the secret). */
type ProfileKeyStatus = "stored" | "self-refreshing" | "unavailable"

/** `auth_profile_list`'s per-profile row — the profile's non-secret metadata
 *  plus its key identity. NEVER carries the credential itself. */
interface AuthProfileListRow extends AuthProfile {
  keyStatus: ProfileKeyStatus
  /** One-way fingerprint of the stored secret — present only when
   *  `keyStatus === "stored"`. */
  fingerprint?: string
  /** Trailing 4 chars of the stored secret ("which key is this") — present
   *  only when `keyStatus === "stored"` and the secret is long enough to
   *  reveal a tail safely. */
  last4?: string
}

/**
 * Enrich one profile with its key identity (WS5), computed SERVER-SIDE from the
 * keychain. Money-safety: this reads the secret only to fingerprint it — the
 * secret is never returned, and any read failure fails loud as `unavailable`
 * rather than silently dropping to a state that could be mistaken for
 * "no key". A source-backed profile (no `credentialRef`) has no stored secret,
 * so it reports `self-refreshing` without touching the store.
 */
async function describeProfileKey(
  profile: AuthProfile,
  store: CredentialStore,
): Promise<AuthProfileListRow> {
  if (profile.credentialRef === undefined) {
    return { ...profile, keyStatus: "self-refreshing" }
  }
  try {
    const stored = await store.read({ path: profile.credentialRef })
    if (!stored || stored.value === "") {
      return { ...profile, keyStatus: "unavailable" }
    }
    const identity = credentialIdentity(stored.value)
    return {
      ...profile,
      keyStatus: "stored",
      fingerprint: identity.fingerprint,
      ...(identity.last4 !== undefined ? { last4: identity.last4 } : {}),
    }
  } catch {
    // A keychain read can fail (locked, ACL, missing entry) — surface that
    // explicitly instead of pretending the profile has no key.
    return { ...profile, keyStatus: "unavailable" }
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
      "— id, endpoint, method, credentialRef, label, plus the enable/disable " +
      "state (`disabled`) and any per-model curation (`models`) — never the " +
      "credential itself. Each row also carries a read-only KEY IDENTITY " +
      "computed server-side from the keychain: `keyStatus` (`stored` / " +
      "`self-refreshing` / `unavailable`) and, for a stored secret, a one-way " +
      "`fingerprint` + `last4` (never the secret). Optionally filter to one " +
      "billing endpoint.",
    {
      endpoint: z
        .string()
        .optional()
        .describe("Keep only profiles for this billing endpoint (e.g. anthropic)."),
      ...pageParamsShape,
    },
    async input => {
      try {
        const profiles = await listAuthProfiles(input.endpoint)
        const store = new KeychainStore()
        const enriched = await Promise.all(profiles.map(p => describeProfileKey(p, store)))
        // Pagination LAST — after the endpoint filter + keychain enrichment.
        // Without limit/cursor the output is byte-identical to the
        // pre-pagination handler.
        if (input.limit !== undefined || input.cursor !== undefined) {
          const page = paginate(enriched, input, { maxLimit: 200, keyOf: p => p.id })
          return { content: [{ type: "text", text: toolText(page) }] }
        }
        return text({ profiles: enriched })
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
      "one-way `fingerprint` so you can confirm which secret landed. An " +
      "`oauth-bearer` profile may instead give `source: \"claude-code-oauth\"` " +
      "to self-refresh from the local Claude Code login on every spawn, " +
      "storing no secret at all — give exactly one of `credential` / " +
      "`source`. Rejects a duplicate id.",
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
        .optional()
        .describe(
          "The raw secret (subscription bearer or API key). Stored, never echoed. " +
            "Mutually exclusive with source; required unless source is given.",
        ),
      source: z
        .string()
        .optional()
        .describe(
          "Self-refreshing credential source (oauth-bearer only, e.g. " +
            "\"claude-code-oauth\") — no secret is stored. Mutually exclusive with credential.",
        ),
      label: z.string().optional().describe("Optional human-readable name."),
      credentialRef: z
        .string()
        .optional()
        .describe(
          "Optional explicit keychain slot; omit to derive from endpoint+method. " +
            "Ignored for a source-backed profile.",
        ),
    },
    async ({ id, endpoint, method, credential, source, label, credentialRef }) => {
      try {
        const created = await createAuthProfile(
          {
            id,
            endpoint,
            method,
            ...(credential !== undefined ? { credential } : {}),
            ...(source !== undefined ? { source } : {}),
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

  // ── auth_profile_set_enabled ──────────────────────────────────
  server.tool(
    "auth_profile_set_enabled",
    "Enable or disable a whole named auth profile (WS2). A disabled profile " +
      "is skipped by the eligibility predicate entirely, so every model it " +
      "would otherwise bill drops to non-runnable — a REAL persisted state, " +
      "distinct from the derived `runnable` flag. Metadata-only: the keychain " +
      "credential is untouched. Enabling clears the flag (absent = enabled). " +
      "Returns the updated non-secret profile.",
    {
      id: z.string().describe("The profile id to enable/disable."),
      enabled: z.boolean().describe("true to enable, false to disable."),
    },
    async ({ id, enabled }) => {
      try {
        const profile = await setAuthProfileEnabled(id, enabled, defaultProfileProvisionDeps())
        return text({ profile })
      } catch (err) {
        if (err instanceof AuthProfileValidationError) {
          return errorText(`auth_profile_set_enabled rejected: ${err.message}`)
        }
        return errorText(
          `auth_profile_set_enabled failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  // ── auth_profile_set_models ───────────────────────────────────
  server.tool(
    "auth_profile_set_models",
    "Set a profile's per-model curation allowlist (WS3). `mode: \"all\"` " +
      "(the default when a profile has no curation) services every eligible " +
      "model and CLEARS any stored allowlist. `mode: \"allow\"` narrows the " +
      "profile to exactly `ids` — each a catalog `vendor/product` or " +
      "route-qualified `ref`; a curated profile stays endpoint-eligible but " +
      "only its chosen model refs become runnable. Metadata-only. Returns the " +
      "updated non-secret profile.",
    {
      id: z.string().describe("The profile id to curate."),
      mode: z
        .enum(["all", "allow"])
        .describe("all = service every eligible model; allow = only the listed ids."),
      ids: z
        .array(z.string())
        .optional()
        .describe(
          "Model identities to allow when mode=allow (catalog vendor/product or " +
            "route-qualified ref). Ignored for mode=all.",
        ),
    },
    async ({ id, mode, ids }) => {
      try {
        const profile = await setAuthProfileModels(
          id,
          { mode, ids: ids ?? [] },
          defaultProfileProvisionDeps(),
        )
        return text({ profile })
      } catch (err) {
        if (err instanceof AuthProfileValidationError) {
          return errorText(`auth_profile_set_models rejected: ${err.message}`)
        }
        return errorText(
          `auth_profile_set_models failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  // ── auth_profile_refresh_models ───────────────────────────────
  server.tool(
    "auth_profile_refresh_models",
    "Re-sync a `mode: \"allow\"` profile's curated `ids` against the CURRENT " +
      "model catalog for its endpoint — fixes curation drift, where an " +
      "allowlist generated once at import/provision time never picks up " +
      "models the catalog adds later or drops models it retires. Re-runs the " +
      "same enumeration (`catalog_provider_models` for the profile's " +
      "endpoint) that would build the list today and replaces `ids` with it. " +
      "Explicit and opt-in: nothing calls this automatically, so a profile " +
      "is only ever touched when this tool is invoked on it by name. " +
      "Rejects a profile with no `mode: \"allow\"` curation (a `mode: \"all\"` " +
      "profile already tracks the live catalog on every read, so there is " +
      "nothing to refresh). Returns the updated profile plus the `added`/" +
      "`removed` id diff.",
    {
      id: z.string().describe("The profile id to refresh."),
    },
    async ({ id }) => {
      try {
        const deps = defaultProfileProvisionDeps()
        const profile = await deps.getProfile(id)
        if (!profile) {
          return errorText(`auth_profile_refresh_models rejected: no profile with id "${id}"`)
        }
        const currentIds = buildCatalogProviderModels({ endpoint: profile.endpoint }).models.map(
          m => m.id,
        )
        const result = await refreshAuthProfileModels(id, currentIds, deps)
        return text({ profile: result.profile, added: result.added, removed: result.removed })
      } catch (err) {
        if (err instanceof AuthProfileValidationError) {
          return errorText(`auth_profile_refresh_models rejected: ${err.message}`)
        }
        return errorText(
          `auth_profile_refresh_models failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  // ── auth_profile_import ───────────────────────────────────────
  server.tool(
    "auth_profile_import",
    "Import a credential DISCOVERED by `auth_discover_credentials` into a " +
      "named auth profile (WS6). Materializes source-backed where possible " +
      "(claude-code → the self-refreshing `claude-code-oauth` source; " +
      "codex/gemini → their external file-based login sources), else COPIES " +
      "the located api-key (env / `~/.hermes/config.yaml`) into the keychain. " +
      "The method is fixed by `origin` — a subscription bearer can never be " +
      "stored as an api-key. Refuses unless the credential is STILL discovered " +
      "right now. The secret is INPUT-only: the response carries non-secret " +
      "metadata + a one-way `fingerprint` and the stamped `origin` (never the " +
      "credential). Rejects a duplicate id.",
    {
      origin: z
        .enum(["claude-code", "hermes-config", "env", "codex", "gemini"])
        .describe("Discovery origin to import from (from auth_discover_credentials)."),
      endpoint: z
        .string()
        .describe("Billing endpoint to import (must be one the origin serves, e.g. anthropic)."),
      id: z.string().optional().describe("Explicit profile id; defaults to `<origin>-<endpoint>`."),
      label: z.string().optional().describe("Optional human-readable name."),
    },
    async ({ origin, endpoint, id, label }) => {
      try {
        const created = await importDiscoveredCredential(
          { origin, endpoint, ...(id ? { id } : {}), ...(label ? { label } : {}) },
          defaultProfileProvisionDeps(),
        )
        return text({ profile: created })
      } catch (err) {
        if (err instanceof CredentialImportError || err instanceof AuthProfileValidationError) {
          return errorText(`auth_profile_import rejected: ${err.message}`)
        }
        return errorText(
          `auth_profile_import failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )
}
