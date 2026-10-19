/**
 * Surface wiring for the sandbox checkpoint-`gc` MCP tools
 * (`sandbox_checkpoint_gc` + `sandbox_checkpoint_gc_status`) — the sibling
 * of `branch-gc-surface.test.ts`. All classification and delete logic lives
 * in `@agentproto/worktree`; this file checks that params reach the runner,
 * that a bare call is a DRY RUN, that apply forwards `apply: true` and comes
 * back with the deleted/skipped/failed summary, and that the background job
 * writes its full result to disk.
 */

import { describe, it, expect } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type {
  SandboxCheckpointGcPlanView,
  SandboxCheckpointGcResult,
  SandboxCheckpointGcRunInput,
  SandboxCheckpointGcRunner,
} from "../sandbox-checkpoint-gc.js"
import { withSandboxCheckpointGcApplySummary } from "../sandbox-checkpoint-gc.js"

const PLAN: SandboxCheckpointGcPlanView = {
  repoRoot: "/repo",
  remote: "origin",
  base: "refs/remotes/origin/main",
  prCheckAvailable: true,
  refs: [
    {
      ref: "agentproto-checkpoint/wt/done",
      remote: "origin",
      sha: "c".repeat(40),
      workBranch: "wt/done",
      workBranchOnRemote: true,
      pr: { number: 7, state: "merged" },
      verdict: "safe",
      reason: "pr-resolved (#7 merged)",
    },
    {
      ref: "agentproto-checkpoint/wt/unique",
      remote: "origin",
      sha: "d".repeat(40),
      workBranch: "wt/unique",
      workBranchOnRemote: true,
      pr: null,
      verdict: "keep",
      reason: "no proof its content landed elsewhere",
    },
  ],
}
const SUMMARY = { total: 2, safe: 1, keep: 1, unknown: 0 }
const PLAN_RESULT: SandboxCheckpointGcResult = { mode: "plan", plan: PLAN, summary: SUMMARY }
const APPLY_RESULT: SandboxCheckpointGcResult = {
  mode: "apply",
  plan: PLAN,
  summary: SUMMARY,
  outcomes: [
    { ref: "agentproto-checkpoint/wt/done", result: "deleted", verdict: "safe" },
    { ref: "agentproto-checkpoint/wt/unique", result: "skipped-keep", verdict: "keep", message: "no proof" },
  ],
}

function recordingRunner(): {
  runner: SandboxCheckpointGcRunner
  seen: () => SandboxCheckpointGcRunInput | undefined
} {
  let last: SandboxCheckpointGcRunInput | undefined
  return {
    seen: () => last,
    runner: async input => {
      last = input
      return input.apply ? withSandboxCheckpointGcApplySummary(APPLY_RESULT) : PLAN_RESULT
    },
  }
}

async function harness(opts: {
  runSandboxCheckpointGcSweep?: SandboxCheckpointGcRunner
  sandboxCheckpointGcJobsDir?: string
}) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerSessionTools(server, {
    workspace: process.cwd(),
    registry: createSessionsRegistry({ persist: false }),
    ...opts,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]!.text
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true

describe("sandbox_checkpoint_gc + sandbox_checkpoint_gc_status — MCP tools", () => {
  it("reports 'not enabled' when unwired", async () => {
    const client = await harness({})
    try {
      const r = await client.callTool({ name: "sandbox_checkpoint_gc", arguments: { repoRoot: "/repo" } })
      expect(isError(r)).toBe(true)
      expect(text(r)).toContain("sandbox_checkpoint_gc is not enabled")
    } finally {
      await client.close()
    }
  })

  it("dry-run by default; string scalars coerce", async () => {
    const { runner, seen } = recordingRunner()
    const client = await harness({ runSandboxCheckpointGcSweep: runner })
    try {
      const r = await client.callTool({
        name: "sandbox_checkpoint_gc",
        arguments: { repoRoot: "/repo", apply: "false", remote: "upstream", base: "origin/develop" },
      })
      expect(JSON.parse(text(r))).toEqual(PLAN_RESULT)
      expect(seen()).toEqual({ repoRoot: "/repo", apply: false, remote: "upstream", base: "origin/develop" })
    } finally {
      await client.close()
    }
  })

  it("apply forwards apply: true and returns the deleted/skipped/failed summary", async () => {
    const { runner, seen } = recordingRunner()
    const client = await harness({ runSandboxCheckpointGcSweep: runner })
    try {
      const r = await client.callTool({
        name: "sandbox_checkpoint_gc",
        arguments: { repoRoot: "/repo", apply: "true" },
      })
      expect(isError(r)).toBe(false)
      const result = JSON.parse(text(r)) as SandboxCheckpointGcResult
      expect(result.mode).toBe("apply")
      expect(result.summary).toEqual(SUMMARY)
      expect(result).toMatchObject({
        applySummary: { status: "ok", deleted: 1, skipped: 1, failed: 0 },
      })
      expect(seen()).toEqual({ repoRoot: "/repo", apply: true })
    } finally {
      await client.close()
    }
  })

  it("wait: false returns a jobId; status goes running → done with the summary and a resultPath on disk", async () => {
    const jobsDir = await mkdtemp(join(tmpdir(), "scgc-jobs-"))
    let release!: (r: SandboxCheckpointGcResult) => void
    const gate = new Promise<SandboxCheckpointGcResult>(res => {
      release = res
    })
    const client = await harness({
      runSandboxCheckpointGcSweep: () => gate,
      sandboxCheckpointGcJobsDir: jobsDir,
    })
    try {
      const start = await client.callTool({ name: "sandbox_checkpoint_gc", arguments: { repoRoot: "/repo", wait: false } })
      expect(isError(start)).toBe(false)
      const started = JSON.parse(text(start)) as { jobId: string; status: string; startedAt: string }
      expect(started.status).toBe("running")
      expect(started.jobId).toMatch(/^scg_[0-9a-f]{8}$/)
      expect(started.startedAt).toBeTruthy()

      const running = await client.callTool({ name: "sandbox_checkpoint_gc_status", arguments: { jobId: started.jobId } })
      const runView = JSON.parse(text(running)) as { status: string; elapsedMs: number }
      expect(runView.status).toBe("running")
      expect(runView.elapsedMs).toBeGreaterThanOrEqual(0)

      release(PLAN_RESULT)
      let done: { status: string; resultPath: string; summary: unknown } | undefined
      for (let i = 0; i < 100; i++) {
        const r = await client.callTool({ name: "sandbox_checkpoint_gc_status", arguments: { jobId: started.jobId } })
        done = JSON.parse(text(r))
        if (done!.status === "done") break
        await new Promise(res => setTimeout(res, 10))
      }
      expect(done!.status).toBe("done")
      expect(done!.summary).toEqual(SUMMARY)
      expect(existsSync(done!.resultPath)).toBe(true)
      expect(JSON.parse(await readFile(done!.resultPath, "utf8"))).toEqual(PLAN_RESULT)
    } finally {
      await client.close()
      await rm(jobsDir, { recursive: true, force: true })
    }
  })
})
