import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ChildProcess } from "node:child_process"

/**
 * `AgentCliDefinition.systemPrompt` — the four `via` channels the driver
 * applies to `start({ appendSystemPrompt })`: `acp-meta` (ACP `_meta` on
 * newSession AND loadSession), `inline-config` (file-list and text shapes,
 * layered into the CLI's inline JSON config env var), `argv` (the flag on
 * the child's own spawn args) and `env-file` (the text written to a file
 * whose absolute path lands in the declared env var).
 */

const spawnCalls: Array<{ args: string[]; env: Record<string, string> }> = []
const acpCalls = vi.hoisted(() => ({
  newSession: [] as Array<Record<string, unknown>>,
  loadSession: [] as Array<Record<string, unknown>>,
}))

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
    spawn: vi.fn((_bin: string, args: string[], opts: { env: Record<string, string> }) => {
      spawnCalls.push({ args, env: opts.env })
      return fakeChild()
    }),
  }
})

vi.mock("@agentproto/acp/client", () => ({
  createAcpClient: vi.fn(async () => ({
    agentCapabilities: {},
    async close() {},
    async newSession(params: Record<string, unknown>) {
      acpCalls.newSession.push(params)
      return { sessionId: "sess-1", async close() {} }
    },
    async loadSession(params: Record<string, unknown>) {
      acpCalls.loadSession.push(params)
      return { sessionId: params.sessionId, async close() {} }
    },
    async setSessionConfigOption() {
      return {}
    },
  })),
}))

const { defineAgentCli, createAgentCliRuntime } = await import("../define-agent-cli.js")
import type { AgentCliDefinition, AgentCliSmallModel } from "../types.js"

const FREE = "opencode/step-5-preview-free"

const smallModel: AgentCliSmallModel = {
  env: "OPENCODE_CONFIG_CONTENT",
  key: "small_model",
  option: "small_model",
  userConfig: { fileEnv: ["OPENCODE_CONFIG"], dirEnv: ["OPENCODE_CONFIG_DIR"] },
}

function acpLike(systemPrompt: AgentCliDefinition["systemPrompt"]): AgentCliDefinition {
  return {
    name: "test-acp",
    id: "test-acp",
    description: "test double",
    version: "0.1.0",
    bin: "npx",
    bin_args: ["-y", "test-acp-wrapper"],
    install: [{ method: "npm", package: "test-acp-wrapper" }],
    version_check: { cmd: "test-acp --version", parse: "(\\d+)", range: ">=0.0.0" },
    sandbox: "./SANDBOX.md",
    protocol: "acp",
    acp: "./test-acp.ACP.md",
    ...(systemPrompt ? { systemPrompt } : {}),
  }
}

const opencodeLike = (): AgentCliDefinition => ({
  ...acpLike({
    via: "inline-config",
    env: "OPENCODE_CONFIG_CONTENT",
    key: "instructions",
    shape: "file-list",
  }),
  id: "opencode",
  bin_args: ["-y", "opencode-ai", "acp"],
  smallModel,
  modes: [
    {
      id: "lean",
      kind: "context",
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { agentproto: { enabled: false } } }) },
    },
  ],
  options: [{ id: "model", type: "string" }],
})

const codexLike = (): AgentCliDefinition => ({
  ...acpLike({
    via: "inline-config",
    env: "CODEX_CONFIG",
    key: "developer_instructions",
    shape: "text",
  }),
  id: "codex",
  bin_args: ["-y", "@agentclientprotocol/codex-acp"],
})

