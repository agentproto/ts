/**
 * Codex inside an app boundary, in a `kind: parallel` branch, end to end from
 * the workflow runner down to the agent-cli driver's spawn: the codex step
 * gets its own writable CODEX_HOME (the session's adapter config dir) with
 * only the login linked back, and the sandbox grants it. Without that codex
 * dies at startup ("failed to initialize sqlite state runtime under
 * ~/.codex", run wfrun_8f082d0d, 2026-10-08). That home also carries a
 * config.toml with `project_root_markers = []`: without it codex walks up to
 * the git root the boundary hides and aborts ("failed to load workspace
 * requirements", run wfrun_36678ac0).
 *
 * The real `createAgentCliRuntime` runs; only the child process and the ACP
 * handshake are faked, so no real codex is spawned.
 */

import { EventEmitter } from "node:events"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { compileWorkflow } from "@agentproto/workflow-runtime"
import { resolveCommandSandbox } from "@agentproto/command-sandbox"
import type { AgentCliDefinition } from "@agentproto/driver-agent-cli"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createAppRegistry } from "../app-registry.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { adapterConfigDirFor, type SessionDescriptor, type SessionsRegistry } from "../sessions.js"
import { createWorkflowRunner } from "../workflow-runner.js"

const CODEX_MARKER = "@agentclientprotocol/codex-acp"
const codexSpawns: Array<{ bin: string; args: string[]; env: Record<string, string> }> = []

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
      if (!args.includes(CODEX_MARKER)) return (actual.spawn as (...a: unknown[]) => ChildProcess)(bin, args, opts)
      codexSpawns.push({ bin, args, env: opts.env })
      return fakeChild()
    }),
  }
})

vi.mock("@agentproto/acp/client", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createAcpClient: vi.fn(async () => ({
    agentCapabilities: {},
    async newSession() {
      return { sessionId: "codex-thread-1" }
    },
  })),
}))

const { defineAgentCli, createAgentCliRuntime } = await import("@agentproto/driver-agent-cli")

/** Mirrors `adapters/codex`'s definition: the parts the spawn path reads. */
const codexDefinition = (): AgentCliDefinition => ({
  name: "codex",
  id: "codex",
  description: "test double",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", CODEX_MARKER],
  install: [{ method: "npm", package: CODEX_MARKER }],
  version_check: { cmd: "npm view x", parse: "(\\d+)", range: ">=0.0.0" },
  sandbox: "./SANDBOX.md",
  stateHome: {
    env: "CODEX_HOME",
    defaultDir: ".codex",
    share: ["auth.json"],
    seed: { "config.toml": "project_root_markers = []\n" },
  },
  protocol: "acp",
  acp: "./codex-acp.ACP.md",
})

const backendAvailable = resolveCommandSandbox() !== null

let tmp: string
let prevCodexHome: string | undefined
beforeEach(() => {
  codexSpawns.length = 0
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "app-boundary-codex-par-")))
  prevCodexHome = process.env.CODEX_HOME
})
afterEach(() => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = prevCodexHome
  rmSync(tmp, { recursive: true, force: true })
})

function fixture() {
  const bus = createSessionEventBus()
  const spawned: Array<{ id?: string; adapterSlug?: string }> = []
  const descriptors = new Map<string, SessionDescriptor>()
  const codexRuntime = createAgentCliRuntime(defineAgentCli(codexDefinition()))
  const claudeStart = vi.fn(async (_o: Record<string, unknown>) => ({
    sessionId: "claude_1",
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }))
  const resolveAgentAdapter: AgentAdapterResolver = vi.fn(async (slug: string) => ({
    startSession:
      slug === "codex"
        ? (o: Parameters<typeof codexRuntime.start>[0]) => codexRuntime.start(o)
        : claudeStart,
    commandPreview: slug,
    supportsFsZones: true,
    supportsHostContextIsolation: true,
  })) as unknown as AgentAdapterResolver
  const registry = {
    spawnAgent: vi.fn((input: { id?: string; cwd?: string; adapterSlug?: string; meta?: Record<string, string> }) => {
      spawned.push(input)
      const id = input.id ?? `sess_${spawned.length}`
      const desc = {
        id,
        kind: "agent-cli",
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running",
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
        ...(input.meta ? { meta: input.meta } : {}),
      } as SessionDescriptor
      descriptors.set(id, desc)
      return desc
    }),
    sendPrompt: vi.fn(async (sessionId: string) => {
      bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
    }),
    get: vi.fn((id: string) => descriptors.get(id)),
    kill: vi.fn(),
    archiveSession: vi.fn(),
  } as unknown as SessionsRegistry
  return { bus, registry, resolveAgentAdapter, spawned, claudeStart }
}

