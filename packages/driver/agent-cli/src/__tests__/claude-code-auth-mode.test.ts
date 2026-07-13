import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"

/**
 * Regression coverage for the claude-code `auth` spawn mode (see
 * `AgentCliAuth.modes` in types.ts and the auth-mode block in
 * `define-agent-cli.ts`'s `start()`): EXPLICIT credential selection, not
 * scrub-by-absence. Each mode POSITIVELY sets exactly one credential env var
 * from the resolved `auth.credential` (never read ambiently) and deletes the
 * conflicting one(s) — so which credential a spawn uses is *stated*, never
 * inferred from whatever a leaked ambient `ANTHROPIC_API_KEY` happens to be.
 * A mode with no resolved credential fails the spawn outright (fail-fast),
 * it never falls back to another credential or an ambient one. Locks in the
 * spawn-time mechanics without spawning a real CLI — mirrors
 * `claude-code-permission-mode.test.ts` and claude-sdk's
 * `gateway-modes.test.ts`.
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
import type { AgentCliDefinition } from "../types.js"

const SUBSCRIPTION_UNSET = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_BASE_URL",
]

const claudeCodeLike = (): AgentCliDefinition => ({
  name: "claude-code",
  id: "claude-code",
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  install: [{ method: "npm", package: "@agentclientprotocol/claude-agent-acp" }],
  version_check: { cmd: "npm view x", parse: "(\\d+)", range: ">=0.0.0" },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./claude-code-acp.ACP.md",
  auth: {
    ref: "./SECRETS.md",
    state: { env: ["ANTHROPIC_API_KEY"] },
    modes: {
      subscription: {
        set_env: "ANTHROPIC_AUTH_TOKEN",
        unset_env: SUBSCRIPTION_UNSET,
      },
      api_key: {
        set_env: "ANTHROPIC_API_KEY",
        unset_env: ["ANTHROPIC_AUTH_TOKEN"],
      },
    },
  },
  modes: [
    {
      id: "moonshot",
      env: { ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic" },
      env_unset: ["ANTHROPIC_API_KEY"],
    },
  ],
})

describe("claude-code auth mode — explicit credential selection", () => {
  beforeEach(() => {
    spawnCalls.length = 0
  })

  it("subscription (default): SETS ANTHROPIC_AUTH_TOKEN and DELETES ANTHROPIC_API_KEY, even when a stray key is present in the parent env", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    const prevKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-LEAKED"
    try {
      await runtime.start({
        cwd: "/scratch",
        auth: { mode: "subscription", credential: "sk-ant-oat01-real-token" },
      })
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevKey
    }
    expect(spawnCalls[0]!.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant-oat01-real-token")
    expect(spawnCalls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined()
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
        auth: { mode: "subscription", credential: "sk-ant-oat01-real-token" },
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

  it("api-key: SETS ANTHROPIC_API_KEY and DELETES ANTHROPIC_AUTH_TOKEN", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat01-LEAKED"
    try {
      await runtime.start({
        cwd: "/scratch",
        auth: { mode: "api-key", credential: "sk-ant-api03-real-key" },
      })
    } finally {
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
      else process.env.ANTHROPIC_AUTH_TOKEN = prevToken
    }
    expect(spawnCalls[0]!.env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-real-key")
    expect(spawnCalls[0]!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it("fail-fast: subscription mode with no credential refuses the spawn — no fallback, no exec", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    const prevKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-ambient"
    try {
      await expect(
        runtime.start({ cwd: "/scratch" }),
      ).rejects.toThrow(RuntimeConfigError)
      await expect(
        runtime.start({ cwd: "/scratch", auth: { mode: "subscription" } }),
      ).rejects.toThrow(/auth mode "subscription" requires an explicit credential/)
      expect(spawnCalls).toHaveLength(0)
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevKey
    }
  })

  it("fail-fast: api-key mode with no credential refuses the spawn and does not fall back to subscription", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await expect(
      runtime.start({ cwd: "/scratch", auth: { mode: "api-key" } }),
    ).rejects.toThrow(RuntimeConfigError)
    expect(spawnCalls).toHaveLength(0)
  })

  it("does not scrub ANTHROPIC_BASE_URL when a gateway mode explicitly sets it", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({
      cwd: "/scratch",
      config: { mode: "moonshot" },
      auth: { mode: "subscription", credential: "sk-ant-oat01-real-token" },
    })
    expect(spawnCalls[0]!.env.ANTHROPIC_BASE_URL).toBe(
      "https://api.moonshot.ai/anthropic",
    )
  })

  it("does not apply the auth-mode logic for an adapter that declares no auth.modes — no fail-fast, no scrub", async () => {
    const handle = defineAgentCli({
      ...claudeCodeLike(),
      id: "hermes",
      name: "hermes",
      auth: undefined,
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
})
