/**
 * Tests for the `~/.agentproto/config.json` zod schema + key registry
 * (`config-schema.ts`). See `.plans/agentproto-config/PLAN.md` PR-1.
 */

import { describe, expect, it } from "vitest"
import {
  agentprotoConfigSchema,
  findConfigKey,
  findUnclassifiedConfigPaths,
  redactConfigValue,
  validateConfig,
  validateConfigKeyValue,
  CONFIG_KEYS,
} from "../config-schema.js"

describe("agentprotoConfigSchema", () => {
  it("accepts a realistic full config", () => {
    const full = {
      version: 1,
      daemon: {
        workspace: "/code/agentproto",
        port: 18790,
        bind: "127.0.0.1",
        allowedOrigins: ["https://app.example.com"],
        strictOrigins: false,
        label: "my-box",
        resumeSessionsOnBoot: true,
        idleReapAfterMs: 600_000,
        crashDetectIntervalMs: 30_000,
        restartSweepIntervalMs: 0,
        turnStallAfterMs: 300_000,
      },
      tunnel: { host: "wss://tunnel.example.com/connect", autoconnect: true, e2e: false },
      features: { pty: true, llmEndpoint: false },
      pairing: { rendezvous: "wss://rdv.example.com", autoconnect: true },
      worktrees: { root: "/code/worktrees", isolation: "on-request" },
      spawn: { attach: "always", dedupe: "always" },
      sessions: { attentionDelaySec: 60, eventsDir: "/code/sessions" },
      provenance: { wrapGh: false },
      agentsMd: { inlineMaxKb: 8 },
      titler: { enabled: true, model: "z-ai/glm-5.2@openrouter" },
      activeProfile: "local",
      profiles: {
        local: { tunnel: { host: "ws://localhost:3200/connect", autoconnect: true } },
      },
      defaults: {
        skills: ["planning"],
        options: { verbose: true },
        adapters: {
          "claude-code": {
            skills: ["planning"],
            options: { model: "sonnet" },
            auth: { mode: "subscription", source: "claude-code-oauth" },
            contextContinuity: { mode: "ask", warnAtPct: 55 },
          },
        },
        contextContinuity: { mode: "auto", warnAtPct: 50, compactAtPct: 60, continueFreshAtPct: 70, hardStopAtPct: 90 },
        defaultRoleDepthCutoff: 1,
        maxGrantableDelegation: 2,
        langfuseTracing: false,
        backgroundTaskWake: { enabled: true, graceMs: 20_000 },
        traceRedactor: "secrets",
        agentPromptInterrupt: false,
        messaging: { allowSiblings: false, agentInterrupt: "deny" },
        mcp: { deferredTools: true },
        spawn: { browser: "headless" },
      },
      acpAgents: {
        "my-agent": {
          bin: "my-agent",
          bin_args: ["acp"],
          env: { MY_AGENT_TOKEN: "set-but-not-a-real-secret" },
          resumable: true,
          models: { default: "my-model", allowed: ["my-model"] },
        },
      },
      terminalPresets: {
        proxy: { argv: ["bash"], cwd: "/code", label: "Proxy shell" },
      },
    }
    const result = agentprotoConfigSchema.safeParse(full)
    expect(result.success).toBe(true)
  })

  it("rejects a bad enum value", () => {
    const result = agentprotoConfigSchema.safeParse({ spawn: { attach: "sometimes" } })
    expect(result.success).toBe(false)
  })

  it("rejects a bad type on a nested field", () => {
    const result = agentprotoConfigSchema.safeParse({ daemon: { port: "18790" } })
    expect(result.success).toBe(false)
  })

  it("keeps unknown top-level and nested keys via passthrough", () => {
    const raw = {
      daemon: { port: 18790, somethingNew: true },
      aFutureTopLevelBlock: { nested: 1 },
    }
    const result = agentprotoConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.daemon).toMatchObject({ somethingNew: true })
      expect(result.data.aFutureTopLevelBlock).toEqual({ nested: 1 })
    }
  })
})

describe("validateConfig", () => {
  it("reports ok:true with no issues for a valid config", () => {
    expect(validateConfig({ daemon: { port: 18790 } })).toEqual({ ok: true, issues: [] })
  })

  it("reports issues with the offending path for an invalid config", () => {
    const result = validateConfig({ daemon: { port: "not-a-number" } })
    expect(result.ok).toBe(false)
    expect(result.issues.some(i => i.startsWith("daemon.port"))).toBe(true)
  })
})

