import { describe, expect, it } from "vitest"

import type { ProviderPresetEntry } from "../client/types.js"
import {
  autoAdoptDecision,
  buildCreateRequest,
  buildLocalLoginRequest,
  endpointChoices,
  methodChoices,
  successMessage,
  suggestProfileId,
  validateCredential,
  validateEndpoint,
  validateProfileId,
  LOCAL_LOGIN_RECIPES,
  SUBSCRIPTION_ENDPOINT,
} from "./authProfileFlow.logic.js"

describe("methodChoices", () => {
  it("offers subscription and api-key mapped to wire methods", () => {
    const methods = methodChoices().map(c => c.method)
    expect(methods).toEqual(["oauth-bearer", "api-key"])
  })
})

describe("endpointChoices", () => {
  const presets: ProviderPresetEntry[] = [
    { slug: "openrouter", name: "OpenRouter", status: "ready" },
    { slug: "moonshot", status: "available" },
  ]

  it("for a subscription, offers only anthropic", () => {
    expect(endpointChoices("oauth-bearer", presets)).toEqual([
      { label: "anthropic", endpoint: "anthropic" },
    ])
    expect(SUBSCRIPTION_ENDPOINT).toBe("anthropic")
  })

  it("for an api-key, leads with anthropic, then presets sorted, then a custom escape hatch", () => {
    const choices = endpointChoices("api-key", presets)
    expect(choices.map(c => c.label)).toEqual([
      "anthropic",
      "moonshot",
      "openrouter",
      "Custom endpoint…",
    ])
    expect(choices[0]).toEqual({ label: "anthropic", endpoint: "anthropic" })
    expect(choices.find(c => c.label === "openrouter")?.description).toBe("OpenRouter")
    // A slug === name should not duplicate into the description.
    expect(choices.find(c => c.label === "moonshot")?.description).toBeUndefined()
    expect(choices.at(-1)).toEqual({ label: "Custom endpoint…", custom: true })
  })

  it("dedupes if a preset ever also carries the anthropic slug", () => {
    const withAnthropicPreset: ProviderPresetEntry[] = [
      ...presets,
      { slug: "anthropic", name: "Anthropic (native)", status: "ready" },
    ]
    const choices = endpointChoices("api-key", withAnthropicPreset)
    expect(choices.filter(c => c.label === "anthropic")).toHaveLength(1)
    expect(choices[0]).toEqual({ label: "anthropic", endpoint: "anthropic" })
  })
})

describe("suggestProfileId", () => {
  it("suffixes -sub for subscriptions and -api for keys", () => {
    expect(suggestProfileId("oauth-bearer", "anthropic")).toBe("anthropic-sub")
    expect(suggestProfileId("api-key", "openrouter")).toBe("openrouter-api")
  })
})

describe("validateProfileId", () => {
  it("accepts a clean, unique id", () => {
    expect(validateProfileId("anthropic-sub", [])).toBeUndefined()
  })

  it("rejects empty, bad charset, and collisions", () => {
    expect(validateProfileId("   ", [])).toMatch(/required/)
    expect(validateProfileId("bad id", [])).toMatch(/letters/)
    expect(validateProfileId("dup", ["dup"])).toMatch(/already exists/)
  })
})

describe("validateEndpoint / validateCredential", () => {
  it("validateEndpoint mirrors the slug rule", () => {
    expect(validateEndpoint("requesty")).toBeUndefined()
    expect(validateEndpoint("")).toMatch(/required/)
    expect(validateEndpoint("bad endpoint")).toMatch(/letters/)
  })

  it("validateCredential requires a non-blank secret", () => {
    expect(validateCredential("tok")).toBeUndefined()
    expect(validateCredential("   ")).toMatch(/required/)
  })
})

