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

  it("rejects out-of-range integer", () => {
    expect(() =>
      composeSpawn(handle(), { options: { max_turns: 999 } })
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
