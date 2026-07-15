/**
 * `agentproto policy` — pure HTTP client over `/policies`. Follows the
 * fake-daemon pattern in sessions-json-fields.test.ts / sessions-wait.test.ts:
 * intercept `discoverDaemon`/`httpGetJson`/`httpPostJson` from
 * _daemon-helpers so no real socket IO happens, then assert on the request
 * shape sent and the exit code / stdout produced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runPolicy } from "../commands/policy.js"

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

describe("agentproto policy", () => {
  let stderrChunks: string[]
  let stdoutChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

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
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  describe("attach — argument validation (no daemon call)", () => {
    it("fails without --session/--sessions", async () => {
      const code = await runPolicy(["attach", "--then", "emit"])
      expect(code).toBe(2)
      expect(stderrChunks.join("")).toContain("missing --session")
      expect(httpPostJson).not.toHaveBeenCalled()
    })

    it("rejects more than one gate form", async () => {
      const code = await runPolicy([
        "attach",
        "--session",
        "sess_1",
        "--judge-adapter",
        "claude-code",
        "--judge-prompt",
        "review it",
        "--",
        "pnpm",
        "test",
      ])
      expect(code).toBe(2)
      expect(stderrChunks.join("")).toContain("at most one gate form")
      expect(httpPostJson).not.toHaveBeenCalled()
    })

    it("rejects --then commit without --commit-path/--commit-message", async () => {
      const code = await runPolicy(["attach", "--session", "sess_1", "--then", "commit"])
      expect(code).toBe(2)
      expect(stderrChunks.join("")).toContain("--then commit requires")
      expect(httpPostJson).not.toHaveBeenCalled()
    })

    it("rejects --commit-path without --then commit", async () => {
      const code = await runPolicy([
        "attach",
        "--session",
        "sess_1",
        "--commit-path",
        "a.ts",
        "--commit-message",
        "msg",
      ])
      expect(code).toBe(2)
      expect(stderrChunks.join("")).toContain("only apply with --then commit")
    })

    it("rejects --gate-cwd without a shell gate", async () => {
      const code = await runPolicy([
        "attach",
        "--session",
        "sess_1",
        "--gate-cwd",
        "/tmp",
      ])
      expect(code).toBe(2)
      expect(stderrChunks.join("")).toContain("require a shell gate")
    })
  })

  describe("attach — body construction", () => {
    it("builds a shell gate from -- <cmd> [args...] and defaults --then to emit", async () => {
      httpPostJson.mockResolvedValue({
        policyId: "pol_1",
        sessionId: "sess_1",
        sessionIds: ["sess_1"],
        pending: [],
        status: "watching",
        retries: 0,
        startedAt: "2026-07-15T00:00:00.000Z",
      })

      const code = await runPolicy([
        "attach",
        "--session",
        "sess_1",
        "--",
        "pnpm",
        "test",
      ])

      expect(code).toBe(0)
      expect(httpPostJson).toHaveBeenCalledTimes(1)
      const [url, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
      expect(url).toBe("http://127.0.0.1:18790/policies")
      expect(body).toMatchObject({
        sessionId: "sess_1",
        then: "emit",
        gate: { command: "pnpm", args: ["test"] },
      })
      expect(stdoutChunks.join("")).toContain("pol_1")
    })

    it("splits --sessions on commas into a fan-in group, superseding --session", async () => {
      httpPostJson.mockResolvedValue({
        policyId: "pol_2",
        sessionId: "sess_a",
        sessionIds: ["sess_a", "sess_b"],
        pending: ["sess_a", "sess_b"],
        status: "watching",
        retries: 0,
        startedAt: "2026-07-15T00:00:00.000Z",
      })

      const code = await runPolicy([
        "attach",
        "--sessions",
        "sess_a, sess_b",
        "--then",
        "emit",
      ])

      expect(code).toBe(0)
      const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
      expect(body.sessionIds).toEqual(["sess_a", "sess_b"])
      expect(body.sessionId).toBeUndefined()
    })

    it("builds a judge gate from --judge-adapter/--judge-prompt", async () => {
      httpPostJson.mockResolvedValue({
        policyId: "pol_3",
        sessionId: "sess_1",
        sessionIds: ["sess_1"],
        pending: [],
        status: "watching",
        retries: 0,
        startedAt: "2026-07-15T00:00:00.000Z",
      })

      const code = await runPolicy([
        "attach",
        "--session",
        "sess_1",
        "--judge-adapter",
        "claude-code",
        "--judge-prompt",
        "review the diff",
      ])

      expect(code).toBe(0)
      const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
      expect(body.gate).toEqual({ judge: { adapter: "claude-code", prompt: "review the diff" } })
    })

    it("builds a commit spec with requireHumanAck defaulting true, false with --no-ack", async () => {
      httpPostJson.mockResolvedValue({
        policyId: "pol_4",
        sessionId: "sess_1",
        sessionIds: ["sess_1"],
        pending: [],
        status: "watching",
        retries: 0,
        startedAt: "2026-07-15T00:00:00.000Z",
      })

      await runPolicy([
        "attach",
        "--session",
        "sess_1",
        "--then",
        "commit",
        "--commit-path",
        "a.ts",
        "--commit-path",
        "b.ts",
        "--commit-message",
        "wip",
      ])
      const [, body1] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
      expect(body1.commit).toEqual({
        paths: ["a.ts", "b.ts"],
        message: "wip",
        requireHumanAck: true,
      })

      await runPolicy([
        "attach",
        "--session",
        "sess_1",
        "--then",
        "commit",
        "--commit-path",
        "a.ts",
        "--commit-message",
        "wip",
        "--no-ack",
      ])
      const [, body2] = httpPostJson.mock.calls[1] as [string, Record<string, unknown>]
      expect((body2.commit as Record<string, unknown>).requireHumanAck).toBe(false)
    })

    it("--attach-json sends the parsed object verbatim as the whole body, ignoring other flags", async () => {
      httpPostJson.mockResolvedValue({
        policyId: "pol_5",
        sessionId: "sess_x",
        sessionIds: ["sess_x"],
        pending: [],
        status: "watching",
        retries: 0,
        startedAt: "2026-07-15T00:00:00.000Z",
      })

      const code = await runPolicy([
        "attach",
        "--attach-json",
        JSON.stringify({ sessionId: "sess_x", then: "emit" }),
      ])

      expect(code).toBe(0)
      const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
      expect(body).toEqual({ sessionId: "sess_x", then: "emit" })
    })
  })

  describe("status — composes over GET /policies (no plain GET /policies/:id route)", () => {
    it("finds the matching entry from the list and exits 0", async () => {
      httpGetJson.mockResolvedValue({
        policies: [
          { policyId: "pol_1", status: "done", sessionIds: ["s1"] },
          { policyId: "pol_2", status: "watching", sessionIds: ["s2"] },
        ],
      })
      const code = await runPolicy(["status", "pol_2", "--json"])
      expect(code).toBe(0)
      expect(JSON.parse(stdoutChunks.join(""))).toMatchObject({ policyId: "pol_2", status: "watching" })
    })

    it("exits 3 when the policyId isn't in the list", async () => {
      httpGetJson.mockResolvedValue({ policies: [] })
      const code = await runPolicy(["status", "pol_missing"])
      expect(code).toBe(3)
      expect(stderrChunks.join("")).toContain('no policy "pol_missing"')
    })
  })

  describe("wait — reuses the shared long-poll helper", () => {
    it("reaches GET /policies/:id/wait and exits 0 on done", async () => {
      httpGetJson.mockResolvedValue({ timedOut: false, policyId: "pol_1", status: "done" })
      const code = await runPolicy(["wait", "pol_1"])
      expect(code).toBe(0)
      const url = (httpGetJson.mock.calls[0] as [string])[0]
      expect(url).toContain("/policies/pol_1/wait")
    })

    it("defaults --timeout to 900000ms (a gate may be a full test suite)", async () => {
      httpGetJson.mockResolvedValue({ timedOut: true })
      const code = await runPolicy(["wait", "pol_1", "--timeout", "5"])
      expect(code).toBe(2)
      expect(stdoutChunks.join("")).toContain("timed out")
    })

    it("exits 2 on blocked", async () => {
      httpGetJson.mockResolvedValue({ timedOut: false, policyId: "pol_1", status: "blocked" })
      const code = await runPolicy(["wait", "pol_1"])
      expect(code).toBe(2)
    })
  })

  describe("ack — requires an explicit, unambiguous decision", () => {
    it("fails when neither --approve nor --reject is given", async () => {
      const code = await runPolicy(["ack", "pol_1"])
      expect(code).toBe(2)
      expect(stderrChunks.join("")).toContain("exactly one of --approve or --reject")
      expect(httpPostJson).not.toHaveBeenCalled()
    })

    it("fails when both --approve and --reject are given", async () => {
      const code = await runPolicy(["ack", "pol_1", "--approve", "--reject"])
      expect(code).toBe(2)
      expect(httpPostJson).not.toHaveBeenCalled()
    })

    it("--approve posts { approve: true }", async () => {
      httpPostJson.mockResolvedValue({ policyId: "pol_1", status: "done", sha: "abc123def456" })
      const code = await runPolicy(["ack", "pol_1", "--approve"])
      expect(code).toBe(0)
      const [url, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
      expect(url).toContain("/policies/pol_1/ack")
      expect(body).toEqual({ approve: true })
    })

    it("--reject posts { approve: false }", async () => {
      httpPostJson.mockResolvedValue({ policyId: "pol_1", status: "cancelled" })
      const code = await runPolicy(["ack", "pol_1", "--reject"])
      expect(code).toBe(0)
      const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
      expect(body).toEqual({ approve: false })
    })
  })

  describe("ls", () => {
    it("renders the policies from GET /policies", async () => {
      httpGetJson.mockResolvedValue({
        policies: [
          { policyId: "pol_1", status: "watching", sessionIds: ["s1"], startedAt: "2026-07-15T00:00:00.000Z" },
        ],
      })
      const code = await runPolicy(["ls"])
      expect(code).toBe(0)
      expect(stdoutChunks.join("")).toContain("pol_1")
    })
  })

  describe("cancel", () => {
    it("posts to /policies/:id/cancel", async () => {
      httpPostJson.mockResolvedValue({ policyId: "pol_1", status: "cancelled" })
      const code = await runPolicy(["cancel", "pol_1"])
      expect(code).toBe(0)
      const url = httpPostJson.mock.calls[0]?.[0]
      expect(url).toContain("/policies/pol_1/cancel")
    })

    it("exits 3 on a 404 (policy not found)", async () => {
      httpPostJson.mockRejectedValue(new Error("HTTP 404: not found"))
      const code = await runPolicy(["cancel", "pol_missing"])
      expect(code).toBe(3)
    })
  })
})
