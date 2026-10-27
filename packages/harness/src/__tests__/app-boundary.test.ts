import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { readFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import { resolveCommandSandbox } from "@agentproto/command-sandbox"
import type { AgentCliDefinition } from "../types.js"
import { hostContextExcludes } from "../host-context.js"
import { wrapAgentCliSpawn } from "../command-sandbox-wrap.js"

/**
 * App boundary (fs zones + isolated host context) at the driver seam. Spawns
 * no real CLI: locks in the settings.json the claude-code child is handed and
 * the sandbox wrap of its argv.
 */

const spawnCalls: Array<{ bin: string; args: string[]; env: Record<string, string> }> = []

// A real EventEmitter (not a plain object) so `spawned.once("spawn"|"error", ...)`
// in define-agent-cli.ts's spawn guard works — emits "spawn" on the next
// microtask, mirroring a real ChildProcess's async success signal.
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
  modes: [
    { id: "default", description: "Standard interactive mode." },
    { id: "lean", description: "Lean context.", kind: "context", env: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" } },
    { id: "plan", description: "Plan-only.", bin_args_append: ["--permission-mode", "plan"] },
    {
      id: "bypass-permissions",
      description: "Skip prompts.",
      bin_args_append: ["--permission-mode", "bypassPermissions"],
    },
  ],
})


const backendAvailable = resolveCommandSandbox() !== null

describe("app boundary: claude-code isolated settings", () => {
  let prevConfigDir: string | undefined
  let base: string
  beforeEach(() => {
    spawnCalls.length = 0
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    base = realpathSync(mkdtempSync(join(tmpdir(), "agent-cli-boundary-")))
  })
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
    rmSync(base, { recursive: true, force: true })
  })

  it("isolateHostContext excludes every ancestor's CLAUDE.md but not the cwd's own", async () => {
    const app = join(base, "monorepo", "apps", "yt")
    mkdirSync(app, { recursive: true })
    const runtime = createAgentCliRuntime(defineAgentCli(claudeCodeLike()))
    await runtime.start({ cwd: app, isolateHostContext: true })

    const configDir = spawnCalls[0]!.env.CLAUDE_CONFIG_DIR!
    const settings = JSON.parse(readFileSync(`${configDir}/settings.json`, "utf8"))
    const excludes: string[] = settings.claudeMdExcludes
    expect(excludes).toContain(`${join(base, "monorepo")}/CLAUDE.md`)
    expect(excludes).toContain(`${join(base, "monorepo", "apps")}/CLAUDE.local.md`)
    expect(excludes).toContain(`${join(base, "monorepo")}/.claude/rules/**`)
    expect(excludes).toContain("/CLAUDE.md")
    expect(excludes.some(e => e.startsWith(`${app}/`))).toBe(false)
  })

  it("does not write claudeMdExcludes unless isolation was requested", async () => {
    const runtime = createAgentCliRuntime(defineAgentCli(claudeCodeLike()))
    await runtime.start({ cwd: base })
    const configDir = spawnCalls[0]!.env.CLAUDE_CONFIG_DIR!
    expect(JSON.parse(readFileSync(`${configDir}/settings.json`, "utf8"))).toEqual({
      attribution: { commit: "", pr: "", sessionUrl: false },
    })
  })

  it.runIf(backendAvailable)(
    "fsZones registers writable zones as additionalDirectories and confines the child argv",
    async () => {
      const app = join(base, "app")
      const runWs = join(base, "runs", "r1")
      mkdirSync(app, { recursive: true })
      mkdirSync(runWs, { recursive: true })
      const runtime = createAgentCliRuntime(defineAgentCli(claudeCodeLike()))
      await runtime.start({
        cwd: app,
        fsZones: { readOnly: [], writable: [runWs] },
      })
      const call = spawnCalls[0]!
      expect(["sandbox-exec", "bwrap"]).toContain(call.bin)
      const configDir = call.env.CLAUDE_CONFIG_DIR!
      const settings = JSON.parse(readFileSync(`${configDir}/settings.json`, "utf8"))
      expect(settings.permissions).toEqual({ additionalDirectories: [runWs] })
    },
  )
})

describe("hostContextExcludes", () => {
  it("escapes glob metacharacters in directory names", () => {
    const out = hostContextExcludes("/w/a[1]/(x)/app")
    expect(out).toContain("/w/a\\[1\\]/\\(x\\)/CLAUDE.md")
  })
})

describe("wrapAgentCliSpawn with zones", () => {
  it("refuses zones combined with an explicit sandbox mode of off", async () => {
    await expect(
      wrapAgentCliSpawn("echo", [], {
        mode: "off",
        cwd: "/tmp",
        zones: { readOnly: [], writable: [] },
        label: "t",
      }),
    ).rejects.toThrow(/cannot be combined with commandSandbox "off"/)
  })

  it.runIf(backendAvailable)(
    "engages the sandbox with no explicit mode and ignores the cwd's own command-sandbox.json extras",
    async () => {
      const app = mkdtempSync(join(tmpdir(), "agent-cli-zone-cfg-"))
      try {
        mkdirSync(join(app, ".agentproto"), { recursive: true })
        writeFileSync(
          join(app, ".agentproto", "command-sandbox.json"),
          JSON.stringify({
            adapterSpawn: { mode: "off", extraWritePaths: ["/etc/evil-grant"] },
          }),
        )
        const [bin, args] = await wrapAgentCliSpawn("echo", ["hi"], {
          mode: undefined,
          cwd: app,
          zones: { readOnly: [], writable: [] },
          label: "t",
        })
        expect(["sandbox-exec", "bwrap"]).toContain(bin)
        expect(args.join(" ")).not.toContain("evil-grant")
      } finally {
        rmSync(app, { recursive: true, force: true })
      }
    },
  )
})
