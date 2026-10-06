/**
 * `agentproto sessions checkpoint` / `sessions handoff` — flag parsing and the
 * HTTP call each verb makes. Same fake-daemon pattern as sessions-queue.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"

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
const httpPostJson = vi.mocked(helpers.httpPostJson)

describe("agentproto sessions checkpoint / handoff", () => {
  let out: string[]
  let err: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    out = []
    err = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdoutSpy = vi.spyOn(process.stdout as any, "write").mockImplementation((c: unknown) => {
      out.push(String(c))
      return true
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stderrSpy = vi.spyOn(process.stderr as any, "write").mockImplementation((c: unknown) => {
      err.push(String(c))
      return true
    })
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:18790", token: "tok" }, stale: [] })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("`checkpoint --help` and `handoff --help` print their own usage", async () => {
    expect(await runSessions(["checkpoint", "--help"])).toBe(0)
    expect(out.join("")).toContain("agentproto sessions checkpoint <id-or-name>")
    out.length = 0
    expect(await runSessions(["handoff", "--help"])).toBe(0)
    expect(out.join("")).toContain("--to <harness>")
    expect(out.join("")).toContain("--dry-run")
  })

  it("checkpoint POSTs /sessions/:id/checkpoint with the note and prints the path", async () => {
    httpPostJson.mockResolvedValueOnce({ checkpointId: "ckpt_1", path: "/h/.agentproto/sessions/s/checkpoints/ckpt_1.json" })
    const code = await runSessions(["checkpoint", "my-session", "--note", "keep zod"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sessions/my-session/checkpoint",
      { notes: "keep zod" },
      "tok",
    )
    expect(out.join("")).toContain("/h/.agentproto/sessions/s/checkpoints/ckpt_1.json")
  })

  it("checkpoint sends an empty body without --note, and --json prints the response", async () => {
    httpPostJson.mockResolvedValueOnce({ checkpointId: "ckpt_1", path: "/p" })
    expect(await runSessions(["checkpoint", "sess_1", "--json"])).toBe(0)
    expect(httpPostJson.mock.calls[0]![1]).toEqual({})
    expect(JSON.parse(out.join(""))).toEqual({ checkpointId: "ckpt_1", path: "/p" })
  })

  it("checkpoint with no id exits 2 without calling the daemon", async () => {
    expect(await runSessions(["checkpoint"])).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
  })

  it("handoff maps flags to the request body", async () => {
    httpPostJson.mockResolvedValueOnce({
      continuedFrom: "sess_a",
      continuedTo: "sess_b",
      path: "/ckpt.json",
      handoff: { fromHarness: "claude-code", toHarness: "codex" },
    })
    const code = await runSessions([
      "handoff", "sess_a", "--to", "codex", "--model", "gpt-5", "--profile", "openai-main", "--note", "n",
    ])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sessions/sess_a/handoff",
      { to: "codex", model: "gpt-5", access: { profileRef: "openai-main" }, notes: "n" },
      "tok",
    )
    const text = out.join("")
    expect(text).toContain("sess_b")
    expect(text).toContain("codex")
    expect(text).toContain("/ckpt.json")
  })

  it("handoff --dry-run sends dryRun:true and prints the checkpoint prompt", async () => {
    httpPostJson.mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      checkpoint: { checkpointPath: "/would/write.json" },
      prompt: "[continued session — handoff]",
    })
    expect(await runSessions(["handoff", "sess_a", "--to", "codex", "--dry-run"])).toBe(0)
    expect(httpPostJson.mock.calls[0]![1]).toEqual({ to: "codex", dryRun: true })
    const text = out.join("")
    expect(text).toContain("nothing spawned")
    expect(text).toContain("[continued session")
  })

  it("handoff --dry-run says the content is approximate (daemon note, or a fallback for older daemons)", async () => {
    httpPostJson.mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      approximateNote: "Approximate content from the daemon.",
      checkpoint: { checkpointPath: "/would/write.json" },
      prompt: "[continued session — handoff]",
    })
    expect(await runSessions(["handoff", "sess_a", "--to", "codex", "--dry-run"])).toBe(0)
    expect(out.join("")).toContain("Approximate content from the daemon.")

    out.length = 0
    httpPostJson.mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      checkpoint: { checkpointPath: "/would/write.json" },
      prompt: "[continued session — handoff]",
    })
    expect(await runSessions(["handoff", "sess_a", "--to", "codex", "--dry-run"])).toBe(0)
    expect(out.join("")).toContain("approximate content")
    expect(out.join("")).toContain("asks it to summarise itself first")
  })

  it("handoff without --to exits 2 without calling the daemon", async () => {
    expect(await runSessions(["handoff", "sess_a"])).toBe(2)
    expect(err.join("")).toContain("--to <harness> is required")
    expect(httpPostJson).not.toHaveBeenCalled()
  })

  it("handoff rejects an unknown flag with exit 2", async () => {
    expect(await runSessions(["handoff", "sess_a", "--to", "codex", "--bogus"])).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
  })

  it("handoff on an unknown session reports it and exits 2", async () => {
    httpPostJson.mockRejectedValueOnce(new Error('HTTP 404: {"error":"no_such_session","id":"nope"}'))
    expect(await runSessions(["handoff", "nope", "--to", "codex"])).toBe(2)
    expect(err.join("")).toContain('no session "nope"')
  })
})
