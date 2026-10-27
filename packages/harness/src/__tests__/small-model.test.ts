import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"

/**
 * `smallModel`: opencode's title/summary model is pinned to the session model
 * (on Zen its own default is a paid model, even for a `-free` session), unless
 * the inline config, an explicit option, or the user's config files set one.
 */

const spawnCalls: Array<{ env: Record<string, string> }> = []

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
    spawn: vi.fn((_bin: string, _args: string[], opts: { env: Record<string, string> }) => {
      spawnCalls.push({ env: opts.env })
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
    async setSessionConfigOption() {
      return {}
    },
  })),
}))

const { defineAgentCli, createAgentCliRuntime } = await import("../define-agent-cli.js")
const { resolveSmallModelEnv } = await import("../small-model.js")
import type { AgentCliDefinition, AgentCliSmallModel } from "../types.js"
import { agentCliFrontmatterSchema } from "../schema.js"

const decl: AgentCliSmallModel = {
  env: "OPENCODE_CONFIG_CONTENT",
  key: "small_model",
  option: "small_model",
  userConfig: {
    globalFiles: ["opencode/opencode.json", "opencode/opencode.jsonc"],
    fileEnv: ["OPENCODE_CONFIG"],
    dirEnv: ["OPENCODE_CONFIG_DIR"],
    projectFiles: ["opencode.json", "opencode.jsonc"],
    dirFiles: [".opencode/opencode.json"],
    projectDisableEnv: "OPENCODE_DISABLE_PROJECT_CONFIG",
  },
}

const FREE = "opencode/step-5-preview-free"

describe("resolveSmallModelEnv", () => {
  let base: string
  let home: string
  let cwd: string
  let env: Record<string, string>
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "agent-cli-small-"))
    home = join(base, "home")
    cwd = join(base, "repo", "pkg")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") }
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const write = (path: string, body: string) => {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, body)
  }

  it("pins the small model to the session model", () => {
    expect(resolveSmallModelEnv(decl, { model: FREE, env, cwd })).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ small_model: FREE }),
    })
  })

  it("does nothing without a declaration or a model", () => {
    expect(resolveSmallModelEnv(undefined, { model: FREE, env, cwd })).toBeUndefined()
    expect(resolveSmallModelEnv(decl, { env, cwd })).toBeUndefined()
  })

  it("merges into an inline config another layer already set", () => {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: { agentproto: { enabled: false } } })
    const out = resolveSmallModelEnv(decl, { model: FREE, env, cwd })
    expect(JSON.parse(out!.OPENCODE_CONFIG_CONTENT!)).toEqual({
      mcp: { agentproto: { enabled: false } },
      small_model: FREE,
    })
  })

  it("keeps a small_model the inline config already carries, and never rewrites non-JSON", () => {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ small_model: "opencode/other" })
    expect(resolveSmallModelEnv(decl, { model: FREE, env, cwd })).toBeUndefined()
    env.OPENCODE_CONFIG_CONTENT = "not json"
    expect(resolveSmallModelEnv(decl, { model: FREE, env, cwd })).toBeUndefined()
  })

  it("the explicit option wins over the session model", () => {
    const out = resolveSmallModelEnv(decl, {
      model: FREE,
      options: { small_model: "opencode/big-pickle" },
      env,
      cwd,
    })
    expect(JSON.parse(out!.OPENCODE_CONFIG_CONTENT!)).toEqual({ small_model: "opencode/big-pickle" })
  })

  it("leaves a small_model set in the user's global JSONC config alone", () => {
    write(join(home, ".config", "opencode", "opencode.jsonc"), '{\n  // pick\n  "small_model": "anthropic/claude-haiku-4-5",\n}')
    expect(resolveSmallModelEnv(decl, { model: FREE, env, cwd })).toBeUndefined()
  })

  it("an explicit option still beats the user's config files", () => {
    write(join(home, ".config", "opencode", "opencode.json"), '{"small_model":"anthropic/claude-haiku-4-5"}')
    const out = resolveSmallModelEnv(decl, { model: FREE, options: { small_model: FREE }, env, cwd })
    expect(JSON.parse(out!.OPENCODE_CONFIG_CONTENT!)).toEqual({ small_model: FREE })
  })

  it("honours $OPENCODE_CONFIG, $OPENCODE_CONFIG_DIR and .opencode/ dirs", () => {
    const custom = join(base, "custom.json")
    write(custom, '{"small_model":"x/y"}')
    expect(resolveSmallModelEnv(decl, { model: FREE, env: { ...env, OPENCODE_CONFIG: custom }, cwd })).toBeUndefined()

    const dir = join(base, "cfgdir")
    write(join(dir, ".opencode", "opencode.json"), '{"small_model":"x/y"}')
    expect(resolveSmallModelEnv(decl, { model: FREE, env: { ...env, OPENCODE_CONFIG_DIR: dir }, cwd })).toBeUndefined()

    write(join(base, "repo", ".opencode", "opencode.json"), '{"small_model":"x/y"}')
    expect(resolveSmallModelEnv(decl, { model: FREE, env, cwd })).toBeUndefined()
  })

  it("reads project opencode.json up the tree, unless project config is disabled", () => {
    write(join(base, "repo", "opencode.json"), '{"small_model":"x/y"}')
    expect(resolveSmallModelEnv(decl, { model: FREE, env, cwd })).toBeUndefined()
    const lean = { ...env, OPENCODE_DISABLE_PROJECT_CONFIG: "1" }
    expect(resolveSmallModelEnv(decl, { model: FREE, env: lean, cwd })).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ small_model: FREE }),
    })
  })

  it("ignores user config files that don't mention the key", () => {
    write(join(home, ".config", "opencode", "opencode.json"), '{"model":"anthropic/claude-sonnet-4-5"}')
    expect(resolveSmallModelEnv(decl, { model: FREE, env, cwd })).toBeDefined()
  })
})

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
  smallModel: decl,
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./opencode-acp.ACP.md",
  modes: [
    {
      id: "lean",
      kind: "context",
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { agentproto: { enabled: false } } }) },
    },
  ],
  options: [
    { id: "model", type: "string" },
    { id: "small_model", type: "string" },
  ],
})

