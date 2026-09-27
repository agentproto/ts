/**
 * AIP-58 §4 Run workspace (P4) — HOST-layer pieces: runId-keyed disjoint
 * `<runsRoot>/<runId>/` allocation, `Run.artifacts[]` recording + the
 * `step.artifact` event, compact `workflow_status` projection, `readArtifact`
 * ("fetchable"), and `run.publish`.
 *
 * Drives vector V5 (`specs/resources/aip-58/draft/vectors/v5-disjoint-
 * workspaces.json`) end to end through the real `createWorkflowRunner` —
 * two concurrent runs of the same workflow never share a workspace or write
 * the shared `outputsFiles` path before an explicit publish. See
 * `packages/workflow-runtime/src/__tests__/aip58-conformance.test.ts`'s
 * `NOT_YET_GREEN` map for why V5 lives here and not there (runId allocation
 * + `run.publish` are host concerns).
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import { compileWorkflow } from "@agentproto/workflow-runtime"
import { createWorkflowRunner, type WorkflowRun } from "../workflow-runner.js"
import { compactWorkflowRunStatus } from "../orchestration-tools.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

function makeMockRegistry(): SessionsRegistry {
  const descriptors = new Map<string, SessionDescriptor>()
  return {
    spawnAgent: (input: { cwd: string; label?: string }) => {
      const id = `sess_${Math.random().toString(36).slice(2, 8)}`
      const desc = {
        id,
        kind: "agent-cli" as const,
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running" as const,
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
        label: input.label,
      }
      descriptors.set(id, desc)
      return desc
    },
    sendPrompt: async () => {},
    get: (id: string) => descriptors.get(id),
  } as unknown as SessionsRegistry
}

function makeMockAdapter(): AgentAdapterResolver {
  return (async () => ({
    startSession: async () => ({
      sessionId: `adapter_${Math.random().toString(36).slice(2, 6)}`,
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    }),
    commandPreview: "mock-adapter",
  })) as unknown as AgentAdapterResolver
}

/** A trivial side-effecting tool: writes `content` to `<dir>/<name>` and
 *  reports the path it wrote — this test's stand-in for an agent step
 *  "producing" a file under the run workspace. */
function makeWriteFileTool() {
  const writeFileTool = defineTool({
    id: "demo.write-file",
    description: "Write content to dir/name.",
    inputSchema: z.object({ dir: z.string(), name: z.string(), content: z.string() }),
    outputSchema: z.object({ path: z.string() }),
  })
  const provider = defineDriver({
    id: "write-file-builtin",
    name: "WriteFile",
    description: "Trivial fs write.",
    kind: "builtin",
    implements: [{ tool: "demo.write-file", version: "0.1.0" }],
    implementations: [
      implementTool(writeFileTool, ({ input }) => {
        const path = join(input.dir, input.name)
        mkdirSync(join(path, ".."), { recursive: true })
        writeFileSync(path, input.content, "utf8")
        return { path }
      }),
    ],
  })
  return { tools: { "demo.write-file": writeFileTool }, candidates: [provider] }
}

async function waitDone(runner: ReturnType<typeof createWorkflowRunner>, runId: string): Promise<WorkflowRun> {
  const terminal = new Set(["done", "failed", "cancelled"])
  let run = runner.status(runId)
  for (let i = 0; i < 200 && run && !terminal.has(run.status); i++) {
    await new Promise(res => setTimeout(res, 10))
    run = runner.status(runId)
  }
  if (!run) throw new Error(`run ${runId} vanished`)
  return run
}

