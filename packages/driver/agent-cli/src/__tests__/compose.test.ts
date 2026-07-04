import { describe, it, expect } from "vitest"
import {
  composeSpawn,
  resolveContinuationStrategy,
  RuntimeConfigError,
} from "../manifest/compose.js"
import type { AgentCliHandle } from "../types.js"

const handle = (
  overrides: Partial<AgentCliHandle> = {}
): AgentCliHandle =>
  ({
    name: "claude-code",
    id: "claude-code",
    description: "Claude Code via ACP wrapper.",
    version: "0.1.0",
    bin: "npx",
    bin_args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    install: [
      { method: "npm", package: "@agentclientprotocol/claude-agent-acp", global: true },
    ],
    version_check: {
      cmd: "npm view @agentclientprotocol/claude-agent-acp version",
      parse: "(\\d+\\.\\d+\\.\\d+)",
      range: ">=0.30.0",
      timeout_ms: 15000,
    },
    sandbox: "./SANDBOX.md",
    protocol: "acp" as const,
    acp: "./claude-code-acp.ACP.md",
    modes: [
      { id: "default" },
      {
        id: "plan",
        bin_args_append: ["--permission-mode", "plan"],
      },
      {
        id: "bypass-permissions",
        bin_args_append: ["--permission-mode", "bypassPermissions"],
        env: { CLAUDE_BYPASS_PERMS: "1" },
      },
      {
        id: "lean",
        bin_args_prepend: ["--ignore-user-config"],
      },
    ],
    options: [
      {
        id: "model",
        type: "enum" as const,
        enum: ["claude-sonnet-4-6", "claude-opus-4-7"],
        bin_args_template: ["--model", "{value}"],
      },
      {
        id: "max_turns",
        type: "integer" as const,
        min: 1,
        max: 200,
        bin_args_template: ["--max-turns", "{value}"],
      },
      {
        id: "auto",
        type: "boolean" as const,
        bin_args_append_when_true: ["--auto"],
      },
      {
        id: "skills",
        type: "string" as const,
        bin_args_prepend: ["--skills", "{value}"],
      },
    ],
    continuation: {
      default: "pinned-session" as const,
      supported: ["pinned-session", "transcript", "none"] as const,
      pinned_session: { idle_timeout_ms: 1_800_000 },
    },
    ...overrides,
  } as AgentCliHandle)

describe("composeSpawn (AIP-45)", () => {
  it("returns manifest defaults verbatim when no config given", () => {
    const out = composeSpawn(handle())
    expect(out.binArgs).toEqual([
      "-y",
      "@agentclientprotocol/claude-agent-acp",
    ])
    expect(out.env).toEqual({})
  })

  it("appends mode patch after manifest bin_args", () => {
    const out = composeSpawn(handle(), { mode: "plan" })
    expect(out.binArgs).toEqual([
      "-y",
      "@agentclientprotocol/claude-agent-acp",
      "--permission-mode",
      "plan",
    ])
  })

  it("prepends mode bin_args_prepend before manifest bin_args", () => {
    const out = composeSpawn(handle(), { mode: "lean" })
    expect(out.binArgs).toEqual([
      "--ignore-user-config",
      "-y",
      "@agentclientprotocol/claude-agent-acp",
    ])
  })

  it("interpolates {value} in option bin_args_prepend", () => {
    const out = composeSpawn(handle(), {
      options: { skills: "changelog,pr-summary" },
    })
    expect(out.binArgs).toEqual([
      "--skills",
      "changelog,pr-summary",
      "-y",
      "@agentclientprotocol/claude-agent-acp",
    ])
  })

  it("composes the full [...prepend, ...bin_args, ...append] order across mode + options", () => {
    const out = composeSpawn(handle(), {
      mode: "lean",
      options: { skills: "foo", auto: true },
    })
    expect(out.binArgs).toEqual([
      // mode prepend first, then option prepends in declaration order
      "--ignore-user-config",
      "--skills",
      "foo",
      // manifest's base bin_args
      "-y",
      "@agentclientprotocol/claude-agent-acp",
      // option append last
      "--auto",
    ])
  })

  it("merges mode env", () => {
    const out = composeSpawn(handle(), { mode: "bypass-permissions" })
    expect(out.env).toEqual({ CLAUDE_BYPASS_PERMS: "1" })
  })

  it("rejects unknown mode with stable error code", () => {
    expect(() => composeSpawn(handle(), { mode: "yolo" })).toThrow(
      RuntimeConfigError
    )
    try {
      composeSpawn(handle(), { mode: "yolo" })
    } catch (err) {
      expect((err as RuntimeConfigError).code).toBe("unknown_mode")
      expect((err as RuntimeConfigError).path).toBe("config.mode")
    }
  })

  it("interpolates {value} in option bin_args_template", () => {
    const out = composeSpawn(handle(), {
      options: { model: "claude-opus-4-7", max_turns: 50 },
    })
    expect(out.binArgs).toEqual([
      "-y",
      "@agentclientprotocol/claude-agent-acp",
      "--model",
      "claude-opus-4-7",
      "--max-turns",
      "50",
    ])
  })

  it("only emits boolean flag when value === true", () => {
    expect(composeSpawn(handle(), { options: { auto: true } }).binArgs).toContain(
      "--auto"
    )
    expect(
      composeSpawn(handle(), { options: { auto: false } }).binArgs
    ).not.toContain("--auto")
  })

  it("applies option patches in declaration order, not config order", () => {
    // Operator passes them in reverse manifest order; output should
    // still match manifest declaration order (model before max_turns).
    const out = composeSpawn(handle(), {
      options: { max_turns: 10, model: "claude-sonnet-4-6" },
    })
    const modelIdx = out.binArgs.indexOf("--model")
    const turnsIdx = out.binArgs.indexOf("--max-turns")
    expect(modelIdx).toBeLessThan(turnsIdx)
  })

  it("rejects unknown option id", () => {
    expect(() =>
      composeSpawn(handle(), { options: { typo: 1 } as never })
    ).toThrow(RuntimeConfigError)
  })

  it("rejects type mismatch on integer option", () => {
    expect(() =>
      composeSpawn(handle(), { options: { max_turns: "lots" } as never })
    ).toThrow(/option_type_mismatch/)
  })

  it("rejects out-of-range integer (above max)", () => {
    expect(() =>
      composeSpawn(handle(), { options: { max_turns: 999 } })
    ).toThrow(/option_bounds_violation/)
  })

  it("rejects out-of-range integer (below min)", () => {
    expect(() =>
      composeSpawn(handle(), { options: { max_turns: 0 } })
    ).toThrow(/option_bounds_violation/)
  })

  it("rejects enum value not in declared list", () => {
    expect(() =>
      composeSpawn(handle(), { options: { model: "gpt-5" } })
    ).toThrow(/option_enum_violation/)
  })

  it("rejects continuation strategy not in supported", () => {
    expect(() =>
      composeSpawn(handle(), { continuation: "native-resume" })
    ).toThrow(/unsupported_continuation/)
  })

  it("composes mode + options together (declaration order honoured)", () => {
    const out = composeSpawn(handle(), {
      mode: "plan",
      options: { model: "claude-opus-4-7", auto: true },
    })
    expect(out.binArgs).toEqual([
      "-y",
      "@agentclientprotocol/claude-agent-acp",
      "--permission-mode",
      "plan",
      "--model",
      "claude-opus-4-7",
      "--auto",
    ])
  })
})

