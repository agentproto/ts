/**
 * Surface wiring for the branch-`gc` transport surface — `POST /branches/gc`,
 * `POST /branches/gc/verdict`, and the `branch_gc` / `branch_gc_verdict` MCP
 * tools. All are thin shells over injected ports (the sibling of
 * `worktree-gc-surface.test.ts`): this file checks that params reach the
 * runner, that a bare call is a DRY RUN, that apply demands explicit scopes,
 * that string scalars coerce, and that the "not enabled" fallbacks fire —
 * never the engine itself, which lives in `@agentproto/worktree`.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { startHttpServer, type RuntimeHttpServerHandle } from "../http-server.js"
import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type {
  BranchGcResult,
  BranchGcRunInput,
  BranchGcRunner,
  BranchGcVerdictInput,
  BranchGcVerdictRecorder,
  BranchGcVerdictReader,
  BranchGcPlanView,
} from "../branch-gc.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

const PLAN: BranchGcPlanView = {
  repoRoot: "/repo",
  repoName: "repo",
  base: "origin/main",
  baseSha: "a".repeat(40),
  baseTree: "b".repeat(40),
  remote: "origin",
  anchor: null,
  prCheck: { available: true },
  scopes: ["local", "remote", "orphan"],
  minAgeDays: 3,
  includeReviewed: false,
  generatedAt: "2026-09-26T00:00:00.000Z",
  otherRemoteRefs: 0,
  entries: [
    {
      kind: "local",
      name: "feat/done",
      ref: "refs/heads/feat/done",
      sha: "c".repeat(40),
      date: "2026-09-01T00:00:00Z",
      author: "T",
      subject: "done",
      status: "squash-merged",
      history: "current",
      ahead: 1,
      behind: 4,
      ageDays: 25,
      class: "reclaim",
      reclaimReason: "squash-merged",
    },
  ],
}
const SUMMARY = {
  byClass: { local: { reclaim: 1, review: 0, hold: 0 }, remote: { reclaim: 0, review: 0, hold: 0 }, orphan: { reclaim: 0, review: 0, hold: 0 } },
  byStatus: { local: { "squash-merged": 1 }, remote: {}, orphan: {} },
}
const PLAN_RESULT: BranchGcResult = { mode: "plan", plan: PLAN, summary: SUMMARY }
const APPLY_RESULT: BranchGcResult = {
  mode: "apply",
  plan: PLAN,
  summary: SUMMARY,
  outcomes: [{ kind: "local", name: "feat/done", sha: "c".repeat(40), result: "deleted", reclaimReason: "squash-merged" }],
  restoreLog: "/state/branch-gc/repo/restore-x.json",
}

function recordingRunner(): { runner: BranchGcRunner; seen: () => BranchGcRunInput | undefined } {
  let last: BranchGcRunInput | undefined
  return {
    runner: async input => {
      last = input
      return input.apply ? APPLY_RESULT : PLAN_RESULT
    },
    seen: () => last,
  }
}

function recordingRecorder(): { recorder: BranchGcVerdictRecorder; seen: () => BranchGcVerdictInput | undefined } {
  let last: BranchGcVerdictInput | undefined
  return {
    recorder: async input => {
      last = input
      const v = input.verdict as { name: string; sha: string; reviewer: string; triage: never }
      return { repo: "repo", recordedAt: "t", name: v.name, sha: v.sha, reviewer: v.reviewer, triage: v.triage }
    },
    seen: () => last,
  }
}

const VERDICT = {
  name: "feat/x",
  sha: "d".repeat(40),
  reviewer: "test",
  triage: { verdict: "obsolete", confidence: 0.9, reason: "dead" },
  gate: { agree: true, verdict: "obsolete", reason: "nothing unique", evidence: ["abc: in base"] },
}

describe("POST /branches/gc + /branches/gc/verdict — HTTP routes", () => {
  async function start(opts: { runBranchGc?: BranchGcRunner; recordBranchGcVerdict?: BranchGcVerdictRecorder } = {}) {
    return startHttpServer({
      port: await freePort(),
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      ...opts,
    })
  }
  function post(http: RuntimeHttpServerHandle, path: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${http.url.split(":").pop()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("501 when nothing is wired", async () => {
    const http = await start()
    try {
      expect((await post(http, "/branches/gc", { repoRoot: "/repo" })).status).toBe(501)
      expect((await post(http, "/branches/gc/verdict", { repoRoot: "/repo", ...VERDICT })).status).toBe(501)
    } finally {
      await http.stop()
    }
  })

  it("dry-run by default, forwarding every option", async () => {
    const { runner, seen } = recordingRunner()
    const http = await start({ runBranchGc: runner })
    try {
      const res = await post(http, "/branches/gc", {
        repoRoot: "/repo",
        base: "origin/dev",
        scopes: ["local", "bogus", "orphan"],
        minAgeDays: "5",
        includeReviewed: "true",
        anchor: "abc",
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(PLAN_RESULT)
      expect(seen()).toEqual({
        repoRoot: "/repo",
        apply: false,
        includeReviewed: true,
        base: "origin/dev",
        scopes: ["local", "orphan"],
        minAgeDays: 5,
        anchor: "abc",
      })
    } finally {
      await http.stop()
    }
  })

  it("apply without scopes is a 400 and never reaches the runner; with scopes it applies", async () => {
    const { runner, seen } = recordingRunner()
    const http = await start({ runBranchGc: runner })
    try {
      const bad = await post(http, "/branches/gc", { repoRoot: "/repo", apply: true })
      expect(bad.status).toBe(400)
      expect(seen()).toBeUndefined()
      const ok = await post(http, "/branches/gc", { repoRoot: "/repo", apply: "true", scopes: ["local"] })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual(APPLY_RESULT)
      expect(seen()).toMatchObject({ apply: true, scopes: ["local"] })
    } finally {
      await http.stop()
    }
  })

  it("verdict: forwards the body minus repo selectors; a recorder error is a 400", async () => {
    const { recorder, seen } = recordingRecorder()
    const http = await start({ recordBranchGcVerdict: recorder })
    try {
      const res = await post(http, "/branches/gc/verdict", { repoRoot: "/repo", ...VERDICT })
      expect(res.status).toBe(200)
      expect(seen()).toEqual({ repoRoot: "/repo", verdict: VERDICT })
    } finally {
      await http.stop()
    }
    const failing = await start({
      recordBranchGcVerdict: async () => {
        throw new Error("gate.agree=true requires evidence")
      },
    })
    try {
      const res = await post(failing, "/branches/gc/verdict", { repoRoot: "/repo", ...VERDICT })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { message: string }).message).toContain("evidence")
    } finally {
      await failing.stop()
    }
  })
})

describe("branch_gc + branch_gc_verdict — MCP tools", () => {
  async function harness(
    opts: { runBranchGc?: BranchGcRunner; recordBranchGcVerdict?: BranchGcVerdictRecorder; readBranchGcVerdict?: BranchGcVerdictReader } = {},
  ) {
    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    registerSessionTools(server, { workspace: process.cwd(), registry: createSessionsRegistry({ persist: false }), ...opts })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0.0.1" })
    await client.connect(clientTransport)
    return client
  }
  const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]!.text
  const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true

  it("reports 'not enabled' when unwired", async () => {
    const client = await harness()
    try {
      const r1 = await client.callTool({ name: "branch_gc", arguments: { repoRoot: "/repo" } })
      expect(isError(r1)).toBe(true)
      expect(text(r1)).toContain("branch_gc is not enabled")
      const r2 = await client.callTool({ name: "branch_gc_verdict", arguments: { repoRoot: "/repo", ...VERDICT } })
      expect(isError(r2)).toBe(true)
      expect(text(r2)).toContain("branch_gc_verdict is not enabled")
    } finally {
      await client.close()
    }
  })

  it("dry-run by default; string scalars coerce", async () => {
    const { runner, seen } = recordingRunner()
    const client = await harness({ runBranchGc: runner })
    try {
      const r = await client.callTool({
        name: "branch_gc",
        arguments: { repoRoot: "/repo", minAgeDays: "7", includeReviewed: "false", scopes: ["remote"] },
      })
      expect(JSON.parse(text(r))).toEqual(PLAN_RESULT)
      expect(seen()).toEqual({ repoRoot: "/repo", apply: false, includeReviewed: false, scopes: ["remote"], minAgeDays: 7 })
    } finally {
      await client.close()
    }
  })

  it("apply demands explicit scopes", async () => {
    const { runner, seen } = recordingRunner()
    const client = await harness({ runBranchGc: runner })
    try {
      const bad = await client.callTool({ name: "branch_gc", arguments: { repoRoot: "/repo", apply: true } })
      expect(isError(bad)).toBe(true)
      expect(seen()).toBeUndefined()
      const ok = await client.callTool({ name: "branch_gc", arguments: { repoRoot: "/repo", apply: "true", scopes: ["local", "orphan"] } })
      expect(JSON.parse(text(ok))).toEqual(APPLY_RESULT)
      expect(seen()).toMatchObject({ apply: true, scopes: ["local", "orphan"] })
    } finally {
      await client.close()
    }
  })

  it("branch_gc_verdict forwards the verdict and surfaces recorder errors", async () => {
    const { recorder, seen } = recordingRecorder()
    const client = await harness({ recordBranchGcVerdict: recorder })
    try {
      const r = await client.callTool({ name: "branch_gc_verdict", arguments: { repoRoot: "/repo", ...VERDICT } })
      expect(isError(r)).toBe(false)
      expect(JSON.parse(text(r))).toMatchObject({ recorded: true, record: { sha: VERDICT.sha } })
      expect(seen()).toEqual({ repoRoot: "/repo", verdict: VERDICT })
    } finally {
      await client.close()
    }
    const failing = await harness({
      recordBranchGcVerdict: async () => {
        throw new Error("invalid branch verdict: gate.evidence")
      },
    })
    try {
      const r = await failing.callTool({ name: "branch_gc_verdict", arguments: { repoRoot: "/repo", ...VERDICT } })
      expect(isError(r)).toBe(true)
      expect(text(r)).toContain("gate.evidence")
    } finally {
      await failing.close()
    }
  })

  it("branch_gc_verdict_get reports found/missing for one tip sha", async () => {
    // VERDICT's literals widen to `string`; the reader returns the typed view.
    const stored = { ...VERDICT, repo: "repo", recordedAt: "2026-01-01T00:00:00Z" } as NonNullable<
      Awaited<ReturnType<BranchGcVerdictReader>>
    >
    const seen: Array<{ repoRoot: string; sha: string }> = []
    const reader: BranchGcVerdictReader = async input => {
      seen.push(input)
      return input.sha === VERDICT.sha ? stored : null
    }
    const client = await harness({ readBranchGcVerdict: reader })
    try {
      const hit = await client.callTool({ name: "branch_gc_verdict_get", arguments: { repoRoot: "/repo", sha: VERDICT.sha } })
      expect(JSON.parse(text(hit))).toEqual({ sha: VERDICT.sha, found: true, missing: false, record: stored })
      const miss = await client.callTool({ name: "branch_gc_verdict_get", arguments: { repoRoot: "/repo", sha: "f".repeat(40) } })
      expect(JSON.parse(text(miss))).toEqual({ sha: "f".repeat(40), found: false, missing: true, record: null })
      expect(seen).toEqual([
        { repoRoot: "/repo", sha: VERDICT.sha },
        { repoRoot: "/repo", sha: "f".repeat(40) },
      ])
    } finally {
      await client.close()
    }
    const unwired = await harness()
    try {
      const r = await unwired.callTool({ name: "branch_gc_verdict_get", arguments: { repoRoot: "/repo", sha: VERDICT.sha } })
      expect(isError(r)).toBe(true)
      expect(text(r)).toContain("branch_gc_verdict_get is not enabled")
    } finally {
      await unwired.close()
    }
  })

  it("wait: false returns a jobId; branch_gc_status goes running → done with a summary and a resultPath on disk", async () => {
    let release!: (r: BranchGcResult) => void
    const gate = new Promise<BranchGcResult>(res => {
      release = res
    })
    const runner: BranchGcRunner = () => gate
    const client = await harness({ runBranchGc: runner })
    try {
      const start = await client.callTool({ name: "branch_gc", arguments: { repoRoot: "/repo", wait: false } })
      expect(isError(start)).toBe(false)
      const started = JSON.parse(text(start)) as { jobId: string; status: string; startedAt: string }
      expect(started.status).toBe("running")
      expect(started.jobId).toMatch(/^bgc_[0-9a-f]{8}$/)
      expect(started.startedAt).toBeTruthy()

      const running = await client.callTool({ name: "branch_gc_status", arguments: { jobId: started.jobId } })
      const runView = JSON.parse(text(running)) as { status: string; elapsedMs: number }
      expect(runView.status).toBe("running")
      expect(runView.elapsedMs).toBeGreaterThanOrEqual(0)

      release(PLAN_RESULT)
      // The job flips to `done` only after its async settle handler runs.
      let done: { status: string; resultPath: string; summary: unknown } | undefined
      for (let i = 0; i < 100; i++) {
        const r = await client.callTool({ name: "branch_gc_status", arguments: { jobId: started.jobId } })
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
    }
  })

  it("branch_gc_status for an apply job surfaces restoreLog and outcomeCounts", async () => {
    let release!: (r: BranchGcResult) => void
    const gate = new Promise<BranchGcResult>(res => {
      release = res
    })
    const runner: BranchGcRunner = () => gate
    const client = await harness({ runBranchGc: runner })
    try {
      const started = await client.callTool({ name: "branch_gc", arguments: { repoRoot: "/repo", wait: false } })
      const { jobId } = JSON.parse(text(started)) as { jobId: string }
      const APPLY_JOB_RESULT: BranchGcResult = {
        mode: "apply",
        plan: PLAN,
        summary: SUMMARY,
        outcomes: [
          { kind: "local", name: "feat/done", sha: "c".repeat(40), result: "deleted" },
          { kind: "remote", name: "origin/feat/stale", sha: "e".repeat(40), result: "held", holdReason: "open-pr" },
          { kind: "orphan", name: "refs/remotes/gone/x", sha: "f".repeat(40), result: "deleted" },
        ],
        restoreLog: "/state/branch-gc/repo/restore-fake.json",
      }
      release(APPLY_JOB_RESULT)
      let done: { status: string; restoreLog?: string | null; outcomeCounts?: Record<string, number> } | undefined
      for (let i = 0; i < 100; i++) {
        const r = await client.callTool({ name: "branch_gc_status", arguments: { jobId } })
        done = JSON.parse(text(r))
        if (done!.status === "done") break
        await new Promise(res => setTimeout(res, 10))
      }
      expect(done!.status).toBe("done")
      expect(done!.restoreLog).toBe("/state/branch-gc/repo/restore-fake.json")
      expect(done!.outcomeCounts).toEqual({ deleted: 2, held: 1 })
    } finally {
      await client.close()
    }
  })

  it("waitMs with a fast runner returns the result inline; a failed job reports its error; unknown ids are not found", async () => {
    const { runner } = recordingRunner()
    const client = await harness({ runBranchGc: runner })
    try {
      const r = await client.callTool({ name: "branch_gc", arguments: { repoRoot: "/repo", waitMs: 5000 } })
      expect(JSON.parse(text(r))).toEqual(PLAN_RESULT)
    } finally {
      await client.close()
    }

    const failing: BranchGcRunner = async () => {
      throw new Error("git exploded")
    }
    const failClient = await harness({ runBranchGc: failing })
    try {
      const started = await failClient.callTool({ name: "branch_gc", arguments: { repoRoot: "/repo", wait: false } })
      const { jobId } = JSON.parse(text(started)) as { jobId: string }
      let view: { status: string; error?: string } | undefined
      for (let i = 0; i < 100; i++) {
        view = JSON.parse(text(await failClient.callTool({ name: "branch_gc_status", arguments: { jobId } })))
        if (view!.status === "failed") break
        await new Promise(res => setTimeout(res, 10))
      }
      expect(view).toMatchObject({ status: "failed", error: "git exploded" })
    } finally {
      await failClient.close()
    }

    const unknown = await harness({ runBranchGc: runner })
    try {
      const r = await unknown.callTool({ name: "branch_gc_status", arguments: { jobId: "bgc_00000000" } })
      expect(isError(r)).toBe(true)
      expect(text(r)).toContain("not found (jobs don't survive a daemon restart)")
    } finally {
      await unknown.close()
    }
  })
})
