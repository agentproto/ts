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

import { resolveClaudeCodeOauthToken } from "../claude-code-oauth-source.js"

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