describe("AIP-58 §4 — disjoint per-run workspaces (host layer)", () => {
  it("two concurrent start() runs of the SAME workflowId get disjoint, non-empty workspaces", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aip58-ws-disjoint-"))
    const runsRoot = join(tmpDir, "runs")
    try {
      const runner = createWorkflowRunner({
        registry: makeMockRegistry(),
        sessionEvents: createSessionEventBus(),
        resolveAgentAdapter: makeMockAdapter(),
        persist: true,
        persistPath: join(tmpDir, "workflow-runs.json"),
        runsRoot,
      })

      const stages = [{ steps: [{ label: "noop", adapter: "mock-adapter" }] }]
      const [runA, runB] = await Promise.all([
        runner.start({ workflowId: "wf", stages }),
        runner.start({ workflowId: "wf", stages }),
      ])

      expect(runA.workspace).toBeDefined()
      expect(runB.workspace).toBeDefined()
      expect(runA.workspace).not.toBe(runB.workspace)
      expect(existsSync(runA.workspace!)).toBe(true)
      expect(existsSync(runB.workspace!)).toBe(true)
      expect(runA.runId).not.toBe(runB.runId)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("AIP-58 §4/§9 — V5: disjoint workspaces + deferred run.publish", () => {
  it("two concurrent runs never write the shared outputsFiles path; explicit publish resolves it; the other run's artifact is untouched", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aip58-v5-"))
    const runsRoot = join(tmpDir, "runs")
    const appCwd = join(tmpDir, "app")
    try {
      const { tools, candidates } = makeWriteFileTool()
      const runner = createWorkflowRunner({
        registry: makeMockRegistry(),
        sessionEvents: createSessionEventBus(),
        resolveAgentAdapter: makeMockAdapter(),
        persist: true,
        persistPath: join(tmpDir, "workflow-runs.json"),
        runsRoot,
        compileWorkflow: handle => compileWorkflow(handle, { tools, candidates }),
      })

      const workflowPath = join(tmpDir, "WORKFLOW.md")
      writeFileSync(
        workflowPath,
        `---
name: Pricing brief
id: pricing-brief
description: V5 conformance fixture.
version: 1.0.0
inputs:
  type: object
  properties:
    productUrl: { type: string }
  required: ["productUrl"]
outputs: {}
outputsFiles:
  brief:
    path: "./briefs/latest.md"
    required: true
steps:
  - id: save
    kind: tool
    tool: demo.write-file
    inputs:
      dir: $run.workspace
      name: briefs/latest.md
      content: $input.productUrl
---
`,
        "utf8",
      )

      const [runA0, runB0] = await Promise.all([
        runner.startFromFile({ path: workflowPath, input: { productUrl: "https://example.com/pricing-a" }, cwd: appCwd }),
        runner.startFromFile({ path: workflowPath, input: { productUrl: "https://example.com/pricing-b" }, cwd: appCwd }),
      ])
      const runA = await waitDone(runner, runA0.runId)
      const runB = await waitDone(runner, runB0.runId)

      expect(runA.status).toBe("done")
      expect(runB.status).toBe("done")
      expect(runA.workspace).not.toBe(runB.workspace)

      // §4: outputsFiles synced to EACH run's own artifacts/<basename>, never
      // the shared path — that file must not exist yet.
      const sharedPath = join(appCwd, "briefs", "latest.md")
      expect(existsSync(sharedPath)).toBe(false)

      // F42: the on-disk name is the declared file's own basename
      // (`latest.md`, from `outputsFiles.brief.path: "./briefs/latest.md"`),
      // not the bare key.
      expect(runA.artifacts).toEqual([{ key: "brief", path: "artifacts/latest.md", sha256: expect.any(String), size: expect.any(Number), stepId: "save" }])
      expect(runB.artifacts).toEqual([{ key: "brief", path: "artifacts/latest.md", sha256: expect.any(String), size: expect.any(Number), stepId: "save" }])

      const artifactFileA = join(runA.workspace!, "artifacts", "latest.md")
      const artifactFileB = join(runB.workspace!, "artifacts", "latest.md")
      expect(readFileSync(artifactFileA, "utf8")).toBe("https://example.com/pricing-a")
      expect(readFileSync(artifactFileB, "utf8")).toBe("https://example.com/pricing-b")

      // Compact `workflow_status` projection: key/path/size only.
      const compact = compactWorkflowRunStatus(runA)
      expect(compact.artifacts).toEqual([{ key: "brief", path: "artifacts/latest.md", size: expect.any(Number) }])

      // Fetchable.
      const fetched = await runner.readArtifact(runA.runId, "brief")
      expect(fetched).toMatchObject({ ok: true, content: Buffer.from("https://example.com/pricing-a"), truncated: false })

      // Explicit publish, no `to` — defaults from outputsFiles.brief.path.
      const published = await runner.publish(runB.runId, { artifactKey: "brief" })
      expect(published).toMatchObject({ ok: true, publishedPath: sharedPath })
      expect(readFileSync(sharedPath, "utf8")).toBe("https://example.com/pricing-b")

      // run A's own artifact copy is untouched by run B's publish.
      expect(readFileSync(artifactFileA, "utf8")).toBe("https://example.com/pricing-a")

      const eventsB = runner.events(runB.runId)
      expect(eventsB?.some(e => e.type === "run.published" && (e.data as { artifactKey: string }).artifactKey === "brief")).toBe(true)

      // publish() refuses a non-existent run / an unknown artifact key.
      expect(await runner.publish("wfrun_does_not_exist", { artifactKey: "brief" })).toMatchObject({
        ok: false,
        error: "run_not_found",
      })
      expect(await runner.publish(runA.runId, { artifactKey: "no-such-key" })).toMatchObject({
        ok: false,
        error: "artifact_not_found",
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
