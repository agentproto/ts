import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { countFreeLocalSessions, runUsage } from "../commands/usage.js"

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

describe("countFreeLocalSessions", () => {
  it("counts alive local sessions on a free model", () => {
    const rows = [
      { id: "a", alive: true, model: "opencode/glm-5.3-flash-free" },
      { id: "b", alive: true, model: "opencode/deepseek-v4.1-flash-free" },
      { id: "c", alive: true, model: "opencode-go/glm-5.3" },
      { id: "d", alive: true, remote: true, model: "opencode/glm-5.3-flash-free" },
      { id: "e", alive: false, model: "opencode/glm-5.3-flash-free" },
      { id: "f", alive: true },
    ]
    // a+b count; c is paid, d is sandbox, e is dead, f has no model yet.
    expect(countFreeLocalSessions(rows)).toBe(2)
  })
})

describe("agentproto usage plan", () => {
  let stdoutChunks: string[]
  let stderrChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    stdoutChunks = []
    stderrChunks = []
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdoutChunks.push(String(chunk))
      return true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrChunks.push(String(chunk))
      return true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: undefined },
      stale: [],
    })
    httpGetJson.mockResolvedValue({ sessions: [] })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.clearAllMocks()
  })

  it("reads the daemon's { sessions } envelope and applies the 2-free-local cap", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [
        { id: "a", alive: true, model: "opencode/glm-5.3-flash-free" },
        { id: "b", alive: true, model: "opencode/deepseek-v4.1-flash-free" },
        { id: "c", alive: true, model: "opencode-go/glm-5.3" },
        { id: "d", alive: true, remote: true, model: "opencode/glm-5.3-flash-free" },
      ],
      total: 4,
    })

    const code = await runUsage(["plan", "explore", "--json"])
    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sessions?onlyAlive=true",
    )
    const body = JSON.parse(stdoutChunks.join(""))
    expect(body.freeLocalInUse).toBe(2)
    expect(body.plan.place).toBe("sandbox")
    expect(body.plan.resolvedModel).toBe("opencode/glm-5.3-flash-free")
    expect(body.freeLocalInUseError).toBeUndefined()
  })

  it("accepts a flag before the positional usage slug", async () => {
    const code = await runUsage(["plan", "--json", "pr-fix"])
    expect(code).toBe(0)
    expect(stderrChunks.join("")).not.toContain("missing required <usage>")
    const body = JSON.parse(stdoutChunks.join(""))
    expect(body.usage).toBe("pr-fix")
    expect(body.plan.place).toBe("sandbox")
  })

  it("surfaces a failed free-local count instead of silently reading 0", async () => {
    httpGetJson.mockRejectedValue(new Error("401 unauthorized"))

    const code = await runUsage(["plan", "implement", "--json"])
    expect(code).toBe(0)
    const body = JSON.parse(stdoutChunks.join(""))
    expect(body.freeLocalInUse).toBe(0)
    expect(body.freeLocalInUseError).toContain("401 unauthorized")
  })

  it("warns in human output when the free-local count is unverified", async () => {
    httpGetJson.mockRejectedValue(new Error("transport down"))

    const code = await runUsage(["plan", "implement"])
    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("free-local count UNVERIFIED")
    expect(stdoutChunks.join("")).toContain("transport down")
  })
})
