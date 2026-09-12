/**
 * `agentproto workflow` — follows the fake-daemon pattern in policy.test.ts:
 * intercept `discoverDaemon`/`httpGetJson`/`httpPostJson` from
 * _daemon-helpers (and `fetch` for the /mcp tools/call path) so no real
 * socket IO happens; assert on the request shape sent and the exit code /
 * stdout produced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runWorkflow } from "../commands/workflow.js"

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

const RUN = {
  runId: "wf_1",
  workflowId: "review-then-fix",
  status: "running",
  startedAt: "2026-09-12T00:00:00Z",
  stages: [
    {
      index: 0,
      status: "done",
      steps: [{ index: 0, status: "done", sessionId: "sess_1" }],
    },
  ],
}

describe("agentproto workflow", () => {
  let stderrChunks: string[]
  let stdoutChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    stderrChunks = []
    stdoutChunks = []
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
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.unstubAllGlobals()
    vi.resetAllMocks()
  })

  it("--help exits 0 and prints usage", async () => {
    const code = await runWorkflow(["--help"])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    expect(out).toContain("agentproto workflow")
    expect(out).toContain("run-file")
    expect(out).toContain("resolve")
  })

  it("bare verb prints usage and exits 0", async () => {
    const code = await runWorkflow([])
    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("Usage:")
  })

  it("unknown subcommand exits 2", async () => {
    const code = await runWorkflow(["nope"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("unknown subcommand")
  })

  describe("start", () => {
    it("requires --workflow-id and --stages-json", async () => {
      expect(await runWorkflow(["start"])).toBe(2)
      expect(stderrChunks.join("")).toContain("--workflow-id")
      expect(await runWorkflow(["start", "--workflow-id", "w"])).toBe(2)
      expect(stderrChunks.join("")).toContain("--stages-json")
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("posts a tools/call for workflow_start with the parsed stages", async () => {
      fetchMock.mockResolvedValue(new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ runId: "wf_1", status: "running" }) },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      const code = await runWorkflow([
        "start",
        "--workflow-id",
        "review-then-fix",
        "--stages-json",
        '[{"steps":[{"kind":"agent","adapter":"claude-code","prompt":"hi"}]}]',
        "--cache-key",
        "abc",
      ])
      expect(code).toBe(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe("http://127.0.0.1:18790/mcp")
      expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok")
      const body = JSON.parse(String(init.body))
      expect(body.method).toBe("tools/call")
      expect(body.params.name).toBe("workflow_start")
      expect(body.params.arguments.workflowId).toBe("review-then-fix")
      expect(body.params.arguments.cacheKey).toBe("abc")
      expect(Array.isArray(body.params.arguments.stages)).toBe(true)
      expect(stdoutChunks.join("")).toContain("wf_1")
    })
  })

  describe("status", () => {
    it("GETs the REST twin and renders", async () => {
      httpGetJson.mockResolvedValue(RUN)
      const code = await runWorkflow(["status", "wf_1"])
      expect(code).toBe(0)
      expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:18790/workflows/wf_1")
      const out = stdoutChunks.join("")
      expect(out).toContain("wf_1")
      expect(out).toContain("review-then-fix")
      expect(out).toContain("Stage 0")
    })

    it("exits 3 on 404", async () => {
      httpGetJson.mockRejectedValue(new Error("HTTP 404: run not found"))
      const code = await runWorkflow(["status", "wf_x"])
      expect(code).toBe(3)
      expect(stderrChunks.join("")).toContain('no run "wf_x"')
    })

    it("requires <runId>", async () => {
      expect(await runWorkflow(["status"])).toBe(2)
    })
  })

  describe("list", () => {
    it("GETs /workflows and renders rows", async () => {
      httpGetJson.mockResolvedValue({ runs: [RUN] })
      const code = await runWorkflow(["list"])
      expect(code).toBe(0)
      expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:18790/workflows")
      expect(stdoutChunks.join("")).toContain("1 workflow run(s)")
    })
  })

  describe("cancel", () => {
    it("requires <runId> (no implicit target)", async () => {
      expect(await runWorkflow(["cancel"])).toBe(2)
      expect(httpPostJson).not.toHaveBeenCalled()
    })

    it("POSTs the REST cancel route and reports status", async () => {
      httpPostJson.mockResolvedValue({ runId: "wf_1", status: "cancelled" })
      const code = await runWorkflow(["cancel", "wf_1"])
      expect(code).toBe(0)
      expect(httpPostJson).toHaveBeenCalledWith(
        "http://127.0.0.1:18790/workflows/wf_1/cancel",
        {},
        "tok",
      )
      expect(stdoutChunks.join("")).toContain("cancelled")
    })

    it("exits 3 on 404", async () => {
      httpPostJson.mockRejectedValue(new Error("HTTP 404: {\"error\":\"run_not_found\"}"))
      const code = await runWorkflow(["cancel", "wf_x"])
      expect(code).toBe(3)
    })
  })

  describe("resolve", () => {
    it("requires <runId>", async () => {
      expect(await runWorkflow(["resolve"])).toBe(2)
    })

    it("requires exactly one of --approve/--reject", async () => {
      expect(await runWorkflow(["resolve", "wf_1"])).toBe(2)
      expect(await runWorkflow(["resolve", "wf_1", "--approve", "--reject"])).toBe(2)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("sends the approval form via tools/call", async () => {
      fetchMock.mockResolvedValue(new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ ok: true, runId: "wf_1", status: "running" }) },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      const code = await runWorkflow(["resolve", "wf_1", "--approve", "--who", "jeremy"])
      expect(code).toBe(0)
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
      expect(body.params.name).toBe("workflow_escalation_resolve")
      expect(body.params.arguments).toEqual({ runId: "wf_1", approved: true, who: "jeremy" })
    })

    it("sends the suspend form with parsed payload", async () => {
      fetchMock.mockResolvedValue(new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: true, runId: "wf_1", status: "running" }) }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      const code = await runWorkflow(["resolve", "wf_1", "--payload-json", '{"resume":true}'])
      expect(code).toBe(0)
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
      expect(body.params.arguments.payload).toEqual({ resume: true })
    })

    it("sends the legacy escalate form with parsed indices", async () => {
      fetchMock.mockResolvedValue(new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      const code = await runWorkflow([
        "resolve",
        "wf_1",
        "--stage-index",
        "1",
        "--step-index",
        "0",
        "--response",
        "yes",
      ])
      expect(code).toBe(0)
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
      expect(body.params.arguments).toEqual({ runId: "wf_1", stageIndex: 1, stepIndex: 0, response: "yes" })
    })

    it("rejects mixing forms", async () => {
      const code = await runWorkflow([
        "resolve",
        "wf_1",
        "--approve",
        "--payload-json",
        "{}",
      ])
      expect(code).toBe(2)
      expect(stderrChunks.join("")).toContain("mutually exclusive")
    })
  })

  describe("run-file", () => {
    it("requires <path>", async () => {
      expect(await runWorkflow(["run-file"])).toBe(2)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("posts a tools/call for workflow_run_file", async () => {
      fetchMock.mockResolvedValue(new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ runId: "wf_9", status: "running" }) },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      const code = await runWorkflow([
        "run-file",
        "WORKFLOW.md",
        "--input-json",
        '{"pr": 42}',
        "--cache-key",
        "k",
      ])
      expect(code).toBe(0)
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
      expect(body.params.name).toBe("workflow_run_file")
      expect(body.params.arguments.path).toBe("WORKFLOW.md")
      expect(body.params.arguments.input).toEqual({ pr: 42 })
      expect(body.params.arguments.cacheKey).toBe("k")
    })

    it("surfaces a tool error as exit 1", async () => {
      fetchMock.mockResolvedValue(new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: true,
            content: [
              { type: "text", text: JSON.stringify({ error: "no such file" }) },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      const code = await runWorkflow(["run-file", "WORKFLOW.md"])
      expect(code).toBe(1)
      expect(stderrChunks.join("")).toContain("no such file")
    })
  })
})