/**
 * `agentproto sessions [list]` filter flags → `GET /sessions` query string.
 * Same fake-daemon pattern as sessions-json-fields.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)

const row = {
  id: "sess_a",
  kind: "agent-cli",
  workspaceSlug: "default",
  command: "claude",
  status: "running",
  startedAt: "2026-10-09T10:00:00.000Z",
  cwd: "/tmp/ws",
}

describe("agentproto sessions — list filter flags", () => {
  let out: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    out = []
    stdoutSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation((chunk: unknown) => {
        out.push(String(chunk))
        return true
      })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stderrSpy = vi.spyOn(process.stderr as any, "write").mockImplementation(() => true)
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:18790", token: "tok" }, stale: [] })
    httpGetJson.mockResolvedValue({ sessions: [row], total: 1 })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
    httpGetJson.mockReset()
  })

  const lastUrl = (): URL => new URL(String(httpGetJson.mock.calls.at(-1)?.[0]))

  it("without filter flags the request has no query string", async () => {
    expect(await runSessions(["--json"])).toBe(0)
    expect(String(httpGetJson.mock.calls.at(-1)?.[0])).toBe("http://127.0.0.1:18790/sessions")
  })

  it("maps every flag onto the matching query param, repeatable ones appended", async () => {
    const code = await runSessions([
      "list",
      "--json",
      "--q",
      "checkout",
      "--exclude-noise",
      "--exclude-label-prefix",
      "review:",
      "--exclude-label-prefix",
      "wf:",
      "--exclude-label",
      "scratch",
      "--exclude-kind",
      "command",
      "--root-only",
      "--parent",
      "sess_main",
      "--updated-since",
      "24h",
      "--started-since",
      "7d",
      "--status",
      "running",
      "--label",
      "chat 16:56",
      "--cwd",
      "/work/app",
      "--limit",
      "10",
    ])
    expect(code).toBe(0)
    const p = lastUrl().searchParams
    expect(lastUrl().pathname).toBe("/sessions")
    expect(p.get("q")).toBe("checkout")
    expect(p.get("excludeNoise")).toBe("true")
    expect(p.getAll("excludeLabelPrefix")).toEqual(["review:", "wf:"])
    expect(p.getAll("excludeLabels")).toEqual(["scratch"])
    expect(p.getAll("excludeKinds")).toEqual(["command"])
    expect(p.get("rootOnly")).toBe("true")
    expect(p.get("parentSessionId")).toBe("sess_main")
    expect(p.get("updatedSince")).toBe("24h")
    expect(p.get("startedSince")).toBe("7d")
    expect(p.get("status")).toBe("running")
    expect(p.get("label")).toBe("chat 16:56")
    expect(p.get("cwd")).toBe("/work/app")
    expect(p.get("limit")).toBe("10")
  })

  it("--label and --cwd each narrow the request on their own", async () => {
    await runSessions(["--json", "--label", "review:pr-1"])
    expect(lastUrl().searchParams.get("label")).toBe("review:pr-1")

    await runSessions(["--json", "--cwd", "/work/app"])
    expect(lastUrl().searchParams.get("cwd")).toBe("/work/app")
    expect(lastUrl().searchParams.get("label")).toBeNull()
  })

  it("--json stays a bare array even though the route returns {sessions,total}", async () => {
    await runSessions(["--json", "--q", "x"])
    expect(JSON.parse(out.join(""))).toEqual([row])
  })

  it("text mode reports the filtered count against the total", async () => {
    httpGetJson.mockResolvedValue({ sessions: [row], total: 40 })
    await runSessions(["--q", "x", "--limit", "1"])
    expect(out.join("")).toContain("1 of 40 matching sessions")
  })

  it("filters can't be combined with --watch", async () => {
    expect(await runSessions(["--watch", "--q", "x"])).toBe(2)
    expect(httpGetJson).not.toHaveBeenCalled()
  })
})
