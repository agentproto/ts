/**
 * MCP tool `quota_status` — live provider quota for a named auth profile
 * (AIP-67).
 *
 * One tool, one shape: the `QuotaStatus` from `@agentproto/quota`
 * (basis, windows with `remainingPct`, credits when the provider reports
 * them) read through its `QuotaReaderRegistry`. Read-only, never fabricates
 * a figure — a negative is an explicit result (see the error codes), never a
 * zero dressed up as data.
 *
 * Profile resolution: pass `profileRef`, or omit it to read the quota of the
 * CALLING session's own access profile (`SessionDescriptor.accessProfile`,
 * the same "current session" context every other tool resolves from the
 * `?callerSessionId=` query — wired in index.ts).
 *
 * `refresh` is accepted as a documented hint only: there is no cache layer,
 * every call already reads live from the provider.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { KeychainStore, getAuthProfile, type AuthProfile } from "@agentproto/auth"
import {
  QuotaReaderRegistry,
  createMoonshotQuotaReader,
  createOpenRouterQuotaReader,
  type QuotaProfile,
  type QuotaStatus,
} from "@agentproto/quota"

/**
 * Build the registry `quota_status` reads through. Registration order is
 * precedence: the first reader whose `supports()` claims a profile wins.
 *
 * Anthropic (`quotaFromAnthropicHeaders`) and Codex (`quotaFromCodexRateLimits`)
 * are pure PARSERS on this surface — a caller feeds them a captured header set
 * / `rate_limits` payload directly — not fetching `QuotaReader`s, so there is
 * nothing to register for them here.
 */
export function createQuotaReaderRegistry(): QuotaReaderRegistry {
  return new QuotaReaderRegistry()
    .register(createOpenRouterQuotaReader())
    .register(createMoonshotQuotaReader())
}

/** One module-level default: the readers are stateless, construction is cheap. */
let defaultRegistry: QuotaReaderRegistry | undefined
function sharedRegistry(): QuotaReaderRegistry {
  defaultRegistry ??= createQuotaReaderRegistry()
  return defaultRegistry
}

/** Read the profile's stored secret from the keychain. Never throws: a locked
 *  or missing entry resolves to `undefined` (AIP-67: unknown, not an error
 *  fabricated by the credential path). */
async function keychainSecret(ref: string): Promise<string | undefined> {
  try {
    const stored = await new KeychainStore().read({ path: ref })
    return stored && stored.value !== "" ? stored.value : undefined
  } catch {
    return undefined
  }
}

export interface QuotaStatusDeps {
  /** Look up an auth profile by id. Defaults to `@agentproto/auth`'s store. */
  getProfile?: (ref: string) => Promise<AuthProfile | undefined>
  /** Resolve a profile's keychain credentialRef to a secret. Defaults to the
   *  OS keychain. */
  resolveCredential?: (ref: string) => Promise<string | undefined>
  registry?: QuotaReaderRegistry
  fetchImpl?: typeof fetch
  now?: () => Date
  /** The calling session's own access-profile ref, when it has one. Used only
   *  when the caller omitted `profileRef`. */
  currentProfileRef?: () => string | undefined
}

/** Explicit negatives — never a thrown error, never a fabricated figure. */
export type QuotaStatusErrorCode =
  | "profile_ref_required"
  | "profile_not_found"
  | "no_reader"
  | "reader_returned_nothing"

export type QuotaStatusResult =
  | { ok: true; status: QuotaStatus }
  | { ok: false; error: QuotaStatusErrorCode; message: string }

/**
 * Core of `quota_status`, transport-free so tests and other runtime surfaces
 * can call it without an MCP server. Never throws.
 */
export async function readQuotaStatus(
  input: { profileRef?: string; refresh?: boolean },
  deps: QuotaStatusDeps = {},
): Promise<QuotaStatusResult> {
  const profileRef = input.profileRef ?? deps.currentProfileRef?.()
  if (!profileRef) {
    return {
      ok: false,
      error: "profile_ref_required",
      message:
        "No profileRef given and the calling session has no access profile to fall back to. " +
        "Pass profileRef (an id from auth_profile_list).",
    }
  }

  const profile = await (deps.getProfile ?? getAuthProfile)(profileRef)
  if (!profile) {
    return {
      ok: false,
      error: "profile_not_found",
      message: `No auth profile with id "${profileRef}" (see auth_profile_list).`,
    }
  }

  const quotaProfile: QuotaProfile = {
    profileRef: profile.id,
    endpoint: profile.endpoint,
    method: profile.method,
    ...(profile.credentialRef !== undefined ? { credentialRef: profile.credentialRef } : {}),
  }

  const registry = deps.registry ?? sharedRegistry()
  if (!registry.find(quotaProfile)) {
    return {
      ok: false,
      error: "no_reader",
      message:
        `No registered quota reader serves endpoint "${profile.endpoint}" / method "${profile.method}" ` +
        "on this profile. Readers are registered by endpoint; an unsupported profile has no quota surface here.",
    }
  }

  const status = await registry.read(quotaProfile, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    resolveCredential: deps.resolveCredential ?? keychainSecret,
  })
  if (!status) {
    return {
      ok: false,
      error: "reader_returned_nothing",
      message:
        `The quota reader for "${profile.endpoint}" could not produce a status (bad credential, ` +
        "unreachable provider, or a response with no usable figures). Unknown, not zero.",
    }
  }
  return { ok: true, status }
}

export function registerQuotaStatusTool(
  server: McpServer,
  deps: QuotaStatusDeps = {},
): void {
  server.tool(
    "quota_status",
    "Live provider quota for a named auth profile (AIP-67). Returns one " +
      "status: `basis` (where the figures came from), `windows` (" +
      "remainingPct 0-100, used/limit/remaining/unit, resetsAt), and " +
      "`credits` when the provider reports a balance. Omit `profileRef` to " +
      "read the calling session's own access profile. Read-only and " +
      "side-effect-free; unknowns are omitted, never fabricated. `refresh` " +
      "is a documented hint only — there is no cache, every call is live.",
    {
      profileRef: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Auth-profile id to read quota for (an id from auth_profile_list). " +
            "Omit to use this session's own access profile.",
        ),
      refresh: z
        .boolean()
        .optional()
        .describe(
          "Hint that a live re-read is wanted. Accepted and ignored: " +
            "nothing is cached, so every call already reads live.",
        ),
    },
    async (input) => {
      const result = await readQuotaStatus(input, deps)
      if (result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.status) }],
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: result.error, message: result.message }),
          },
        ],
        isError: true as const,
      }
    },
  )
}