/** The editorial-desk revise shape: claude-code reviews beside a codex step, in parallel branches. */
function writeApp(appDir: string): string {
  const dir = join(appDir, ".agentproto", "workflows", "revise")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "WORKFLOW.md")
  writeFileSync(
    path,
    `---
name: Revise
id: revise
description: three reviews in parallel, one of them codex
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: review-in-parallel
    kind: parallel
    branches:
      - id: reader
        steps:
          - id: reader-pass-1
            kind: agent
            adapter: claude-code
            prompt: read it
      - id: facts
        steps:
          - id: fact-gate
            kind: agent
            adapter: claude-code
            prompt: check it
      - id: coherence
        steps:
          - id: coherence-check
            kind: agent
            adapter: codex
            options:
              model: gpt-5.6-sol
            prompt: check coherence
---
`,
  )
  return path
}

async function runToEnd(runner: ReturnType<typeof createWorkflowRunner>, runId: string) {
  const terminal = new Set(["done", "failed", "cancelled"])
  let s = runner.status(runId)
  for (let i = 0; i < 500 && s && !terminal.has(s.status); i++) {
    await new Promise(r => setTimeout(r, 10))
    s = runner.status(runId)
  }
  return s
}

describe("codex step in a parallel branch of an app workflow", () => {
  it.runIf(backendAvailable)(
    "spawns confined with its own writable CODEX_HOME, login linked back, real home never granted",
    async () => {
      const realCodexHome = join(tmp, "real-codex")
      mkdirSync(realCodexHome, { recursive: true })
      writeFileSync(join(realCodexHome, "auth.json"), '{"tokens":{}}')
      writeFileSync(join(realCodexHome, "config.toml"), 'model = "x"')
      process.env.CODEX_HOME = realCodexHome

      const { bus, registry, resolveAgentAdapter, spawned, claudeStart } = fixture()
      const appDir = join(tmp, "apps", "editorial-desk")
      const path = writeApp(appDir)
      const appRegistry = createAppRegistry()
      appRegistry.upsertApp({
        appId: "@test/editorial-desk",
        dir: appDir,
        dataDir: join(appDir, "data"),
        agents: [],
        workflows: [{ id: "revise", path }],
        unvalidatedAgentTools: [],
      })
      const runner = createWorkflowRunner({
        registry,
        sessionEvents: bus,
        resolveAgentAdapter,
        compileWorkflow: handle => compileWorkflow(handle, { tools: {}, candidates: [] }),
        appRegistry,
        persist: true,
        persistPath: join(tmp, "runs.json"),
        runsRoot: join(tmp, "runs"),
      })

      const run = await runner.startFromFile({ path })
      const final = await runToEnd(runner, run.runId)
      expect(final?.status, final?.error).toBe("done")

      // Both claude-code branches ran under the same boundary.
      expect(claudeStart).toHaveBeenCalledTimes(2)
      for (const [o] of claudeStart.mock.calls) expect(o).toHaveProperty("fsZones")

      // The codex branch: confined, and pointed at its own session home.
      expect(codexSpawns).toHaveLength(1)
      const call = codexSpawns[0]!
      expect(["sandbox-exec", "bwrap"]).toContain(call.bin)
      const codexSession = spawned.find(s => s.adapterSlug === "codex")
      expect(codexSession?.id).toBeDefined()
      const sessionHome = adapterConfigDirFor(codexSession!.id!)
      expect(call.env.CODEX_HOME).toBe(sessionHome)
      expect(call.env.CODEX_HOME).not.toBe(realCodexHome)

      // Only the login is linked back; the operator's config stays out of reach.
      const link = join(sessionHome, "auth.json")
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(join(realCodexHome, "auth.json"))
      // The session's own config stops codex at the cwd: the boundary hides the
      // host git root, and codex aborts reading `.codex/` layers there.
      const config = join(sessionHome, "config.toml")
      expect(lstatSync(config).isSymbolicLink()).toBe(false)
      expect(readFileSync(config, "utf8")).toBe("project_root_markers = []\n")

      // The sandbox grants the session home and the login file, never the real home.
      const argv = call.args.join("\n")
      expect(argv).toContain(join(realCodexHome, "auth.json"))
      if (call.bin === "sandbox-exec") {
        // Seatbelt matches resolved paths, so the grant is the canonical one.
        expect(argv).toContain(`(allow file-read* file-write* (subpath "${realpathSync(sessionHome)}"))`)
        expect(argv).not.toContain(`(subpath "${realCodexHome}")`)
      } else {
        expect(call.args).not.toContain(realCodexHome)
      }
    },
  )
})
