/**
 * Pure logic for the "create auth profile" flow — no vscode import, so it's
 * unit-testable under plain vitest. The command (`authProfiles.ts`) is a thin
 * shell that drives vscode QuickPick/InputBox and delegates every decision
 * (which choices to show, input validation, request assembly) here.
 *
 * Mirrors the daemon's own validation (`@agentproto/auth`'s
 * `validateCreateInput`) so a bad id is caught before the round-trip, and the
 * derived defaults match the `agentproto.auth.<vendor>[.<qualifier>]`
 * convention the daemon uses for keychain slots.
 */

import type {
  AuthMethod,
  CreateAuthProfileRequest,
  ProviderPresetEntry,
} from "../client/types.js"

/** A method choice row for the first QuickPick step. */
export interface MethodChoice {
  label: string
  description: string
  detail: string
  method: AuthMethod
}

/** The two supported methods, framed for a user rather than by wire name. */
export function methodChoices(): MethodChoice[] {
  return [
    {
      label: "Subscription",
      description: "oauth-bearer",
      detail: "A Claude/Anthropic subscription bearer token (Max, Team, …).",
      method: "oauth-bearer",
    },
    {
      label: "API key",
      description: "api-key",
      detail: "A gateway or vendor API key (OpenRouter, Moonshot, OpenAI, …).",
      method: "api-key",
    },
  ]
}

/** An endpoint choice row for the second step. */
export interface EndpointChoice {
  label: string
  description?: string
  /** The billing endpoint / vendor value. Absent on the "custom…" sentinel. */
  endpoint?: string
  /** True on the trailing "enter a custom endpoint" row. */
  custom?: boolean
}

/**
 * The endpoint options for a chosen method. A subscription is always against
 * `anthropic` today, so it needs no picker — the caller can skip straight
 * past. For an api-key we lead with `anthropic` (native, not a gateway
 * preset, so `list_provider_presets` never surfaces it on its own — every
 * adapter that honors `provider: "anthropic"` in api-key mode, e.g.
 * claude-code, already accepts one), then the provider presets (so the
 * common gateways are one click), then a "custom…" escape hatch for
 * anything unlisted.
 */
export function endpointChoices(
  method: AuthMethod,
  presets: readonly ProviderPresetEntry[],
): EndpointChoice[] {
  if (method === "oauth-bearer") {
    return [{ label: "anthropic", endpoint: "anthropic" }]
  }
  const fromPresets = [...presets]
    .filter(p => p.slug !== "anthropic")
    .map(p => ({
      label: p.slug,
      ...(p.name && p.name !== p.slug ? { description: p.name } : {}),
      endpoint: p.slug,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return [
    { label: "anthropic", endpoint: "anthropic" },
    ...fromPresets,
    { label: "Custom endpoint…", custom: true },
  ]
}

/** The single fixed endpoint for a subscription — no picker needed. */
export const SUBSCRIPTION_ENDPOINT = "anthropic"

/** Same charset the daemon enforces (`profile-provision.ts` SLUG_RE) — keep
 *  ids/endpoints safe as keychain-slot / filename fragments. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Suggest a default profile id for a method+endpoint, matching the seeded
 * fixtures (`anthropic-sub`, `openrouter-api`). Falls back to the endpoint
 * alone when it already carries the intent.
 */
export function suggestProfileId(method: AuthMethod, endpoint: string): string {
  const base = endpoint.trim() || "profile"
  return method === "oauth-bearer" ? `${base}-sub` : `${base}-api`
}

/** Validate a profile id, rejecting a bad charset or a collision with an
 *  existing profile. Returns an error message, or undefined when valid. */
export function validateProfileId(
  raw: string,
  existingIds: readonly string[],
): string | undefined {
  const id = raw.trim()
  if (!id) return "Id is required"
  if (!SLUG_RE.test(id)) {
    return 'Use letters, digits, ".", "_" or "-", starting with a letter or digit'
  }
  if (existingIds.includes(id)) return `A profile with id "${id}" already exists`
  return undefined
}

/** Validate an endpoint string (custom-entry path). */
export function validateEndpoint(raw: string): string | undefined {
  const endpoint = raw.trim()
  if (!endpoint) return "Endpoint is required"
  if (!SLUG_RE.test(endpoint)) {
    return 'Use letters, digits, ".", "_" or "-", starting with a letter or digit'
  }
  return undefined
}

/** Validate the pasted credential — non-empty once trimmed. */
export function validateCredential(raw: string): string | undefined {
  if (!raw.trim()) return "A credential is required"
  return undefined
}

/** The fields the flow collects before assembling a request. */
export interface CollectedProfileInput {
  id: string
  endpoint: string
  method: AuthMethod
  credential: string
  label?: string
}

/**
 * Assemble the wire request from collected inputs. Trims every field and
 * drops an empty label. The credential passes through verbatim (the daemon
 * trims it) — this is the only place it travels, and it's never logged.
 */
export function buildCreateRequest(
  input: CollectedProfileInput,
): CreateAuthProfileRequest {
  const label = input.label?.trim()
  return {
    id: input.id.trim(),
    endpoint: input.endpoint.trim(),
    method: input.method,
    credential: input.credential,
    ...(label ? { label } : {}),
  }
}

/** A user-facing success line — names the profile and shows the credential
 *  fingerprint (NEVER the credential itself), or the self-refreshing source
 *  for a source-backed profile, which stores no fingerprint at all. */
export function successMessage(profile: {
  id: string
  endpoint: string
  method: AuthMethod
  fingerprint?: string
  source?: string
}): string {
  const via =
    profile.fingerprint !== undefined
      ? `credential #${profile.fingerprint}`
      : `source "${profile.source}"`
  return `Created auth profile "${profile.id}" (${profile.endpoint} · ${profile.method}) — ${via}`
}
