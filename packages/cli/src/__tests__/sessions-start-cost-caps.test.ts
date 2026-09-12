/**
 * `agentproto sessions start --max-cost-usd / --cost-budget` — the CLI
 * twins of the MCP `agent_start` `maxCostUsd` / `costBudget` spawn fields.
 *
 * Follows the fake-daemon pattern in sessions-start.test.ts: intercept
 * `discoverDaemon` and `httpPostJson` from _daemon-helpers so no real
 * socket IO happens, then assert on the POST body captured from the mock.
 *
 * The two fields are deliberately NOT interchangeable and the help says so:
 *   --max-cost-usd  the HARD ceiling — daemon kills the session at turn end.
 *   --cost-budget   a windowed governance cap that NEVER kills the session;
 *                   crossing it trips a policy for a supervisor to act on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpPostJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpPostJson = vi.mocked(helpers.httpPostJson)

describe("agentproto sessions start — --max-cost-usd / --cost-budget", () => {
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
    httpPostJson.mockResolvedValue({
      id: "sess_001",
      kind: "agent",
      status: "running",
      command: "claude-code",
      workspaceSlug: "default",
      startedAt: new Date().toISOString(),
    })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("USAGE documents both flags and keeps their semantics distinct", async () => {
    const code = await runSessions(["--help"])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    expect(out).toContain("--max-cost-usd")
    expect(out).toContain("--cost-budget")
    // The two must not blur: maxCostUsd kills, costBudget never does.
    expect(out).toMatch(/--max-cost-usd <n>\s+HARD spend ceiling/)
    expect(out).toMatch(/NEVER kills the session/)
  })

  it("sends body.maxCostUsd for --max-cost-usd", async () => {
    const code = await runSessions(["start", "claude-code", "--max-cost-usd", "5"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.maxCostUsd).toBe(5)
    expect(body.costBudget).toBeUndefined()
  })

  it("rejects a non-numeric --max-cost-usd before any network call", async () => {
    const code = await runSessions(["start", "claude-code", "--max-cost-usd", "abc"])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(discoverDaemon).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("invalid --max-cost-usd")
  })

  it("rejects a non-positive --max-cost-usd", async () => {
    const code = await runSessions(["start", "claude-code", "--max-cost-usd", "0"])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
  })

  it("parses the compact --cost-budget spelling with an explicit scope", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--cost-budget",
      "20:5h:profile",
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.costBudget).toEqual({ maxCostUsd: 20, window: "5h", scope: "profile" })
    expect(body.maxCostUsd).toBeUndefined()
  })

  it("defaults the compact spelling's scope to 'session'", async () => {
    const code = await runSessions(["start", "claude-code", "--cost-budget", "15:7d"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.costBudget).toEqual({ maxCostUsd: 15, window: "7d", scope: "session" })
  })

  it("accepts an ISO-8601 window in the compact spelling", async () => {
    const code = await runSessions(["start", "claude-code", "--cost-budget", "30:P7D"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.costBudget).toEqual({ maxCostUsd: 30, window: "P7D", scope: "session" })
  })

  it("accepts the full JSON-object spelling of --cost-budget", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--cost-budget",
      '{"maxCostUsd":20,"window":"5h","scope":"profile"}',
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.costBudget).toEqual({ maxCostUsd: 20, window: "5h", scope: "profile" })
  })

  it("defaults a missing scope on the JSON-object spelling to 'session'", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--cost-budget",
      '{"maxCostUsd":20,"window":"5h"}',
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.costBudget).toEqual({ maxCostUsd: 20, window: "5h", scope: "session" })
  })

  it("rejects malformed --cost-budget JSON before any network call", async () => {
    const code = await runSessions(["start", "claude-code", "--cost-budget", "{oops"])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(discoverDaemon).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("invalid --cost-budget JSON")
  })

  it("rejects a --cost-budget JSON object with a bad shape", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--cost-budget",
      '{"maxCostUsd":-1,"window":"5h","scope":"session"}',
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("maxCostUsd must be a positive number")
  })

  it("rejects a --cost-budget scope outside session|profile", async () => {
    const code = await runSessions(["start", "claude-code", "--cost-budget", "20:5h:galaxy"])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain('expected "session" or "profile"')
  })

  it("omits both fields from the body when neither flag is passed", async () => {
    const code = await runSessions(["start", "claude-code"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.maxCostUsd).toBeUndefined()
    expect(body.costBudget).toBeUndefined()
  })

  it("combo: --access-profile + profile-scoped --cost-budget wire both on the body", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--access-profile",
      "claude-max",
      "--cost-budget",
      "20:5h:profile",
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.access).toEqual({ profileRef: "claude-max" })
    expect(body.costBudget).toEqual({ maxCostUsd: 20, window: "5h", scope: "profile" })
  })
})