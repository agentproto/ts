/**
 * Impure resolver for the `claude-code-oauth` provision recipe — reads the
 * Claude Code subscription OAuth access token FRESH from the local login on
 * every call (macOS Keychain `Claude Code-credentials` → jsonPath
 * `claudeAiOauth.accessToken`, falling back to `~/.claude/.credentials.json`).
 * Because Claude Code keeps that item refreshed, resolving it per-spawn makes
 * agentproto's subscription auth effectively self-refreshing (Mode 3).
 *
 * Kept OUT of `spawn-defaults.ts` so that file stays pure and unit-testable in
 * isolation: the precedence logic there ({@link resolveSubscriptionCredential})
 * injects THIS as its `resolveSourceToken` dependency, and tests inject a fake
 * instead of touching the real Keychain.
 */

import {
  resolveRecipeMethod,
  resolveSourceSpec,
} from "@agentproto/secrets/provision/recipe"
import { SubscriptionSourceError } from "./spawn-defaults.js"

/**
 * Resolve a provision recipe's default method to a plaintext credential. `id`
 * is the recipe/source id (today only `"claude-code-oauth"`, already validated
 * by the caller). Throws if the recipe is unknown or no source in its chain
 * resolves (not logged in / no Keychain item) — the caller maps that to a
 * `SubscriptionSourceError`.
 */
export async function resolveClaudeCodeOauthToken(id: string): Promise<string> {
  const { method } = resolveRecipeMethod(id)
  return (await resolveSourceSpec(method.source)).trim()
}

/**
 * Verify a FILE-BASED (external) subscription login is actually present before
 * a spawn commits to it — the money-safety net for codex/gemini "use my
 * existing login". Unlike {@link resolveClaudeCodeOauthToken}, the resolved
 * value is DISCARDED: an external subscription injects no bearer (the CLI reads
 * its own login file), so we only need to confirm the file exists and carries a
 * token. Fails LOUD ({@link SubscriptionSourceError}) if the recipe's login
 * source resolves to nothing — refusing the spawn rather than letting the CLI
 * silently fall back to api-key billing under a "subscription" label. `recipeId`
 * is the provision-recipe id (e.g. `"codex"` → `~/.codex/auth.json`);
 * `adapterSlug` only shapes the actionable error message.
 *
 * `methodId` selects among the recipe's methods for a MULTI-SURFACE adapter
 * (mastracode/opencode: `"anthropic-oauth"` vs `"openai-oauth"`, by
 * convention `<provider>-oauth`) — omitted, it falls back to the recipe's
 * default (first) method, unchanged for every single-surface adapter
 * (codex, gemini, pi). A caller resolving a specific provider's surface
 * MUST pass the matching methodId: a recipe missing that method throws
 * (via `resolveRecipeMethod`), which this function turns into the same
 * loud `SubscriptionSourceError` as an unresolved source, never a silent
 * fallback to the wrong provider's login.
 */
export async function verifyLocalLoginPresent(
  recipeId: string,
  adapterSlug: string,
  methodId?: string,
): Promise<void> {
  let token: string
  try {
    const { method } = resolveRecipeMethod(recipeId, methodId)
    token = (await resolveSourceSpec(method.source)).trim()
  } catch (err) {
    throw new SubscriptionSourceError(
      "auth_source_unresolved",
      `no ${adapterSlug} login found — run \`${adapterSlug} login\` and sign in ` +
        `with your subscription first (${err instanceof Error ? err.message : String(err)}).`,
    )
  }
  if (!token) {
    throw new SubscriptionSourceError(
      "auth_source_unresolved",
      `no ${adapterSlug} login found — run \`${adapterSlug} login\` and sign in ` +
        `with your subscription first.`,
    )
  }
}
