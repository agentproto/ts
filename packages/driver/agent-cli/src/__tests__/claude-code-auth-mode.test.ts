import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"

/**
 * Regression coverage for the driver's MECHANICAL billing-auth application
 * (see `AgentCliStartOptions.auth` / `ResolvedAuthSpec` in types.ts and the
 * auth block in `define-agent-cli.ts`'s `start()`). The runtime resolver now
 * owns provider/mode/env/scrub selection; the driver only APPLIES the resolved
 * spec: ENGAGE when `enforce === "always"` OR `explicit`, then scrub the
 * `unsetEnv` set (unless this spawn's own mode/option patch set the key) and
 * SET `setEnv = credential`, failing fast when engaged with no credential.
 *
 * The specs below are exactly what `@agentproto/runtime`'s `resolveAuthSpec`
 * produces for claude-code — a BYTE-IDENTICAL scrub set to #312 in each mode
 * (the resolver side of that equivalence is asserted in the runtime's
 * spawn-defaults test; here we lock in that the driver reproduces the #312
 * spawn env from those specs). Mirrors `claude-code-permission-mode.test.ts`
 * and claude-sdk's `gateway-modes.test.ts` — no real CLI is spawned.
 */

const spawnCalls: Array<{ bin: string; args: string[]; env: Record<string, string> }> = []

function fakeChild(): ChildProcess {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
  } as unknown as ChildProcess
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: vi.fn((bin: string, args: string[], opts: { env: Record<string, string> }) => {
      spawnCalls.push({ bin, args, env: opts.env })
      return fakeChild()
    }),
  }
})

vi.mock("@agentproto/acp/client", () => ({
  createAcpClient: vi.fn(async () => ({
    agentCapabilities: {},
    async newSession() {
      return { sessionId: "sess-1" }
    },
    async loadSession(params: { sessionId: string }) {
      return { sessionId: params.sessionId }
    },
  })),
}))

const { defineAgentCli, createAgentCliRuntime } = await import("../define-agent-cli.js")
import { RuntimeConfigError } from "../manifest/compose.js"
import type { AgentCliDefinition, ResolvedAuthSpec } from "../types.js"

// The subscription-mode scrub the runtime resolver derives for claude-code:
// providerEnvVar("anthropic")=ANTHROPIC_API_KEY (the non-set credential) +
// conflictEnv (ANTHROPIC_AUTH_TOKEN) + unsetEnvAdd (cloud toggles +
// ANTHROPIC_BASE_URL). Byte-identical SET to #312's subscription.unset_env.
const CC_SUBSCRIPTION_UNSET = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "ANTHROPIC_BASE_URL",
]
// The api-key-mode scrub: the subscription-family creds (CLAUDE_CODE_OAUTH_TOKEN
// setEnv + ANTHROPIC_AUTH_TOKEN conflict), NOT the gateway hygiene. Byte-
// identical SET to #312's api_key.unset_env.
const CC_APIKEY_UNSET = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]

interface SpecOpts {
  credential?: string
  explicit?: boolean
  neitherConfigured?: boolean
  ignoredApiKeyInStore?: boolean
}

/** claude-code's resolved subscription spec (enforce "always"). */
function subSpec(opts: SpecOpts): ResolvedAuthSpec {
  return {
    mode: "subscription",
    ...(opts.credential !== undefined ? { credential: opts.credential } : {}),
    setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    unsetEnv: CC_SUBSCRIPTION_UNSET,
    explicit: opts.explicit ?? true,
    enforce: "always",
    ...(opts.neitherConfigured ? { neitherConfigured: true } : {}),
    ...(opts.ignoredApiKeyInStore ? { ignoredApiKeyInStore: true } : {}),
  }
}

/** claude-code's resolved api-key spec (enforce "always"). */
function apiKeySpec(opts: SpecOpts): ResolvedAuthSpec {
  return {
    mode: "api-key",
    ...(opts.credential !== undefined ? { credential: opts.credential } : {}),
    setEnv: "ANTHROPIC_API_KEY",
    unsetEnv: CC_APIKEY_UNSET,
    explicit: opts.explicit ?? true,
    enforce: "always",
    ...(opts.neitherConfigured ? { neitherConfigured: true } : {}),
    ...(opts.ignoredApiKeyInStore ? { ignoredApiKeyInStore: true } : {}),
  }
}

