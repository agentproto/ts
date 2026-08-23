import { describe, it, expect } from "vitest"

/**
 * Schema coverage for `authSubscription`'s single-or-array shape (multi-
 * surface adapters, e.g. mastracode/opencode declaring an anthropic AND an
 * openai native OAuth login) — see `authSubscriptionSchema` in schema.ts.
 * `defineAgentCli` runs the SAME zod validation `agentCliFrontmatterSchema`
 * does (see `define-agent-cli.ts`'s `validate()`), so exercising it here
 * covers both paths without needing a full frontmatter fixture.
 */

const { defineAgentCli } = await import("../define-agent-cli.js")
import type { AgentCliDefinition } from "../types.js"

const base: Omit<AgentCliDefinition, "authSubscription"> = {
  name: "test-adapter",
  id: "test-adapter",
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "test-adapter"],
  install: [{ method: "npm", package: "test-adapter" }],
  version_check: { cmd: "npm view x", parse: "(\\d+)", range: ">=0.0.0" },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./test-adapter.ACP.md",
}

describe("authSubscription — single-or-array validation", () => {
  it("accepts a single unscoped surface (claude-code shape)", () => {
    expect(() =>
      defineAgentCli({ ...base, authSubscription: { setEnv: "CLAUDE_CODE_OAUTH_TOKEN" } }),
    ).not.toThrow()
  })

  it("accepts a single provider-scoped surface (pi shape)", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: { setEnv: "ANTHROPIC_OAUTH_TOKEN", provider: "anthropic" },
      }),
    ).not.toThrow()
  })

  it("accepts an array of provider-scoped surfaces (mastracode/opencode shape)", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: [
          { external: true, provider: "anthropic" },
          { external: true, provider: "openai" },
        ],
      }),
    ).not.toThrow()
  })

  it("rejects two array entries scoped to the same provider", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: [
          { external: true, provider: "anthropic" },
          { external: true, provider: "anthropic" },
        ],
      }),
    ).toThrow(/duplicate provider scope "anthropic"/)
  })

  it("rejects two unscoped array entries", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: [{ setEnv: "GENERIC_A" }, { setEnv: "GENERIC_B" }],
      }),
    ).toThrow(/more than one unscoped entry/)
  })

  it("rejects an empty array", () => {
    expect(() => defineAgentCli({ ...base, authSubscription: [] })).toThrow()
  })

  it("still rejects an external entry that also declares setEnv, inside an array", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: [
          { external: true, provider: "anthropic" },
          { external: true, setEnv: "OPENAI_OAUTH_TOKEN", provider: "openai" },
        ],
      }),
    ).toThrow(/must NOT declare setEnv/)
  })
})