describe("findConfigKey — wildcard lookup", () => {
  it("resolves a concrete adapter slug against the wildcard entry", () => {
    const entry = findConfigKey("defaults.adapters.claude-code.skills")
    expect(entry?.path).toBe("defaults.adapters.*.skills")
  })

  it("resolves a concrete ACP agent slug against the wildcard entry", () => {
    const entry = findConfigKey("acpAgents.my-agent.bin")
    expect(entry?.path).toBe("acpAgents.*.bin")
  })

  it("returns undefined for an unregistered path", () => {
    expect(findConfigKey("daemon.doesNotExist")).toBeUndefined()
  })

  it("does not match a path with a different segment count", () => {
    expect(findConfigKey("defaults.adapters.claude-code")).toBeUndefined()
  })
})

describe("secret and lockout classification", () => {
  it("marks daemon.authToken secret and not writable", () => {
    const entry = findConfigKey("daemon.authToken")
    expect(entry).toMatchObject({ secret: true, writable: false })
  })

  it("marks tunnel.token secret and not writable", () => {
    const entry = findConfigKey("tunnel.token")
    expect(entry).toMatchObject({ secret: true, writable: false })
  })

  it("marks defaults.adapters.*.auth.token and .apiKey secret and not writable", () => {
    expect(findConfigKey("defaults.adapters.x.auth.token")).toMatchObject({ secret: true, writable: false })
    expect(findConfigKey("defaults.adapters.x.auth.apiKey")).toMatchObject({ secret: true, writable: false })
  })

  it("marks the daemon lockout keys not writable and not secret", () => {
    const lockoutPaths = [
      "daemon.port",
      "daemon.bind",
      "daemon.allowedOrigins",
      "daemon.strictOrigins",
      "sessions.eventsDir",
      "profiles",
      "activeProfile",
    ]
    for (const path of lockoutPaths) {
      const entry = findConfigKey(path)
      expect(entry?.writable, `${path} should be locked out`).toBe(false)
      expect(entry?.secret, `${path} should not be marked secret`).toBeUndefined()
    }
  })

  it("marks acpAgents.*.env and terminalPresets.*.env secret (for redaction) but writable", () => {
    expect(findConfigKey("acpAgents.x.env")).toMatchObject({ secret: true, writable: true })
    expect(findConfigKey("terminalPresets.x.env")).toMatchObject({ secret: true, writable: true })
  })
})

describe("validateConfigKeyValue", () => {
  it("accepts a valid value for a known key", () => {
    expect(validateConfigKeyValue("daemon.idleReapAfterMs", 5000)).toEqual({ ok: true })
  })

  it("rejects a badly-typed value for a known key", () => {
    const result = validateConfigKeyValue("daemon.idleReapAfterMs", "soon")
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it("rejects a write to a non-writable (lockout) key", () => {
    const result = validateConfigKeyValue("daemon.port", 4000)
    expect(result.ok).toBe(false)
  })

  it("rejects a write to a non-writable (secret) key", () => {
    const result = validateConfigKeyValue("daemon.authToken", "sk-whatever")
    expect(result.ok).toBe(false)
  })

  it("accepts any value for an unregistered key", () => {
    expect(validateConfigKeyValue("someBrandNewKey", { anything: true })).toEqual({ ok: true })
  })
})

describe("redactConfigValue", () => {
  it("passes through a non-secret value unchanged", () => {
    expect(redactConfigValue("daemon.port", 18790)).toBe(18790)
  })

  it("redacts a set string secret to { set: true }", () => {
    expect(redactConfigValue("daemon.authToken", "sk-ant-something")).toEqual({ set: true })
  })

  it("redacts an absent secret to { set: false }", () => {
    expect(redactConfigValue("daemon.authToken", undefined)).toEqual({ set: false })
  })

  it("redacts each value in a secret env map independently", () => {
    expect(redactConfigValue("acpAgents.x.env", { A: "value", B: "" })).toEqual({
      A: { set: true },
      B: { set: false },
    })
  })
})

describe("drift: every schema leaf is classified", () => {
  it("has no unclassified config paths", () => {
    expect(findUnclassifiedConfigPaths()).toEqual([])
  })

  it("every CONFIG_KEYS entry's schema is a real zod schema", () => {
    for (const entry of CONFIG_KEYS) {
      expect(typeof entry.schema.safeParse).toBe("function")
    }
  })
})
