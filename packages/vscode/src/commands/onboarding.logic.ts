/**
 * Pure logic for the first-run / re-runnable ONBOARDING wizard (WS6) — no
 * vscode import, so it's unit-testable under plain vitest. The command
 * (`onboarding.ts`) is a thin shell that drives QuickPick/InputBox and delegates
 * every decision here.
 *
 * The wizard turns the read-only `auth_discover_credentials` scan into action:
 * it shows the credentials already present on this host that AREN'T yet wired
 * into a profile ("found-but-not-imported"), lets the user import them in one
 * click (`auth_profile_import`, which stamps `origin`), and falls back to the
 * existing local-login + paste-a-key flows for anything discovery can't offer.
 *
 * No secret is ever handled here — a discovered credential carries only a
 * non-secret `hint`, and import happens daemon-side by reference.
 */

import type {
  AuthProfileSummary,
  CredentialOrigin,
  DiscoveredCredential,
  ImportCredentialRequest,
} from "../client/types.js"

/** A discovered credential the user can act on, once we've filtered out what an
 *  existing profile already covers. Carries only non-secret provenance. */
export interface ImportableCredential {
  origin: CredentialOrigin
  endpoint: string
  method: DiscoveredCredential["method"]
  /** Non-secret locator from the scan (e.g. "OPENROUTER_API_KEY in ~/.hermes/config.yaml"). */
  hint: string
  /** Default profile id an import would create — `<origin>-<endpoint>`. */
  suggestedId: string
}

/** True when an existing profile already covers a discovered credential — same
 *  billing endpoint AND method. That's the "already imported / already wired"
 *  signal: we don't nag to import an openrouter key when an openrouter api-key
 *  profile already exists, nor re-offer the Claude Code login once an anthropic
 *  subscription profile is present. A prior import (matching `origin`) is a
 *  strict subset of this and is covered too. */
export function alreadyCovered(
  cred: DiscoveredCredential,
  profiles: readonly AuthProfileSummary[],
): boolean {
  return profiles.some(p => p.endpoint === cred.endpoint && p.method === cred.method)
}

/**
 * The found-but-not-imported credentials, in a stable order (source-backed
 * subscriptions first — they're the zero-friction wins — then api-keys, then by
 * endpoint). De-duped by (origin, endpoint) so one scan never yields two rows
 * for the same wallet.
 */
export function importableCredentials(
  discovered: readonly DiscoveredCredential[],
  profiles: readonly AuthProfileSummary[],
): ImportableCredential[] {
  const seen = new Set<string>()
  const out: ImportableCredential[] = []
  for (const cred of discovered) {
    if (alreadyCovered(cred, profiles)) continue
    const key = `${cred.origin}:${cred.endpoint}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      origin: cred.origin,
      endpoint: cred.endpoint,
      method: cred.method,
      hint: cred.hint,
      suggestedId: `${cred.origin}-${cred.endpoint}`,
    })
  }
  return out.sort((a, b) => {
    // oauth-bearer (subscription) before api-key, then by endpoint.
    if (a.method !== b.method) return a.method === "oauth-bearer" ? -1 : 1
    return a.endpoint.localeCompare(b.endpoint)
  })
}

/** Assemble the wire request to import one discovered credential. The daemon
 *  reads the secret locally by reference — nothing secret crosses here. */
export function buildImportRequest(cred: ImportableCredential): ImportCredentialRequest {
  return { origin: cred.origin, endpoint: cred.endpoint, id: cred.suggestedId }
}

/** What the onboarding wizard should offer, derived purely from the scan +
 *  existing profiles. */
export interface OnboardingPlan {
  /** A local Claude Code login was detected on this host (headline for the
   *  first-run flow) — regardless of whether it's already imported. */
  detectedClaudeCodeLogin: boolean
  /** Found-but-not-imported credentials to present for one-click import. */
  importable: ImportableCredential[]
  /** Whether there's anything at all to import (drives "nothing to do, paste a
   *  key instead?" messaging). */
  hasImportable: boolean
}

/** Fold the discovery scan + existing profiles into the wizard's plan. Pure. */
export function planOnboarding(
  discovered: readonly DiscoveredCredential[],
  profiles: readonly AuthProfileSummary[],
): OnboardingPlan {
  const importable = importableCredentials(discovered, profiles)
  return {
    detectedClaudeCodeLogin: discovered.some(c => c.origin === "claude-code"),
    importable,
    hasImportable: importable.length > 0,
  }
}

/** A success line for an imported profile — names the wallet and where it came
 *  from, never the secret. */
export function importSuccessMessage(profile: {
  id: string
  endpoint: string
  origin?: string
}): string {
  const from = profile.origin ? ` from ${profile.origin}` : ""
  return `Imported "${profile.id}" (${profile.endpoint})${from}.`
}

/** The panel/tree badge text for an imported profile, or "" for a hand-created
 *  one. Drives the "imported from <origin>" chip (WS6). */
export function importedBadge(origin?: string): string {
  return origin ? `imported from ${origin}` : ""
}
