import { describe, expect, it } from "vitest"

import {
  alreadyCovered,
  buildImportRequest,
  importableCredentials,
  importSuccessMessage,
  importedBadge,
  planOnboarding,
} from "./onboarding.logic.js"
import type {
  AuthProfileSummary,
  DiscoveredCredential,
} from "../client/types.js"

function discovered(over: Partial<DiscoveredCredential> = {}): DiscoveredCredential {
  return { origin: "env", endpoint: "openrouter", method: "api-key", hint: "OPENROUTER_API_KEY in the environment", ...over }
}

function profile(over: Partial<AuthProfileSummary> = {}): AuthProfileSummary {
  return { id: "p", endpoint: "openrouter", method: "api-key", ...over }
}

describe("alreadyCovered", () => {
  it("is true when a profile already bills the same endpoint+method", () => {
    expect(alreadyCovered(discovered(), [profile()])).toBe(true)
  })
  it("is false when no profile matches endpoint AND method", () => {
    expect(alreadyCovered(discovered({ endpoint: "moonshot" }), [profile()])).toBe(false)
    // Same endpoint, different method (subscription vs api-key) ⇒ not covered.
    expect(
      alreadyCovered(discovered({ endpoint: "anthropic", method: "oauth-bearer" }), [
        profile({ endpoint: "anthropic", method: "api-key" }),
      ]),
    ).toBe(false)
  })
})

describe("importableCredentials — the found-but-not-imported filter", () => {
  it("drops credentials an existing profile already covers", () => {
    const found = importableCredentials(
      [discovered({ endpoint: "openrouter" }), discovered({ origin: "env", endpoint: "moonshot", method: "api-key" })],
      [profile({ endpoint: "openrouter", method: "api-key" })],
    )
    expect(found.map((c) => c.endpoint)).toEqual(["moonshot"])
  })

  it("de-dupes by (origin, endpoint) and orders subscriptions first", () => {
    const found = importableCredentials(
      [
        discovered({ origin: "env", endpoint: "openrouter", method: "api-key" }),
        discovered({ origin: "env", endpoint: "openrouter", method: "api-key" }), // dup
        discovered({ origin: "claude-code", endpoint: "anthropic", method: "oauth-bearer", hint: "keychain" }),
      ],
      [],
    )
    // oauth-bearer first, then the single (de-duped) api-key row.
    expect(found.map((c) => `${c.origin}:${c.endpoint}`)).toEqual([
      "claude-code:anthropic",
      "env:openrouter",
    ])
    expect(found[0]?.suggestedId).toBe("claude-code-anthropic")
  })
})

describe("buildImportRequest", () => {
  it("assembles a by-reference request with a derived id (no secret)", () => {
    const [cred] = importableCredentials([discovered({ origin: "codex", endpoint: "openai", method: "oauth-bearer" })], [])
    expect(buildImportRequest(cred!)).toEqual({
      origin: "codex",
      endpoint: "openai",
      id: "codex-openai",
    })
  })
})

describe("planOnboarding", () => {
  it("flags a detected Claude Code login and lists the importables", () => {
    const plan = planOnboarding(
      [
        discovered({ origin: "claude-code", endpoint: "anthropic", method: "oauth-bearer", hint: "keychain" }),
        discovered({ origin: "env", endpoint: "openrouter", method: "api-key" }),
      ],
      [],
    )
    expect(plan.detectedClaudeCodeLogin).toBe(true)
    expect(plan.hasImportable).toBe(true)
    expect(plan.importable).toHaveLength(2)
  })

  it("reports nothing importable when every discovered credential is already wired", () => {
    const plan = planOnboarding([discovered({ endpoint: "openrouter", method: "api-key" })], [
      profile({ endpoint: "openrouter", method: "api-key" }),
    ])
    expect(plan.hasImportable).toBe(false)
    expect(plan.detectedClaudeCodeLogin).toBe(false)
  })
})

describe("presentation helpers", () => {
  it("importSuccessMessage names the wallet + origin, never a secret", () => {
    expect(importSuccessMessage({ id: "env-openrouter", endpoint: "openrouter", origin: "env" })).toBe(
      'Imported "env-openrouter" (openrouter) from env.',
    )
  })
  it("importedBadge renders only when an origin is present", () => {
    expect(importedBadge("claude-code")).toBe("imported from claude-code")
    expect(importedBadge(undefined)).toBe("")
  })
})
