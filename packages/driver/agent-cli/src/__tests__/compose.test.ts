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
        id: "gateway",
        env: { ANTHROPIC_BASE_URL: "https://gw.example/anthropic" },
        env_unset: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
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
      {
        id: "base_url",
        type: "string" as const,
        env: { ANTHROPIC_BASE_URL: "{value}" },
        env_unset: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK"],
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

  it("surfaces mode env_unset for the runtime to scrub", () => {
    // compose is pure — it can't delete from process.env, so it surfaces
    // the declared keys; the runtime's start() applies the deletions at
    // the env-merge point (see define-agent-cli.ts).
    const out = composeSpawn(handle(), { mode: "gateway" })
    expect(out.env).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.example/anthropic",
    })
    expect(out.envUnset).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ])
  })

  it("returns empty envUnset when no mode is active", () => {
    expect(composeSpawn(handle()).envUnset).toEqual([])
    expect(composeSpawn(handle(), { mode: "default" }).envUnset).toEqual([])
  })

  it("surfaces option env_unset when the option has a non-default value", () => {
    // A value-bearing option (e.g. base_url) carrying env_unset scrubs the
    // ambient credential the moment it's set — symmetric with mode env_unset,
    // so a bare base_url auto-scrubs ANTHROPIC_API_KEY without a preset mode.
    const out = composeSpawn(handle(), { options: { base_url: "https://gw.example/anthropic" } })
    expect(out.env).toEqual({ ANTHROPIC_BASE_URL: "https://gw.example/anthropic" })
    expect(out.envUnset).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK"])
  })

  it("does NOT surface option env_unset when the option is absent", () => {
    // env_unset only applies when the option is active (non-default value),
    // same condition under which `env` merges — absent option ⇒ no scrub.
    const out = composeSpawn(handle(), { options: { model: "claude-sonnet-4-6" } })
    expect(out.envUnset).toEqual([])
  })

  it("merges mode + option env_unset (both contribute)", () => {
    // Mode and option env_unset stack — a gateway mode AND a base_url option
    // each declare scrubs; the runtime applies the union. Dedup is the
    // runtime's job (delete is idempotent); compose surfaces them in order.
    const out = composeSpawn(handle(), {
      mode: "gateway",
      options: { base_url: "https://other.example/anthropic" },
    })
    expect(out.env).toEqual({ ANTHROPIC_BASE_URL: "https://other.example/anthropic" })
    expect(out.envUnset).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_USE_BEDROCK",
    ])
  })

  it("does not surface option env_unset for a boolean option at value false", () => {
    // boolean options only patch when value === true; env_unset follows the
    // same gate so a disabled flag doesn't scrub anything.
    const out = composeSpawn(handle(), { options: { auto: false } })
    expect(out.envUnset).toEqual([])
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

  describe("legacy route/posture mode back-compat (SPEC §3.4a extraction)", () => {
    // A POST-migration manifest: the gateway (route) and permission (posture)
    // modes are gone; only the `lean` context mode remains. A caller can still
    // pass a legacy id as `config.mode` (persisted OPERATOR.md config, a
    // defaults binding, an in-flight request) — that must DEGRADE to a soft
    // no-op, not hard-fail the spawn, because the replacement route/posture path
    // (catalog `@route` / ACP mode registry) lands in a later step.
    const migrated = () =>
      handle({
        modes: [
          {
            id: "lean",
            kind: "context",
            env: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" },
          },
        ],
      })

    const LEGACY_IDS = [
      // route (deleted gateway modes)
      "moonshot",
      "openrouter",
      "requesty",
      "deepseek",
      // posture (deleted permission modes across claude-code/codex/opencode)
      "default",
      "plan",
      "accept-edits",
      "bypass-permissions",
      "read-only",
      "full-access",
      "build",
    ]

    it.each(LEGACY_IDS)(
      "composes a legacy '%s' id as a soft no-op (no throw, no env/argv patch)",
      legacyId => {
        const base = composeSpawn(migrated())
        let out!: ReturnType<typeof composeSpawn>
        expect(() => {
          out = composeSpawn(migrated(), { mode: legacyId })
        }).not.toThrow()
        // The extracted id contributes no mode patch — identical to no mode.
        expect(out.binArgs).toEqual(base.binArgs)
        expect(out.env).toEqual(base.env)
        expect(out.envUnset).toEqual(base.envUnset)
      }
    )

    it("still applies the surviving `lean` context mode normally", () => {
      const out = composeSpawn(migrated(), { mode: "lean" })
      expect(out.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe("1")
    })

    it("still throws unknown_mode for a genuinely-unknown id", () => {
      try {
        composeSpawn(migrated(), { mode: "yolo" })
        throw new Error("expected composeSpawn to throw")
      } catch (err) {
        expect(err).toBeInstanceOf(RuntimeConfigError)
        expect((err as RuntimeConfigError).code).toBe("unknown_mode")
      }
    })
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

  it("emits no argv/env patch for a mode declaring apply:'config'", () => {
    const withConfigMode = handle({
      modes: [
        { id: "default" },
        {
          id: "plan",
          apply: "config",
          // Deliberately declared alongside apply:"config" to prove
          // compose.ts ignores it rather than crashing a real CLI that
          // has no such flag.
          bin_args_append: ["--mode", "plan"],
          env: { SHOULD_NOT_APPLY: "1" },
        },
      ],
    })
    const out = composeSpawn(withConfigMode, { mode: "plan" })
    expect(out.binArgs).toEqual([
      "-y",
      "@agentclientprotocol/claude-agent-acp",
    ])
    expect(out.env).toEqual({})
  })

  it("keeps composing argv for a mode without apply (default 'bin_args')", () => {
    const out = composeSpawn(handle(), { mode: "plan" })
    expect(out.binArgs).toEqual([
      "-y",
      "@agentclientprotocol/claude-agent-acp",
      "--permission-mode",
      "plan",
    ])
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

describe("composeSpawn models.apply:\"arg\" (AIP-45)", () => {
  // A codex-shaped handle: the model is a CLI config override composed
  // into bin_args, not an ACP session config — mirrors adapters/codex.
  const argHandle = (): AgentCliHandle =>
    handle({
      id: "codex",
      bin_args: ["-y", "@zed-industries/codex-acp"],
      options: [
        {
          id: "model",
          type: "enum" as const,
          enum: ["gpt-5-codex", "gpt-5"],
        },
      ],
      models: {
        default: "gpt-5-codex",
        allowed: ["gpt-5-codex", "gpt-5"],
        apply: "arg",
        bin_args_template: ["-c", 'model="{model}"'],
      },
    })

  it("composes the model into bin_args via the template, {model} interpolated", () => {
    const composed = composeSpawn(argHandle(), {
      options: { model: "gpt-5-codex" },
    })
    expect(composed.binArgs).toEqual([
      "-y",
      "@zed-industries/codex-acp",
      "-c",
      'model="gpt-5-codex"',
    ])
  })

  it("does not touch bin_args when no model is requested", () => {
    const composed = composeSpawn(argHandle(), {})
    expect(composed.binArgs).toEqual(["-y", "@zed-industries/codex-acp"])
  })

  it("still enforces the option's own enum before composing", () => {
    expect(() =>
      composeSpawn(argHandle(), { options: { model: "gpt-9-nonexistent" } })
    ).toThrow(RuntimeConfigError)
  })
})

describe("composeSpawn always-on env (AIP-45 top-level `env`)", () => {
  it("merges manifest-level env when there is no config", () => {
    const h = handle({ env: { STATIC: "1" } })
    expect(composeSpawn(h).env).toEqual({ STATIC: "1" })
  })

  it("merges manifest-level env alongside a config path", () => {
    const h = handle({ env: { STATIC: "1" } })
    expect(composeSpawn(h, { mode: "default" }).env).toEqual({ STATIC: "1" })
  })

  it("lets a selected mode's env override a same-key manifest env", () => {
    const h = handle({
      env: { ANTHROPIC_BASE_URL: "https://default" },
      modes: [
        {
          id: "gw",
          env: { ANTHROPIC_BASE_URL: "https://gw.example/anthropic" },
        },
      ],
    })
    expect(composeSpawn(h, { mode: "gw" }).env.ANTHROPIC_BASE_URL).toBe(
      "https://gw.example/anthropic"
    )
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
