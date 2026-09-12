/**
 * `agentproto task` — fake-daemon pattern (policy.test.ts): intercept
 * `discoverDaemon`/`httpGetJson`/`httpPostJson` from _daemon-helpers; for
 * the PATCH verbs (which ride node:http directly, not _daemon-helpers) spin
 * a real ephemeral loopback server and point discovery at it. Asserts on
 * the request shape sent and the exit code / stdout produced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { runTask } from "../commands/task.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    httpPostJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)
const httpPostJson = vi.mocked(helpers.httpPostJson)

const TASK = {
  taskId: "task_7",
  rev: 1,
  title: "Fix login redirect",
  status: "pending",
  boardId: "ws:default",
}

interface SeenReq {
  method?: string
  url?: string
  body: unknown
}

function startPatchServer(
  handler: (req: { method?: string; url?: string; body: unknown }) => {
    status: number
    body: unknown
  },
): Promise<{ url: string; seen: SeenReq[]; close: () => void }> {
  const seen: SeenReq[] = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", c => (raw += c))
    req.on("end", () => {
      let body: unknown = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = {}
      }
      seen.push({ method: req.method, url: req.url, body })
      const out = handler({ method: req.method, url: req.url, body })
      res.writeHead(out.status, { "content-type": "application/json" })
      res.end(JSON.stringify(out.body))
    })
  })
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => server.close(),
      })
    })
  })
}

describe("agentproto task", () => {
  let stderrChunks: string[]
  let stdoutChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  let servers: Array<{ close: () => void }>

  beforeEach(() => {
    stderrChunks = []
    stdoutChunks = []
    servers = []
    stderrSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stderr as any, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk))
        return true
      })
    stdoutSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk))
        return true
      })
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    for (const s of servers) s.close()
    vi.resetAllMocks()
  })

  it("--help exits 0 and prints usage", async () => {
    const code = await runTask(["--help"])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    expect(out).toContain("agentproto task")
    expect(out).toContain("claim")
    expect(out).toContain("--release")
    expect(out).toContain("--verify-json")
  })

  it("bare verb prints usage and exits 0", async () => {
    const code = await runTask([])
    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("Usage:")
  })

  it("unknown subcommand exits 2", async () => {
    const code = await runTask(["nope"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("unknown subcommand")
  })

  describe("create", () => {
    it("requires <title>", async () => {
      expect(await runTask(["create"])).toBe(2)
      expect(httpPostJson).not.toHaveBeenCalled()
    })

    it("POSTs /tasks with the parsed flags", async () => {
      httpPostJson.mockResolvedValue({
        task: { ...TASK, taskId: "task_9", rev: 0, boardId: "ws:my-project" },
      })
      const code = await runTask([
        "create",
        "Fix login redirect",
        "--board-id",
        "ws:my-project",
        "--blocked-by",
        "task_1",
        "--meta-json",
        '{"prUrl":"x"}',
      ])
      expect(code).toBe(0)
      expect(httpPostJson).toHaveBeenCalledWith(
        "http://127.0.0.1:18790/tasks",
        {
          title: "Fix login redirect",
          boardId: "ws:my-project",
          blockedBy: ["task_1"],
          meta: { prUrl: "x" },
        },
        "tok",
      )
      expect(stdoutChunks.join("")).toContain("ws:my-project")
    })

    it("surfaces a ledger error as exit 1", async () => {
      httpPostJson.mockResolvedValue({ error: "task_create requires a non-empty title" })
      const code = await runTask(["create", "t"])
      expect(code).toBe(1)
      expect(stderrChunks.join("")).toContain("requires a non-empty title")
    })
  })

  describe("list", () => {
    it("GETs /tasks with query params and prints the resolved board", async () => {
      httpGetJson.mockResolvedValue({ boardId: "ws:default", tasks: [TASK] })
      const code = await runTask(["list", "--status", "pending", "--include-closed"])
      expect(code).toBe(0)
      expect(httpGetJson).toHaveBeenCalledWith(
        "http://127.0.0.1:18790/tasks?status=pending&includeClosed=1",
      )
      const out = stdoutChunks.join("")
      expect(out).toContain("Board: ws:default")
      expect(out).toContain("task_7")
      expect(out).toContain("(claimable)")
    })

    it("rejects an invalid --status", async () => {
      const code = await runTask(["list", "--status", "nope"])
      expect(code).toBe(2)
      expect(stderrChunks.join("")).toContain("invalid --status")
    })
  })

  describe("claim", () => {
    it("requires <taskId> and --rev", async () => {
      expect(await runTask(["claim"])).toBe(2)
      expect(stderrChunks.join("")).toContain("missing <taskId>")
      expect(await runTask(["claim", "task_7"])).toBe(2)
      expect(stderrChunks.join("")).toContain("--rev")
    })

    it("PATCHes {rev, owner:\"operator\", status:\"in_progress\"}", async () => {
      const srv = await startPatchServer(() => ({
        status: 200,
        body: { task: { ...TASK, owner: "operator", status: "in_progress", rev: 1 } },
      }))
      servers.push(srv)
      discoverDaemon.mockResolvedValue({
        found: { url: srv.url },
        stale: [],
      })
      const code = await runTask(["claim", "task_7", "--rev", "0"])
      expect(code).toBe(0)
      expect(srv.seen[0]?.body).toEqual({
        rev: 0,
        owner: "operator",
        status: "in_progress",
      })
      expect(stdoutChunks.join("")).toContain("Claimed task_7")
      expect(stdoutChunks.join("")).toContain("ws:default")
    })
  })

  describe("update", () => {
    it("requires --rev (the rev-CAS guard is the confirmation)", async () => {
      expect(await runTask(["update", "task_7"])).toBe(2)
      expect(stderrChunks.join("")).toContain("--rev")
    })

    it("rejects --release + --owner", async () => {
      const code = await runTask([
        "update",
        "task_7",
        "--rev",
        "0",
        "--release",
        "--owner",
        "sess_1",
      ])
      expect(code).toBe(2)
      expect(stderrChunks.join("")).toContain("mutually exclusive")
    })

    it("surfaces a 409 conflict with the current record and rebase hint", async () => {
      const srv = await startPatchServer(() => ({
        status: 409,
        body: { conflict: true, current: { ...TASK, rev: 3, owner: "sess_x" } },
      }))
      servers.push(srv)
      discoverDaemon.mockResolvedValue({
        found: { url: srv.url },
        stale: [],
      })
      const code = await runTask(["update", "task_7", "--rev", "0", "--status", "done"])
      expect(code).toBe(1)
      const err = stderrChunks.join("")
      expect(err).toContain("conflict")
      expect(err).toContain("--rev 3")
    })

    it("PATCHes status/note/evidence fields", async () => {
      const srv = await startPatchServer(() => ({
        status: 200,
        body: {
          task: { ...TASK, rev: 2, status: "done" },
          verifying: true,
        },
      }))
      servers.push(srv)
      discoverDaemon.mockResolvedValue({
        found: { url: srv.url },
        stale: [],
      })
      const code = await runTask([
        "update",
        "task_7",
        "--rev",
        "1",
        "--status",
        "done",
        "--note",
        "tests green",
        "--evidence-policy",
        "pol_1",
      ])
      expect(code).toBe(0)
      expect(srv.seen[0]?.body).toEqual({
        rev: 1,
        status: "done",
        note: "tests green",
        evidence: { policyId: "pol_1" },
      })
      expect(stdoutChunks.join("")).toContain("verifying:true")
    })
  })
})