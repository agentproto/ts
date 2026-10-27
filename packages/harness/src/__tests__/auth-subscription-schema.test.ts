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

describe("authSubscription.boxLogin — box-login bridge declaration", () => {
  it("accepts a boxLogin on an external surface (codex shape)", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: {
          external: true,
          boxLogin: {
            recipe: "codex",
            keep: ["tokens.access_token", "tokens.id_token", "tokens.account_id", "last_refresh"],
          },
        },
      }),
    ).not.toThrow()
  })

  it("accepts an optional methodId / expiresPath / home-relative file override", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: [
          { external: true, provider: "anthropic" },
          {
            external: true,
            provider: "openai",
            boxLogin: {
              recipe: "opencode",
              methodId: "openai-oauth",
              keep: ["openai.access"],
              expiresPath: "openai.expires_at",
              file: ".local/share/opencode/auth.json",
            },
          },
        ],
      }),
    ).not.toThrow()
  })

  it("rejects boxLogin on a bearer (non-external) surface — only a file has something to bridge", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: {
          setEnv: "ANTHROPIC_OAUTH_TOKEN",
          boxLogin: { recipe: "codex", keep: ["tokens.access_token"] },
        },
      }),
    ).toThrow(/boxLogin requires external: true/)
  })

  it("rejects boxLogin on a non-external entry inside an array, too", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: [
          { external: true, provider: "anthropic" },
          {
            setEnv: "OPENAI_OAUTH_TOKEN",
            provider: "openai",
            boxLogin: { recipe: "opencode", keep: ["openai.access"] },
          },
        ],
      }),
    ).toThrow(/boxLogin requires external: true/)
  })

  it("rejects an empty keep-list — it would copy nothing the box could bill with", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: { external: true, boxLogin: { recipe: "codex", keep: [] } },
      }),
    ).toThrow()
  })

  it("rejects a boxLogin without a recipe or without keep", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: { external: true, boxLogin: { keep: ["tokens.access_token"] } as never },
      }),
    ).toThrow()
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: { external: true, boxLogin: { recipe: "codex", keep: undefined as never } },
      }),
    ).toThrow()
  })

  it("rejects unknown boxLogin keys (strict schema — no smuggling a token through an extra field)", () => {
    expect(() =>
      defineAgentCli({
        ...base,
        authSubscription: {
          external: true,
          boxLogin: {
            recipe: "codex",
            keep: ["tokens.access_token"],
            token: "sk-smuggled",
          } as never,
        },
      }),
    ).toThrow()
  })
})