describe("buildCreateRequest", () => {
  it("trims fields, keeps the credential verbatim, drops an empty label", () => {
    expect(
      buildCreateRequest({
        id: " anthropic-sub ",
        endpoint: " anthropic ",
        method: "oauth-bearer",
        credential: "sub-token",
        label: "   ",
      }),
    ).toEqual({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      credential: "sub-token",
    })
  })

  it("keeps a real label", () => {
    const req = buildCreateRequest({
      id: "or-api",
      endpoint: "openrouter",
      method: "api-key",
      credential: "k",
      label: "Work OpenRouter",
    })
    expect(req.label).toBe("Work OpenRouter")
  })

  it("passes a source through and never sends a credential alongside it", () => {
    const req = buildCreateRequest({
      id: "claude-code-local",
      endpoint: "anthropic",
      method: "oauth-bearer",
      source: " claude-code-oauth ",
      label: "My Claude Code login",
    })
    expect(req).toEqual({
      id: "claude-code-local",
      endpoint: "anthropic",
      method: "oauth-bearer",
      source: "claude-code-oauth",
      label: "My Claude Code login",
    })
    expect(req.credential).toBeUndefined()
  })
})

describe("buildLocalLoginRequest / LOCAL_LOGIN_RECIPES", () => {
  it("builds the exact Claude Code source-backed request the feature specifies", () => {
    const claude = LOCAL_LOGIN_RECIPES.find(r => r.source === "claude-code-oauth")!
    expect(buildLocalLoginRequest(claude)).toEqual({
      id: "claude-code-local",
      endpoint: "anthropic",
      method: "oauth-bearer",
      source: "claude-code-oauth",
      label: "My Claude Code login",
    })
  })

  it("builds the exact Codex file-based source-backed request", () => {
    const codex = LOCAL_LOGIN_RECIPES.find(r => r.source === "codex")!
    expect(buildLocalLoginRequest(codex)).toEqual({
      id: "codex-local",
      endpoint: "openai",
      method: "oauth-bearer",
      source: "codex",
      label: "My Codex login",
    })
  })

  it("builds the exact Gemini file-based source-backed request", () => {
    const gemini = LOCAL_LOGIN_RECIPES.find(r => r.source === "gemini")!
    expect(buildLocalLoginRequest(gemini)).toEqual({
      id: "gemini-local",
      endpoint: "google",
      method: "oauth-bearer",
      source: "gemini",
      label: "My Gemini login",
    })
  })

  it("only lists source-backed logins the runtime can resolve at spawn (Claude Code + Codex + Gemini)", () => {
    // All three have a runtime path now: Claude Code (bearer-injection) and
    // Codex + Gemini (file-based/external). The native `@agentproto/adapter-gemini`
    // adapter declaring the same external authSubscription is what promoted
    // Gemini out of the "dead-ends at spawn" set (see LOCAL_LOGIN_RECIPES' doc).
    expect(LOCAL_LOGIN_RECIPES.map(r => r.source)).toEqual([
      "claude-code-oauth",
      "codex",
      "gemini",
    ])
    for (const r of LOCAL_LOGIN_RECIPES) {
      expect(r.method).toBe("oauth-bearer")
      const req = buildLocalLoginRequest(r)
      expect(req.source).toBe(r.source)
      // A source-backed profile never carries a pasted credential.
      expect(req.credential).toBeUndefined()
    }
    const ids = LOCAL_LOGIN_RECIPES.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("autoAdoptDecision", () => {
  const login = { loginDetected: true, anthropicProfileExists: false }

  it("never acts when off", () => {
    expect(autoAdoptDecision("off", login)).toBe("skip")
  })

  it("skips when no login is detected or a wallet already exists", () => {
    expect(autoAdoptDecision("auto", { ...login, loginDetected: false })).toBe("skip")
    expect(autoAdoptDecision("ask", { ...login, anthropicProfileExists: true })).toBe("skip")
  })

  it("creates in auto and prompts in ask when a fresh login is present", () => {
    expect(autoAdoptDecision("auto", login)).toBe("create")
    expect(autoAdoptDecision("ask", login)).toBe("prompt")
  })
})

describe("successMessage", () => {
  it("names the profile and shows only the fingerprint, never the secret", () => {
    const msg = successMessage({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      fingerprint: "deadbeef1234",
    })
    expect(msg).toContain("anthropic-sub")
    expect(msg).toContain("deadbeef1234")
    expect(msg).toContain("anthropic · oauth-bearer")
  })
})
