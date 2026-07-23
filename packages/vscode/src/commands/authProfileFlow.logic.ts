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

/** The fields the flow collects before assembling a request. A profile is
 *  either credential-backed (paste/login) or source-backed (a self-refreshing
 *  local login) — give exactly one of `credential` / `source`. */
export interface CollectedProfileInput {
  id: string
  endpoint: string
  method: AuthMethod
  credential?: string
  /** Self-refreshing credential source (oauth-bearer only) — when set, no
   *  credential is collected or sent; the daemon resolves it fresh per spawn. */
  source?: string
  label?: string
}

/**
 * Assemble the wire request from collected inputs. Trims every field and
 * drops an empty label. A `source` wins over `credential` and is mutually
 * exclusive with it (the daemon rejects both) — a source-backed profile
 * stores no secret. The credential otherwise passes through verbatim (the
 * daemon trims it) — this is the only place it travels, and it's never logged.
 */
export function buildCreateRequest(
  input: CollectedProfileInput,
): CreateAuthProfileRequest {
  const label = input.label?.trim()
  const source = input.source?.trim()
  return {
    id: input.id.trim(),
    endpoint: input.endpoint.trim(),
    method: input.method,
    ...(source ? { source } : { credential: input.credential ?? "" }),
    ...(label ? { label } : {}),
  }
}

/**
 * A "use my existing local login" recipe — a source-backed profile that reuses
 * a CLI the user is already signed into on this host. The daemon resolves the
 * bearer FRESH from that login on every spawn (Mode 3), so there's no token to
 * paste and nothing static to go stale. Purely descriptive data; the impure
 * detection + connect live in `localLogin.ts`.
 */
export interface LocalLoginRecipe {
  /** Collision-safe profile id created for this login. */
  id: string
  /** Provision-recipe / `auth.source` id the daemon resolves per spawn. */
  source: string
  /** Billing endpoint the source authenticates. */
  endpoint: string
  method: AuthMethod
  /** Human-readable profile label. */
  label: string
  /** QuickPick row label (leading codicon). */
  pickLabel: string
  /** QuickPick detail line. */
  detail: string
  /** `~`-relative credential file whose presence signals the login (the
   *  fallback / non-macOS location). */
  credentialFile: string
  /** macOS login-keychain generic-password service that also holds it, when
   *  the CLI keeps its token there instead of the file (Claude Code on macOS). */
  keychainService?: string
}

/**
 * The local logins we can adopt — each backed by a runtime path that resolves
 * the login at spawn. Two shapes:
 *
 *   - Bearer-injection (Claude Code): the `claude-code-oauth` bearer is read
 *     fresh and injected into the adapter's `authSubscription.setEnv`
 *     (`CLAUDE_CODE_OAUTH_TOKEN`), which the CLI consumes natively.
 *   - File-based / external (Codex, Gemini): the CLI reads its OWN login file
 *     (`~/.codex/auth.json`, `~/.gemini/oauth_creds.json`) — there is no env
 *     bearer to inject, so the adapter declares `authSubscription: { external:
 *     true }`. The daemon verifies the login is present (fail-loud) and scrubs
 *     the api-key vars so a stray key can't flip billing; it injects nothing.
 *     The profile's `source` (`"codex"` / `"gemini"`) names the provision
 *     recipe the daemon verifies against.
 *
 * Gemini dropped in as the third row once the native `@agentproto/adapter-gemini`
 * adapter declared the same `external` `authSubscription` (scrubbing
 * `GEMINI_API_KEY`/`GOOGLE_API_KEY`, verifying `~/.gemini/oauth_creds.json`) —
 * no new mechanism, exactly as the file-based-subscription-login plan scoped it.
 */
export const LOCAL_LOGIN_RECIPES: readonly LocalLoginRecipe[] = [
  {
    id: "claude-code-local",
    source: "claude-code-oauth",
    endpoint: "anthropic",
    method: "oauth-bearer",
    label: "My Claude Code login",
    pickLabel: "$(sign-in) Use my existing Claude Code login",
    detail:
      "Bill against your local Claude Code subscription — refreshed automatically, no token to paste.",
    credentialFile: "~/.claude/.credentials.json",
    keychainService: "Claude Code-credentials",
  },
  {
    id: "codex-local",
    source: "codex",
    endpoint: "openai",
    method: "oauth-bearer",
    label: "My Codex login",
    pickLabel: "$(sign-in) Use my existing Codex login",
    detail:
      "Bill against your ChatGPT/Codex subscription — the Codex CLI reads its own login (~/.codex/auth.json); nothing is pasted or injected.",
    credentialFile: "~/.codex/auth.json",
  },
  {
    id: "gemini-local",
    source: "gemini",
    endpoint: "google",
    method: "oauth-bearer",
    label: "My Gemini login",
    pickLabel: "$(sign-in) Use my existing Gemini login",
    detail:
      "Bill against your Gemini subscription — the Gemini CLI reads its own login (~/.gemini/oauth_creds.json); nothing is pasted or injected.",
    credentialFile: "~/.gemini/oauth_creds.json",
  },
]

/** Assemble the create request for a source-backed local-login profile — no
 *  credential is collected or sent, only the self-refreshing `source`. */
export function buildLocalLoginRequest(
  recipe: LocalLoginRecipe,
): CreateAuthProfileRequest {
  return buildCreateRequest({
    id: recipe.id,
    endpoint: recipe.endpoint,
    method: recipe.method,
    source: recipe.source,
    label: recipe.label,
  })
}

/** How the `agentproto.autoAdoptLocalLogin` setting treats a detected local
 *  Claude Code login on activation. */
export type AutoAdoptMode = "auto" | "ask" | "off"

/**
 * Decide what to do on activation given the setting and the two facts we
 * probe: whether a local Claude Code login is present, and whether an
 * anthropic profile already exists. "off" never acts; otherwise we only act
 * when a login is present AND no anthropic profile exists yet (so we never
 * shadow a wallet the user already configured). Adopting the sole anthropic
 * profile makes it the default wallet through the daemon's existing
 * single-eligible-profile precedence — no separate "set default" write.
 */
export function autoAdoptDecision(
  mode: AutoAdoptMode,
  facts: { loginDetected: boolean; anthropicProfileExists: boolean },
): "create" | "prompt" | "skip" {
  if (mode === "off") return "skip"
  if (!facts.loginDetected || facts.anthropicProfileExists) return "skip"
  return mode === "auto" ? "create" : "prompt"
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
