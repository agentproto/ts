/**
 * App boundary (L5) through the workflow runner: an agent step of a workflow
 * owned by an installed app is spawned with fs zones — the app source
 * read-only, the run workspace (`$run.workspace`) and the app data dir
 * writable — and a workflow with no owning app is unaffected.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compileWorkflow } from "@agentproto/workflow-runtime"
import { resolveCommandSandbox } from "@agentproto/command-sandbox"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { boundaryFromMeta } from "../app-boundary.js"
import { createAppRegistry } from "../app-registry.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionDescriptor, SessionsRegistry } from "../sessions.js"
import { createWorkflowRunner } from "../workflow-runner.js"

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "app-boundary-wf-"))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function fixture(caps: { supportsFsZones?: boolean; supportsHostContextIsolation?: boolean }) {
  const bus = createSessionEventBus()
  const spawned: Array<{ cwd?: string; meta?: Record<string, string> }> = []
  const startSession = vi.fn(async (_o: Record<string, unknown>) => ({
    sessionId: "adapter_1",
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }))
  const resolveAgentAdapter: AgentAdapterResolver = vi.fn(async () => ({
    startSession,
    commandPreview: "mock",
    ...caps,
  }))
  const descriptors = new Map<string, SessionDescriptor>()
  const registry = {
    spawnAgent: vi.fn((input: { cwd?: string; meta?: Record<string, string> }) => {
      const id = `sess_${spawned.length}`
      spawned.push(input)
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
  return { bus, registry, startSession, resolveAgentAdapter, spawned }
}

function writeApp(appDir: string, workflowId: string): string {
  mkdirSync(join(appDir, ".agentproto", "workflows", workflowId), { recursive: true })
  writeFileSync(
    join(appDir, "entry.mjs"),
    `export default {
      name: "T", id: "${workflowId}", description: "d", version: "0.1.0", inputs: {}, outputs: {},
      steps: [{ id: "extract", kind: "agent", adapter: "mock", prompt: () => "go" }],
    }`,
  )
  const path = join(appDir, ".agentproto", "workflows", workflowId, "WORKFLOW.md")
  writeFileSync(
    path,
    `---
name: T
id: ${workflowId}
description: d
version: 0.1.0
entry: ../../../entry.mjs
inputs: {}
outputs: {}
steps:
  - id: extract
    kind: agent
---
`,
  )
  return path
}

async function runToEnd(runner: ReturnType<typeof createWorkflowRunner>, runId: string) {
  const terminal = new Set(["done", "failed", "cancelled"])
  let s = runner.status(runId)
  for (let i = 0; i < 300 && s && !terminal.has(s.status); i++) {
    await new Promise(r => setTimeout(r, 10))
    s = runner.status(runId)
  }
  return s
}

describe("workflow agent step of an installed app", () => {
  it("spawns with zones: app dir read-only; run workspace + data dir writable; daemon workspace hidden", async () => {
    const { bus, registry, startSession, resolveAgentAdapter, spawned } = fixture({
      supportsFsZones: true,
      supportsHostContextIsolation: true,
    })
    const appDir = join(tmp, "apps", "yt")
    const dataDir = join(appDir, "data")
    const daemonWorkspace = join(tmp, "daemon-ws")
    mkdirSync(daemonWorkspace, { recursive: true })
    const path = writeApp(appDir, "transcribe")
    const appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: "@test/yt",
      dir: appDir,
      dataDir,
      agents: [],
      workflows: [{ id: "transcribe", path }],
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
      daemonWorkspace,
    })

    const run = await runner.startFromFile({ path })
    const final = await runToEnd(runner, run.runId)
    expect(final?.status).toBe("done")

    expect(run.workspace).toBeDefined()
    const args = startSession.mock.calls[0]![0] as {
      cwd: string
      fsZones?: { readOnly: string[]; writable: string[]; hidden: string[] }
      isolateHostContext?: boolean
    }
    expect(args.cwd).toBe(appDir)
    expect(args.isolateHostContext).toBe(true)
    if (resolveCommandSandbox() !== null) {
      expect(args.fsZones?.readOnly).toEqual([appDir])
      expect(args.fsZones?.writable).toEqual([dataDir, run.workspace])
      expect(args.fsZones?.hidden).toContain(daemonWorkspace)
    }
    // The run workspace exists before the agent starts (a bubblewrap bind source must).
    expect(existsSync(run.workspace!)).toBe(true)
    // The boundary the gateway will enforce on this session's daemon tools.
    const b = boundaryFromMeta(spawned[0]!.meta)
    expect(b?.appId).toBe("@test/yt")
    expect(b?.writable).toEqual([dataDir, run.workspace])
  })

  it("a workflow no installed app owns gets no boundary", async () => {
    const { bus, registry, startSession, resolveAgentAdapter, spawned } = fixture({ supportsFsZones: true })
    const dir = join(tmp, "loose")
    const path = writeApp(dir, "loose-wf")
    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter,
      compileWorkflow: handle => compileWorkflow(handle, { tools: {}, candidates: [] }),
      appRegistry: createAppRegistry(),
    })
    const run = await runner.startFromFile({ path, cwd: dir })
    await runToEnd(runner, run.runId)
    expect(startSession.mock.calls[0]![0]).not.toHaveProperty("fsZones")
    expect(boundaryFromMeta(spawned[0]!.meta)).toBeUndefined()
  })
})
