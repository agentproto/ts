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
