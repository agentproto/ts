/**
 * Unit coverage for the impure `claude-code-oauth` recipe resolver wiring
 * (claude-code-oauth-source.ts) — that it resolves the recipe method by id and
 * reads its source via `@agentproto/secrets`, trimming the result. The secrets
 * subpath is MOCKED so this never touches the real macOS Keychain.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const resolveSourceSpec = vi.fn()
const resolveRecipeMethod = vi.fn()
vi.mock("@agentproto/secrets/provision/recipe", () => ({
  resolveSourceSpec: (...args: unknown[]) => resolveSourceSpec(...args),
  resolveRecipeMethod: (...args: unknown[]) => resolveRecipeMethod(...args),
}))

import {
  resolveClaudeCodeOauthToken,
  verifyLocalLoginPresent,
} from "../claude-code-oauth-source.js"
import { SubscriptionSourceError } from "../spawn-defaults.js"

describe("resolveClaudeCodeOauthToken", () => {
  beforeEach(() => {
    resolveSourceSpec.mockReset()
    resolveRecipeMethod.mockReset()
  })

  it("resolves the recipe method by id and reads its source, trimming whitespace", async () => {
    const fakeSource = [{ keychain: "Claude Code-credentials", jsonPath: "claudeAiOauth.accessToken" }]
    resolveRecipeMethod.mockReturnValue({ recipe: { id: "claude-code-oauth" }, method: { source: fakeSource } })
    resolveSourceSpec.mockResolvedValue("  sk-ant-oat01-fresh\n")

    const token = await resolveClaudeCodeOauthToken("claude-code-oauth")

    expect(resolveRecipeMethod).toHaveBeenCalledWith("claude-code-oauth")
    expect(resolveSourceSpec).toHaveBeenCalledWith(fakeSource)
    expect(token).toBe("sk-ant-oat01-fresh")
  })

  it("propagates a resolution failure (not logged in) so the caller can fail loud", async () => {
    resolveRecipeMethod.mockReturnValue({ recipe: { id: "claude-code-oauth" }, method: { source: [] } })
    resolveSourceSpec.mockRejectedValue(new Error("no credential source resolved"))

    await expect(resolveClaudeCodeOauthToken("claude-code-oauth")).rejects.toThrow(
      "no credential source resolved",
    )
  })
})

describe("verifyLocalLoginPresent (file-based / external login)", () => {
  beforeEach(() => {
    resolveSourceSpec.mockReset()
    resolveRecipeMethod.mockReset()
  })

  it("resolves the recipe and returns void when a login token is present (value discarded)", async () => {
    const fakeSource = { file: "~/.codex/auth.json", jsonPath: "tokens.access_token" }
    resolveRecipeMethod.mockReturnValue({ recipe: { id: "codex" }, method: { source: fakeSource } })
    resolveSourceSpec.mockResolvedValue("  ya29.codex-oauth-token\n")

    await expect(verifyLocalLoginPresent("codex", "codex")).resolves.toBeUndefined()
    // No methodId given ⇒ passed through as undefined, so `resolveRecipeMethod`
    // falls back to the recipe's default (first) method — today's behavior for
    // every single-surface adapter (codex, gemini).
    expect(resolveRecipeMethod).toHaveBeenCalledWith("codex", undefined)
    expect(resolveSourceSpec).toHaveBeenCalledWith(fakeSource)
  })

  it("threads an explicit methodId through to resolveRecipeMethod (multi-surface adapters)", async () => {
    const fakeSource = { file: "~/.local/share/opencode/auth.json", jsonPath: "openai.access" }
    resolveRecipeMethod.mockReturnValue({ recipe: { id: "opencode" }, method: { source: fakeSource } })
    resolveSourceSpec.mockResolvedValue("  chatgpt-access-token\n")

    await expect(
      verifyLocalLoginPresent("opencode", "opencode", "openai-oauth"),
    ).resolves.toBeUndefined()
    expect(resolveRecipeMethod).toHaveBeenCalledWith("opencode", "openai-oauth")
    expect(resolveSourceSpec).toHaveBeenCalledWith(fakeSource)
  })

  it("fails LOUD with SubscriptionSourceError when the login file is missing", async () => {
    resolveRecipeMethod.mockReturnValue({ recipe: { id: "codex" }, method: { source: {} } })
    resolveSourceSpec.mockRejectedValue(new Error("no credential source resolved"))

    const err = await verifyLocalLoginPresent("codex", "codex").catch(e => e)
    expect(err).toBeInstanceOf(SubscriptionSourceError)
    expect((err as SubscriptionSourceError).code).toBe("auth_source_unresolved")
    expect((err as Error).message).toMatch(/no codex login found/)
  })

  it("fails LOUD when the source resolves to an empty token", async () => {
    resolveRecipeMethod.mockReturnValue({ recipe: { id: "codex" }, method: { source: {} } })
    resolveSourceSpec.mockResolvedValue("   ")

    const err = await verifyLocalLoginPresent("codex", "codex").catch(e => e)
    expect(err).toBeInstanceOf(SubscriptionSourceError)
    expect((err as SubscriptionSourceError).code).toBe("auth_source_unresolved")
  })
})