describe("smallModel at spawn", () => {
  let base: string
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    spawnCalls.length = 0
    base = mkdtempSync(join(tmpdir(), "agent-cli-small-spawn-"))
    for (const k of ["HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"]) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    // An empty home, so the test never reads the operator's real opencode config.
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

  it("validates against the manifest schema", () => {
    expect(agentCliFrontmatterSchema.safeParse(opencodeLike()).success).toBe(true)
  })

  it("pins small_model to the requested model in the child's inline config", async () => {
    const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
    await runtime.start({ cwd: base, config: { options: { model: FREE } } })
    expect(JSON.parse(spawnCalls[0]!.env.OPENCODE_CONFIG_CONTENT!)).toEqual({ small_model: FREE })
  })

  it("layers it over the lean mode's inline config", async () => {
    const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
    await runtime.start({ cwd: base, contextProfile: "lean", config: { options: { model: FREE } } })
    expect(JSON.parse(spawnCalls[0]!.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      mcp: { agentproto: { enabled: false } },
      small_model: FREE,
    })
  })

  it("leaves the env alone when no model is requested", async () => {
    const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
    await runtime.start({ cwd: base })
    expect(spawnCalls[0]!.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it("a host-supplied inline small_model wins", async () => {
    const runtime = createAgentCliRuntime(defineAgentCli(opencodeLike()))
    const host = JSON.stringify({ small_model: "opencode/big-pickle" })
    await runtime.start({ cwd: base, env: { OPENCODE_CONFIG_CONTENT: host }, config: { options: { model: FREE } } })
    expect(spawnCalls[0]!.env.OPENCODE_CONFIG_CONTENT).toBe(host)
  })
})