describe("system-prompt channel at spawn", () => {
  let base: string
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    spawnCalls.length = 0
    acpCalls.newSession.length = 0
    acpCalls.loadSession.length = 0
    base = mkdtempSync(join(tmpdir(), "agent-cli-system-prompt-"))
    for (const k of [
      "HOME",
      "XDG_CONFIG_HOME",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_CONTENT",
      "CODEX_CONFIG",
      "AGENTPROTO_SYSTEM_PROMPT_FILE",
    ]) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    process.env.HOME = base
    process.env.XDG_CONFIG_HOME = join(base, ".config")
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(base, { recursive: true, force: true })
  })

  describe("via acp-meta", () => {
    it("sends _meta.systemPrompt.append on newSession", async () => {
      const runtime = createAgentCliRuntime(defineAgentCli(acpLike({ via: "acp-meta" })))
      await runtime.start({ cwd: base, appendSystemPrompt: "AGENT.md text" })
      expect(acpCalls.newSession).toHaveLength(1)
      expect(acpCalls.newSession[0]!.meta).toEqual({ systemPrompt: { append: "AGENT.md text" } })
      expect(acpCalls.loadSession).toHaveLength(0)
    })

    it("sends the same _meta on loadSession (native resume re-reads it)", async () => {
      const runtime = createAgentCliRuntime(defineAgentCli(acpLike({ via: "acp-meta" })))
      await runtime.start({
        cwd: base,
        appendSystemPrompt: "AGENT.md text",
        resumeSessionId: "sess-1",
      })
      expect(acpCalls.loadSession).toHaveLength(1)
      expect(acpCalls.loadSession[0]!.meta).toEqual({ systemPrompt: { append: "AGENT.md text" } })
      expect(acpCalls.newSession).toHaveLength(0)
    })

    it("sends no _meta at all without the text", async () => {
      const runtime = createAgentCliRuntime(defineAgentCli(acpLike({ via: "acp-meta" })))
      await runtime.start({ cwd: base })
      expect(acpCalls.newSession[0]!.meta).toBeUndefined()
    })
  })

  describe("via inline-config, shape file-list", () => {
    it("keeps the existing inline config keys and appends the prompt file path to `instructions`", async () => {
      const configDir = join(base, "session-config")
      const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
      await runtime.start({
        cwd: base,
        configDir,
        appendSystemPrompt: "AGENT.md text",
        config: { mode: "lean", options: { model: FREE } },
      })
      const inline = JSON.parse(spawnCalls[0]!.env.OPENCODE_CONFIG_CONTENT!)
      expect(inline).toEqual({
        mcp: { agentproto: { enabled: false } },
        small_model: FREE,
        instructions: [join(configDir, "agentproto-system-prompt.md")],
      })
      expect(readFileSync(join(configDir, "agentproto-system-prompt.md"), "utf8")).toBe("AGENT.md text")
    })

    it("extends an instructions array the host already set", async () => {
      const configDir = join(base, "session-config")
      const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
      await runtime.start({
        cwd: base,
        configDir,
        appendSystemPrompt: "AGENT.md text",
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ["/repo/AGENTS.md"] }) },
      })
      const inline = JSON.parse(spawnCalls[0]!.env.OPENCODE_CONFIG_CONTENT!)
      expect(inline.instructions).toEqual(["/repo/AGENTS.md", join(configDir, "agentproto-system-prompt.md")])
    })

    it("without a config dir, writes the file to a private temp dir (the text is never dropped)", async () => {
      const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
      await runtime.start({ cwd: base, appendSystemPrompt: "AGENT.md text" })
      const inline = JSON.parse(spawnCalls[0]!.env.OPENCODE_CONFIG_CONTENT!) as { instructions: string[] }
      expect(inline.instructions).toHaveLength(1)
      expect(readFileSync(inline.instructions[0]!, "utf8")).toBe("AGENT.md text")
    })
  })

  describe("via inline-config, shape text", () => {
    it("joins the text after an existing developer_instructions string, keeping every other key", async () => {
      const runtime = createAgentCliRuntime(defineAgentCli(codexLike()))
      await runtime.start({
        cwd: base,
        appendSystemPrompt: "AGENT.md text",
        env: {
          CODEX_CONFIG: JSON.stringify({
            model: "gpt-5",
            developer_instructions: "Existing developer note.",
          }),
        },
      })
      const inline = JSON.parse(spawnCalls[0]!.env.CODEX_CONFIG!)
      expect(inline).toEqual({
        model: "gpt-5",
        developer_instructions: "Existing developer note.\n\nAGENT.md text",
      })
    })

    it("sets the key outright when the config carries none, and needs no config dir", async () => {
      const runtime = createAgentCliRuntime(defineAgentCli(codexLike()))
      await runtime.start({ cwd: base, appendSystemPrompt: "AGENT.md text" })
      expect(JSON.parse(spawnCalls[0]!.env.CODEX_CONFIG!)).toEqual({
        developer_instructions: "AGENT.md text",
      })
    })

    it("warns when the existing value is not a JSON object, leaving it untouched", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const runtime = createAgentCliRuntime(defineAgentCli(codexLike()))
        await runtime.start({ cwd: base, appendSystemPrompt: "AGENT.md text", env: { CODEX_CONFIG: "not json" } })
        expect(spawnCalls[0]!.env.CODEX_CONFIG).toBe("not json")
        expect(warn.mock.calls.map(c => String(c[0])).join("\n")).toMatch(/CODEX_CONFIG is not a JSON object.*not delivered/)
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe("via argv", () => {
    it("appends the flag + text to the child's spawn args", async () => {
      const runtime = createAgentCliRuntime(
        defineAgentCli(acpLike({ via: "argv", flag: "--append-system-prompt" })),
      )
      await runtime.start({ cwd: base, appendSystemPrompt: "AGENT.md text" })
      expect(spawnCalls[0]!.args.slice(-2)).toEqual(["--append-system-prompt", "AGENT.md text"])
      // argv is the whole channel for this adapter — the ACP arm must NOT
      // also send `_meta`.
      expect(acpCalls.newSession[0]!.meta).toBeUndefined()
    })

    it("leaves the args untouched without the text", async () => {
      const runtime = createAgentCliRuntime(
        defineAgentCli(acpLike({ via: "argv", flag: "--append-system-prompt" })),
      )
      await runtime.start({ cwd: base })
      expect(spawnCalls[0]!.args).not.toContain("--append-system-prompt")
      expect(spawnCalls[0]!.args).toContain("test-acp-wrapper")
    })
  })

  describe("via env-file", () => {
    const envFileLike = (): AgentCliDefinition => ({
      ...acpLike({
        via: "env-file",
        env: "AGENTPROTO_SYSTEM_PROMPT_FILE",
        maxChars: 7500,
      }),
      id: "hermes-like",
      bin_args: ["-y", "hermes-like", "acp"],
    })

    it("writes the text to the session config dir and points the env var at the file's absolute path", async () => {
      const configDir = join(base, "session-config")
      const runtime = createAgentCliRuntime(defineAgentCli(envFileLike()))
      await runtime.start({ cwd: base, configDir, appendSystemPrompt: "AGENT.md text" })
      const file = spawnCalls[0]!.env.AGENTPROTO_SYSTEM_PROMPT_FILE!
      expect(file).toBe(join(configDir, "agentproto-system-prompt.md"))
      expect(readFileSync(file, "utf8")).toBe("AGENT.md text")
    })

    it("without a config dir, writes to a private temp dir that is removed on close", async () => {
      const runtime = createAgentCliRuntime(defineAgentCli(envFileLike()))
      const session = await runtime.start({ cwd: base, appendSystemPrompt: "AGENT.md text" })
      const file = spawnCalls[0]!.env.AGENTPROTO_SYSTEM_PROMPT_FILE!
      expect(readFileSync(file, "utf8")).toBe("AGENT.md text")
      const tmpDir = dirname(file)
      await session.close()
      expect(existsSync(tmpDir)).toBe(false)
    })

    it("sets no env var without the text", async () => {
      const runtime = createAgentCliRuntime(defineAgentCli(envFileLike()))
      await runtime.start({ cwd: base })
      expect(spawnCalls[0]!.env.AGENTPROTO_SYSTEM_PROMPT_FILE).toBeUndefined()
    })
  })
})
