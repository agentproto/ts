import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"

/**
 * `credentialDataHome`: an engaged credential spawns the CLI in a login-less
 * data dir, so a stored console login can't override the injected credential
 * (opencode's `account` row re-points providers at its active org otherwise).
 */

const spawnCalls: Array<{ bin: string; args: string[]; env: Record<string, string> }> = []

function fakeChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
  }) as unknown as ChildProcess
  queueMicrotask(() => child.emit("spawn"))
  return child
}

vi.mock("node:child_process", async importOriginal => {
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
  })),
}))

const { defineAgentCli, createAgentCliRuntime } = await import("../define-agent-cli.js")
import type { AgentCliDefinition, ResolvedAuthSpec } from "../types.js"
import { agentCliFrontmatterSchema } from "../schema.js"

const opencodeLike = (): AgentCliDefinition => ({
  name: "opencode",
  id: "opencode",
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "opencode-ai", "acp"],
  install: [{ method: "npm", package: "opencode-ai" }],
  version_check: { cmd: "opencode --version", parse: "(\\d+)", range: ">=0.0.0" },
  auth: { ref: "./SECRETS.md", state: { env: ["OPENCODE_API_KEY"] } },
  credentialDataHome: { env: "XDG_DATA_HOME" },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./opencode-acp.ACP.md",
})

const apiKeySpec = (extra: Partial<ResolvedAuthSpec> = {}): ResolvedAuthSpec => ({
  mode: "api-key",
  setEnv: "OPENCODE_API_KEY",
  credential: "k-test-credential",
  unsetEnv: ["OPENCODE_API_KEY"],
  explicit: true,
  enforce: "always",
  ...extra,
})

describe("credentialDataHome", () => {
  let base: string
  let prevData: string | undefined
  beforeEach(() => {
    spawnCalls.length = 0
    base = mkdtempSync(join(tmpdir(), "agent-cli-cdh-"))
    prevData = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = "/operator/real/data"
  })
  afterEach(() => {
    if (prevData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevData
    rmSync(base, { recursive: true, force: true })
  })

  it("points the data home at <configDir>/auth-data when a credential is engaged", async () => {
    const configDir = join(base, "sess_1")
    const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
    await runtime.start({ cwd: "/scratch", configDir, auth: apiKeySpec() })
    expect(spawnCalls[0]!.env.XDG_DATA_HOME).toBe(join(configDir, "auth-data"))
    expect(existsSync(join(configDir, "auth-data"))).toBe(true)
    expect(spawnCalls[0]!.env.OPENCODE_API_KEY).toBe("k-test-credential")
  })

  it("keeps the ambient data home when the spec opts out with isolateDataHome:false", async () => {
    const configDir = join(base, "sess_optout")
    const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
    await runtime.start({ cwd: "/scratch", configDir, auth: apiKeySpec({ isolateDataHome: false }) })
    expect(spawnCalls[0]!.env.XDG_DATA_HOME).toBe("/operator/real/data")
    expect(existsSync(join(configDir, "auth-data"))).toBe(false)
    expect(spawnCalls[0]!.env.OPENCODE_API_KEY).toBe("k-test-credential")
  })

  it("falls back to a throwaway dir when the host keys no configDir — never the operator's real data home", async () => {
    const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
    await runtime.start({ cwd: "/scratch", auth: apiKeySpec() })
    const dir = spawnCalls[0]!.env.XDG_DATA_HOME!
    expect(dir).not.toBe("/operator/real/data")
    expect(dir.startsWith(tmpdir()) || dir.includes("agentproto-data-")).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("applies the spec's extraEnv alongside the credential", async () => {
    const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
    await runtime.start({
      cwd: "/scratch",
      configDir: join(base, "sess_2"),
      auth: apiKeySpec({ setEnv: "OPENCODE_CONSOLE_TOKEN", extraEnv: { OPENCODE_CONFIG_CONTENT: "{}" } }),
    })
    const env = spawnCalls[0]!.env
    expect(env.OPENCODE_CONSOLE_TOKEN).toBe("k-test-credential")
    expect(env.OPENCODE_CONFIG_CONTENT).toBe("{}")
  })

  it("deep-merges the credential's inline config over a mode's own config under the same key; ambient env is never merged", async () => {
    const withMode = defineAgentCli({
      ...opencodeLike(),
      modes: [
        {
          id: "lean",
          kind: "context",
          env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { agentproto: { enabled: false } } }) },
        },
      ],
    })
    const runtime = createAgentCliRuntime(withMode)
    await runtime.start({
      cwd: "/scratch",
      configDir: join(base, "sess_4"),
      contextProfile: "lean",
      auth: apiKeySpec({
        setEnv: "OPENCODE_CONSOLE_TOKEN",
        extraEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { "opencode-go": { options: { a: 1 } } } }) },
      }),
    })
    expect(JSON.parse(spawnCalls[0]!.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      mcp: { agentproto: { enabled: false } },
      provider: { "opencode-go": { options: { a: 1 } } },
    })

    spawnCalls.length = 0
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ambient: true })
    try {
      await createAgentCliRuntime(defineAgentCli(opencodeLike())).start({
        cwd: "/scratch",
        configDir: join(base, "sess_5"),
        auth: apiKeySpec({ extraEnv: { OPENCODE_CONFIG_CONTENT: "{\"provider\":{}}" } }),
      })
      expect(spawnCalls[0]!.env.OPENCODE_CONFIG_CONTENT).toBe('{"provider":{}}')
    } finally {
      delete process.env.OPENCODE_CONFIG_CONTENT
    }
  })

  it("leaves the data home alone when no credential is engaged (ambient)", async () => {
    const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
    await runtime.start({ cwd: "/scratch", configDir: join(base, "sess_3") })
    expect(spawnCalls[0]!.env.XDG_DATA_HOME).toBe("/operator/real/data")
  })

  it("is accepted by the frontmatter schema and rejects a non-env-var name", () => {
    const ok = agentCliFrontmatterSchema.safeParse(opencodeLike())
    expect(ok.success).toBe(true)
    const bad = agentCliFrontmatterSchema.safeParse({
      ...opencodeLike(),
      credentialDataHome: { env: "lower-case" },
    })
    expect(bad.success).toBe(false)
  })
})
