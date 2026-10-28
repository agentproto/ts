import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import type { MemoryDocument } from "@agentproto/memory"

/**
 * The claude-code driver half of the AIP-72 native-dir projection: the
 * isolated settings.json pins `autoMemoryDirectory` under the config dir,
 * the items land there and nowhere else (fake HOME), and a session that
 * cannot read auto memory gets the digest on the system prompt instead.
 * No real CLI is spawned.
 */

const spawnCalls: Array<{ env: Record<string, string> }> = []
const newSessions: Array<Record<string, unknown>> = []

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
    async newSession(params: Record<string, unknown>) {
      newSessions.push(params)
      return { sessionId: "sess-1" }
    },
  })),
}))

const { defineHarness, createAgentCliRuntime } = await import("../define-agent-cli.js")
import type { AgentCliDefinition } from "../types.js"

const claudeCode = (): AgentCliDefinition => ({
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
  systemPrompt: { via: "acp-meta" },
  capabilities: { memory: { inject: "native-dir", capture: "native-dir-diff" } },
})

const items: MemoryDocument[] = [
  {
    schema: "memory/v1",
    id: "mem-cite",
    slug: "cite-sources",
    kind: "feedback",
    type: "feedback",
    title: "Cite sources",
    description: "Always cite sources",
    updated_at: "2026-10-28T10:00:00.000Z",
    body: "Always cite sources.\n",
  },
]
const DIGEST = '<agentproto-memory spec="AIP-72">\n- cite-sources\n</agentproto-memory>'

const saved: Record<string, string | undefined> = {}
let home: string
let repo: string
let configDir: string

function listTree(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    out.push(p)
    if (e.isDirectory()) out.push(...listTree(p))
  }
  return out
}

describe("claude-code native memory projection (driver)", () => {
  beforeEach(() => {
    spawnCalls.length = 0
    newSessions.length = 0
    for (const k of ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"]) saved[k] = process.env[k]
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    home = mkdtempSync(join(tmpdir(), "nm-home-"))
    process.env.HOME = home
    repo = mkdtempSync(join(tmpdir(), "nm-repo-"))
    mkdirSync(join(repo, ".git"))
    configDir = join(home, ".agentproto", "adapter-config", "sess_test")
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it("pins autoMemoryDirectory under the config dir and writes nothing outside it", async () => {
    const runtime = createAgentCliRuntime(defineHarness(claudeCode()))
    await runtime.start({ cwd: repo, configDir, memoryProjection: { items, digest: DIGEST } })

    expect(spawnCalls[0]!.env.CLAUDE_CONFIG_DIR).toBe(configDir)
    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"))
    expect(settings.autoMemoryDirectory).toBe(join(configDir, "memory"))
    expect(readFileSync(join(configDir, "memory", "MEMORY.md"), "utf8")).toContain("(agentproto_cite-sources.md)")
    expect(existsSync(join(configDir, ".agentproto-memory.json"))).toBe(true)
    // The native channel only: no system-prompt digest.
    expect(newSessions[0]!.meta).toBeUndefined()
    // Fake HOME holds the config dir and nothing else; no ~/.claude, and the
    // repo is untouched.
    const outside = listTree(home).filter(p => !p.startsWith(configDir) && !configDir.startsWith(p))
    expect(outside).toEqual([])
    expect(existsSync(join(home, ".claude"))).toBe(false)
    expect(readdirSync(repo)).toEqual([".git"])
  })

  it("re-projects idempotently on a resume of the same lineage", async () => {
    const runtime = createAgentCliRuntime(defineHarness(claudeCode()))
    await runtime.start({ cwd: repo, configDir, memoryProjection: { items, digest: DIGEST } })
    const first = readFileSync(join(configDir, "memory", "MEMORY.md"), "utf8")
    const snap = readFileSync(join(configDir, ".agentproto-memory.json"), "utf8")
    await runtime.start({ cwd: repo, configDir, memoryProjection: { items, digest: DIGEST } })
    expect(readFileSync(join(configDir, "memory", "MEMORY.md"), "utf8")).toBe(first)
    expect(readFileSync(join(configDir, ".agentproto-memory.json"), "utf8")).toBe(snap)
  })

  it("falls back to the system prompt with CLAUDE_CODE_DISABLE_AUTO_MEMORY=1", async () => {
    const runtime = createAgentCliRuntime(defineHarness(claudeCode()))
    await runtime.start({
      cwd: repo,
      configDir,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      appendSystemPrompt: "AGENT.md text",
      memoryProjection: { items, digest: DIGEST },
    })
    expect(newSessions[0]!.meta).toEqual({ systemPrompt: { append: `AGENT.md text\n\n${DIGEST}` } })
    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"))
    expect(settings.autoMemoryDirectory).toBeUndefined()
    expect(existsSync(join(configDir, "memory"))).toBe(false)
    expect(existsSync(join(configDir, ".agentproto-memory.json"))).toBe(false)
  })

  it("falls back to the system prompt when the repo pins its own autoMemoryDirectory", async () => {
    mkdirSync(join(repo, ".claude"))
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ autoMemoryDirectory: "~/elsewhere" }))
    const runtime = createAgentCliRuntime(defineHarness(claudeCode()))
    await runtime.start({ cwd: repo, configDir, memoryProjection: { items, digest: DIGEST } })
    expect(newSessions[0]!.meta).toEqual({ systemPrompt: { append: DIGEST } })
    expect(existsSync(join(configDir, "memory"))).toBe(false)
  })

  it("falls back when the repo turns auto memory off", async () => {
    mkdirSync(join(repo, ".claude"))
    writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ autoMemoryEnabled: false }))
    const runtime = createAgentCliRuntime(defineHarness(claudeCode()))
    await runtime.start({ cwd: repo, configDir, memoryProjection: { items, digest: DIGEST } })
    expect(newSessions[0]!.meta).toEqual({ systemPrompt: { append: DIGEST } })
    expect(existsSync(join(configDir, "memory"))).toBe(false)
  })

  it("leaves the settings alone without a projection", async () => {
    const runtime = createAgentCliRuntime(defineHarness(claudeCode()))
    await runtime.start({ cwd: repo, configDir })
    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"))
    expect(settings.autoMemoryDirectory).toBeUndefined()
    expect(existsSync(join(configDir, "memory"))).toBe(false)
  })
})