describe("composeSpawn model deny-list (AIP-45)", () => {
  // A budget-style handle: free-form string `model` option (any provider id
  // accepted) plus a deny-list reserving Anthropic for another adapter.
  const budgetHandle = (): AgentCliHandle =>
    handle({
      id: "hermes",
      options: [{ id: "model", type: "string" as const }],
      models: {
        default: "z-ai/glm-5.2",
        allowed: ["z-ai/glm-5.2", "deepseek/deepseek-v4-pro"],
        deny: ["anthropic/*", "claude-*"],
        apply: "command",
      },
    })

  it("throws model_denied on a prefix (`anthropic/*`) match", () => {
    try {
      composeSpawn(budgetHandle(), {
        options: { model: "anthropic/claude-opus-4-7" },
      })
      throw new Error("expected composeSpawn to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeConfigError)
      expect((err as RuntimeConfigError).code).toBe("model_denied")
      expect((err as RuntimeConfigError).path).toBe("config.options.model")
    }
  })

  it("throws model_denied on a bare `claude-*` id", () => {
    expect(() =>
      composeSpawn(budgetHandle(), { options: { model: "claude-opus-4-8" } })
    ).toThrow(RuntimeConfigError)
  })

  it("matches deny patterns case-insensitively", () => {
    expect(() =>
      composeSpawn(budgetHandle(), {
        options: { model: "Anthropic/Claude-Opus-4-7" },
      })
    ).toThrow(RuntimeConfigError)
  })

  it("allows a free-form model that is not denied (kimi/qwen stay usable)", () => {
    // Not in `allowed` — but `allowed` is only a curated menu, so an off-menu
    // OpenRouter id must still pass as long as it isn't denied.
    expect(() =>
      composeSpawn(budgetHandle(), {
        options: { model: "moonshotai/kimi-k2" },
      })
    ).not.toThrow()
  })

  it("does not enforce when no deny list is declared", () => {
    const noDeny = handle({
      options: [{ id: "model", type: "string" as const }],
      models: { default: "z-ai/glm-5.2" },
    })
    expect(() =>
      composeSpawn(noDeny, { options: { model: "anthropic/claude-opus-4-7" } })
    ).not.toThrow()
  })
})

describe("resolveContinuationStrategy (AIP-45)", () => {
  it("uses operator config override when provided", () => {
    expect(
      resolveContinuationStrategy(handle(), { continuation: "transcript" })
    ).toBe("transcript")
  })

  it("falls back to manifest default", () => {
    expect(resolveContinuationStrategy(handle(), {})).toBe("pinned-session")
  })

  it("falls back to 'none' when neither declares anything", () => {
    const bare = handle({ continuation: undefined })
    expect(resolveContinuationStrategy(bare, undefined)).toBe("none")
  })
})
