import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"

/**
 * Regression coverage for the driver's MECHANICAL application of a FILE-BASED
 * (external) subscription spec — the codex/gemini "use my existing login" path
 * (see `ResolvedAuthSpec.externalCredential` in types.ts and the engage block
 * in `define-agent-cli.ts`).
 *
 * The contract, and the money-safety invariant this file locks in: an external
 * subscription injects NOTHING (no setEnv, no credential) — it ONLY scrubs the
 * api-key vars so a stray OPENAI_API_KEY / CODEX_API_KEY can't silently flip the
 * spawn to per-token API billing. Because no bearer is ever written into any env
 * var, an OAuth token can never land in an api-key channel. The spec below is
 * exactly what `@agentproto/runtime`'s `resolveAuthSpec` produces for codex.
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
import type { AgentCliDefinition, ResolvedAuthSpec } from "../types.js"

// The scrub the runtime resolver derives for a codex external subscription:
// providerEnvVar("openai")=OPENAI_API_KEY (the provider api-key var) +
// conflictEnv (CODEX_API_KEY). No setEnv — the CLI reads ~/.codex/auth.json.
const CODEX_EXTERNAL_UNSET = ["OPENAI_API_KEY", "CODEX_API_KEY"]

/** codex's resolved external-subscription spec (enforce "when-configured"). */
function externalSpec(opts: { explicit?: boolean } = {}): ResolvedAuthSpec {
  return {
    mode: "subscription",
    setEnv: "",
    externalCredential: true,
    unsetEnv: CODEX_EXTERNAL_UNSET,
    explicit: opts.explicit ?? true,
    enforce: "when-configured",
  }
}

const codexLike = (): AgentCliDefinition => ({
  name: "codex",
  id: "codex",
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@agentclientprotocol/codex-acp"],
  install: [{ method: "npm", package: "@agentclientprotocol/codex-acp" }],
  version_check: { cmd: "npm view x", parse: "(\\d+)", range: ">=0.0.0" },
  auth: {
    ref: "./SECRETS.md",
    state: { env: ["OPENAI_API_KEY", "CODEX_API_KEY"] },
  },
  provider: "openai",
  authSubscription: {
    external: true,
    conflictEnv: ["CODEX_API_KEY"],
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./codex-acp.ACP.md",
})

describe("codex external subscription — mechanical resolved-spec application", () => {
  beforeEach(() => {
    spawnCalls.length = 0
  })

  it("engages: SCRUBS OPENAI_API_KEY + CODEX_API_KEY and SETS no credential env, even when both are present in the parent env", async () => {
    const handle = defineAgentCli(codexLike())
    const runtime = createAgentCliRuntime(handle)
    const prevOpenai = process.env.OPENAI_API_KEY
    const prevCodex = process.env.CODEX_API_KEY
    process.env.OPENAI_API_KEY = "sk-openai-LEAKED"
    process.env.CODEX_API_KEY = "sk-codex-LEAKED"
    try {
      await runtime.start({ cwd: "/scratch", auth: externalSpec() })
    } finally {
      if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevOpenai
      if (prevCodex === undefined) delete process.env.CODEX_API_KEY
      else process.env.CODEX_API_KEY = prevCodex
    }
    // Both api-key vars scrubbed — no silent api-key billing under a
    // "subscription" label.
    expect(spawnCalls[0]!.env.OPENAI_API_KEY).toBeUndefined()
    expect(spawnCalls[0]!.env.CODEX_API_KEY).toBeUndefined()
    // Money-safety: NOTHING was injected — no empty-named env var, no bearer.
    expect(spawnCalls[0]!.env[""]).toBeUndefined()
    expect(Object.values(spawnCalls[0]!.env)).not.toContain("sk-openai-LEAKED")
  })

  it("does NOT fail-fast on the missing credential — an external subscription deliberately has none", async () => {
    const handle = defineAgentCli(codexLike())
    const runtime = createAgentCliRuntime(handle)
    // No credential on the spec, yet the spawn proceeds (unlike a bearer
    // subscription, which would throw missing_auth_credential here).
    await expect(
      runtime.start({ cwd: "/scratch", auth: externalSpec() }),
    ).resolves.toBeDefined()
    expect(spawnCalls).toHaveLength(1)
  })

  it("does not engage when-configured + not explicit ⇒ ambient preserved (codex uses its own auth.json)", async () => {
    const handle = defineAgentCli(codexLike())
    const runtime = createAgentCliRuntime(handle)
    const prevOpenai = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-openai-AMBIENT"
    try {
      await runtime.start({ cwd: "/scratch", auth: externalSpec({ explicit: false }) })
    } finally {
      if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevOpenai
    }
    // Not engaged → the scrub never runs → ambient key survives for codex's own
    // precedence to consider.
    expect(spawnCalls[0]!.env.OPENAI_API_KEY).toBe("sk-openai-AMBIENT")
  })
})