const claudeCodeLike = (): AgentCliDefinition => ({
  name: "claude-code",
  id: "claude-code",
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  install: [{ method: "npm", package: "@agentclientprotocol/claude-agent-acp" }],
  version_check: { cmd: "npm view x", parse: "(\\d+)", range: ">=0.0.0" },
  auth: {
    ref: "./SECRETS.md",
    state: { env: ["ANTHROPIC_API_KEY"] },
  },
  provider: "anthropic",
  authEnforce: "always",
  authSubscription: {
    setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
    unsetEnvAdd: [
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
      "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_USE_GATEWAY",
      "ANTHROPIC_BASE_URL",
    ],
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./claude-code-acp.ACP.md",
  modes: [
    {
      id: "moonshot",
      env: { ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic" },
      env_unset: ["ANTHROPIC_API_KEY"],
    },
  ],
})

describe("claude-code auth — mechanical resolved-spec application", () => {
  beforeEach(() => {
    spawnCalls.length = 0
  })

  it("subscription: SETS CLAUDE_CODE_OAUTH_TOKEN and DELETES ANTHROPIC_API_KEY + ANTHROPIC_AUTH_TOKEN, even when stray creds are present in the parent env", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    const prevKey = process.env.ANTHROPIC_API_KEY
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-LEAKED"
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat01-STALE"
    try {
      await runtime.start({
        cwd: "/scratch",
        auth: subSpec({ credential: "sk-ant-oat01-real-token" }),
      })
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevKey
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
      else process.env.ANTHROPIC_AUTH_TOKEN = prevToken
    }
    expect(spawnCalls[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-real-token")
    expect(spawnCalls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(spawnCalls[0]!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it("subscription also deletes the cloud-provider toggles and ANTHROPIC_BASE_URL", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    const prevBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
    const prevBaseUrl = process.env.ANTHROPIC_BASE_URL
    process.env.CLAUDE_CODE_USE_BEDROCK = "1"
    process.env.ANTHROPIC_BASE_URL = "https://leaked.example/anthropic"
    try {
      await runtime.start({
        cwd: "/scratch",
        auth: subSpec({ credential: "sk-ant-oat01-real-token" }),
      })
    } finally {
      if (prevBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
      else process.env.CLAUDE_CODE_USE_BEDROCK = prevBedrock
      if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = prevBaseUrl
    }
    expect(spawnCalls[0]!.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(spawnCalls[0]!.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it("api-key: SETS ANTHROPIC_API_KEY and DELETES ANTHROPIC_AUTH_TOKEN + CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN
    const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat01-LEAKED"
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-LEAKED-OAUTH"
    try {
      await runtime.start({
        cwd: "/scratch",
        auth: apiKeySpec({ credential: "sk-ant-api03-real-key" }),
      })
    } finally {
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
      else process.env.ANTHROPIC_AUTH_TOKEN = prevToken
      if (prevOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth
    }
    expect(spawnCalls[0]!.env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-real-key")
    expect(spawnCalls[0]!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(spawnCalls[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it("fail-fast: an engaged subscription spec with no credential refuses the spawn — no fallback, no exec (claude-code unconfigured, enforce=always)", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    const prevKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-ambient"
    try {
      // enforce="always" engages even when the operator configured nothing
      // (explicit:false) — the resolver's unconfigured-claude-code spec.
      await expect(
        runtime.start({ cwd: "/scratch", auth: subSpec({ explicit: false }) }),
      ).rejects.toThrow(RuntimeConfigError)
      await expect(
        runtime.start({ cwd: "/scratch", auth: subSpec({}) }),
      ).rejects.toThrow(/run `claude setup-token`/)
      expect(spawnCalls).toHaveLength(0)
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevKey
    }
  })

  it("fail-fast: an engaged api-key spec with no credential refuses the spawn and does not fall back to subscription", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await expect(
      runtime.start({ cwd: "/scratch", auth: apiKeySpec({}) }),
    ).rejects.toThrow(RuntimeConfigError)
    expect(spawnCalls).toHaveLength(0)
  })

  it("fail-fast: neitherConfigured names BOTH auth paths + the config.json block, never claims subscription was chosen", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await expect(
      runtime.start({
        cwd: "/scratch",
        auth: subSpec({ explicit: false, neitherConfigured: true }),
      }),
    ).rejects.toThrow(
      /claude setup-token.*agentproto auth provider set anthropic.*defaults.*claude-code.*auth.*mode/s,
    )
    expect(spawnCalls).toHaveLength(0)
  })

  it("fail-fast: ignoredApiKeyInStore adds the 'already have a key' hint", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await expect(
      runtime.start({
        cwd: "/scratch",
        auth: subSpec({ explicit: false, neitherConfigured: true, ignoredApiKeyInStore: true }),
      }),
    ).rejects.toThrow(/providers\.json already has a stored key for anthropic — ignored until that block exists/)
    expect(spawnCalls).toHaveLength(0)
  })

  it("fail-fast: api-key mode with no credential (not neitherConfigured) keeps the mode-specific message + config.json block", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await expect(
      runtime.start({ cwd: "/scratch", auth: apiKeySpec({}) }),
    ).rejects.toThrow(/agentproto auth provider set anthropic.*defaults.*claude-code.*auth.*mode/s)
  })

  it("does not scrub ANTHROPIC_BASE_URL when a gateway mode explicitly sets it", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({
      cwd: "/scratch",
      config: { mode: "moonshot" },
      auth: subSpec({ credential: "sk-ant-oat01-real-token" }),
    })
    expect(spawnCalls[0]!.env.ANTHROPIC_BASE_URL).toBe(
      "https://api.moonshot.ai/anthropic",
    )
  })

  it("does not engage — and does not scrub — when no auth spec is passed (ambient preserved)", async () => {
    const handle = defineAgentCli({
      ...claudeCodeLike(),
      id: "hermes",
      name: "hermes",
      provider: "openrouter",
      authEnforce: undefined,
      authSubscription: undefined,
    })
    const runtime = createAgentCliRuntime(handle)
    const prevKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-ambient"
    try {
      await runtime.start({ cwd: "/scratch" })
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevKey
    }
    expect(spawnCalls[0]!.env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-ambient")
  })

  it("does not engage a when-configured spec that the operator did not configure (explicit=false) — ambient preserved", async () => {
    const handle = defineAgentCli({
      ...claudeCodeLike(),
      id: "codex",
      name: "codex",
      provider: "openai",
      authEnforce: undefined,
      authSubscription: undefined,
    })
    const runtime = createAgentCliRuntime(handle)
    const prevKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-proj-ambient"
    try {
      // A resolved spec exists (provider resolved) but enforce="when-configured"
      // + explicit=false ⇒ the driver must NOT engage.
      await runtime.start({
        cwd: "/scratch",
        auth: {
          mode: "api-key",
          setEnv: "OPENAI_API_KEY",
          unsetEnv: [],
          explicit: false,
          enforce: "when-configured",
        },
      })
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
    }
    expect(spawnCalls[0]!.env.OPENAI_API_KEY).toBe("sk-proj-ambient")
  })
})
