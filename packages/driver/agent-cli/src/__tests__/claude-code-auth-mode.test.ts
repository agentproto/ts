import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"

/**
 * Regression coverage for the claude-code `auth` spawn mode (see
 * `AgentCliAuth.modes` in types.ts and the auth-mode block in
 * `define-agent-cli.ts`'s `start()`): a fresh `claude` child inherits the
 * daemon's env wholesale, so an ambient `ANTHROPIC_API_KEY` (e.g. leaked
 * from a `.zshrc`) would otherwise silently bill an API key instead of the
 * operator's subscription. `auth: "subscription"` (the default) scrubs the
 * billing env vars deterministically; `auth: "api-key"` requires the key
 * and fails the spawn rather than falling back silently. Locks in the
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

const BILLING_ENV_UNSET = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_AUTH_TOKEN",
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
      api_key_env: "ANTHROPIC_API_KEY",
      subscription_unset_env: BILLING_ENV_UNSET,
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

describe("claude-code auth mode", () => {
  beforeEach(() => {
    spawnCalls.length = 0
  })

  it("defaults to subscription and scrubs a leaked ANTHROPIC_API_KEY", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    const prevKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-leaked"
    try {
      await runtime.start({ cwd: "/scratch" })
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevKey
    }
    expect(spawnCalls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("subscription mode is the implicit default (no auth field at all) and scrubs the full billing set", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    const prevKey = process.env.ANTHROPIC_API_KEY
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = "sk-ant-leaked"
    process.env.ANTHROPIC_AUTH_TOKEN = "leaked-token"
    try {
      await runtime.start({ cwd: "/scratch" })
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevKey
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
      else process.env.ANTHROPIC_AUTH_TOKEN = prevToken
    }
    expect(spawnCalls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(spawnCalls[0]!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it("does not scrub ANTHROPIC_BASE_URL when a gateway mode explicitly sets it", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({ cwd: "/scratch", config: { mode: "moonshot" } })
    expect(spawnCalls[0]!.env.ANTHROPIC_BASE_URL).toBe(
      "https://api.moonshot.ai/anthropic",
    )
  })

  it("api-key mode keeps ANTHROPIC_API_KEY when present", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    await runtime.start({
      cwd: "/scratch",
      auth: "api-key",
      env: { ANTHROPIC_API_KEY: "sk-ant-real" },
    })
    expect(spawnCalls[0]!.env.ANTHROPIC_API_KEY).toBe("sk-ant-real")
  })

  it("api-key mode fails the spawn (not a silent subscription fallback) when the key is absent", async () => {
    const handle = defineAgentCli(claudeCodeLike())
    const runtime = createAgentCliRuntime(handle)
    const prevKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      await expect(
        runtime.start({ cwd: "/scratch", auth: "api-key" }),
      ).rejects.toThrow(RuntimeConfigError)
      expect(spawnCalls).toHaveLength(0)
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey
    }
  })

  it("does not apply the auth-mode scrub for an adapter that declares no auth.modes", async () => {
    const handle = defineAgentCli({
      ...claudeCodeLike(),
      id: "hermes",
      name: "hermes",
      auth: undefined,
    })
    const runtime = createAgentCliRuntime(handle)
    const prevKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-leaked"
    try {
      await runtime.start({ cwd: "/scratch" })
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevKey
    }
    expect(spawnCalls[0]!.env.ANTHROPIC_API_KEY).toBe("sk-ant-leaked")
  })
})
