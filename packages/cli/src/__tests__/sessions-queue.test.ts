/**
 * Integration tests for `agentproto sessions queue <id>` — the CLI parity
 * verb for the daemon's queue-surface (list + the promote/deliver/drop
 * per-item ops). Follows the fake-daemon pattern in sessions-start.test.ts:
 * intercept `discoverDaemon` / `httpGetJson` / `httpPostJson` / `httpDelete`
 * from _daemon-helpers so no real socket IO happens, then assert on the url
 * / body captured from the mocks and the rendered stdout.
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
    httpDelete: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)
const httpPostJson = vi.mocked(helpers.httpPostJson)
const httpDelete = vi.mocked(helpers.httpDelete)

interface QueueViewItem {
  id: string
  origin: string
  preview: string
  queuedAt: string
  position: number
}

const QUEUE: QueueViewItem[] = [
  { id: "q_aaa", origin: "user", preview: "first prompt", queuedAt: "2026-08-17T10:00:00.000Z", position: 0 },
  { id: "q_bbb", origin: "agent sess_child1", preview: "report from child", queuedAt: "2026-08-17T10:01:00.000Z", position: 1 },
]

function mockList(queue: QueueViewItem[]): void {
  httpGetJson.mockResolvedValueOnce({ ok: true, queue })
}

describe("agentproto sessions queue", () => {
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
    httpPostJson.mockResolvedValue({ ok: true })
    httpDelete.mockResolvedValue({ ok: true, removed: true })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("lists the queue by GET /sessions/:id/queue, 1-indexing the positions", async () => {
    mockList(QUEUE)
    const code = await runSessions(["queue", "sess_1"])
    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sessions/sess_1/queue",
    )
    expect(httpPostJson).not.toHaveBeenCalled()
    const out = stdoutChunks.join("")
    expect(out).toContain("first prompt")
    expect(out).toContain("agent sess_child1") // origin rendered
    // Positions are 1-indexed for display: index 0 → "1", index 1 → "2".
    expect(out).toMatch(/^1\s+user/m) // position 1 (next to dispatch)
    expect(out).toMatch(/^2\s+agent sess_child1/m)
  })

  it("--json prints the raw queue without a table", async () => {
    mockList(QUEUE)
    const code = await runSessions(["queue", "sess_1", "--json"])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdoutChunks.join(""))
    expect(parsed).toMatchObject({ ok: true, id: "sess_1" })
    expect(parsed.queue).toHaveLength(2)
  })

  it("--force <n> POSTs promote for the item at 1-indexed position n, then re-lists", async () => {
    mockList(QUEUE)
    mockList(QUEUE) // re-list after the action
    const code = await runSessions(["queue", "sess_1", "--force", "2"])
    expect(code).toBe(0)
    // Position 2 (1-indexed) = index 1 = q_bbb → /promote by queueId.
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sessions/sess_1/queue/q_bbb/promote",
      {},
      "tok",
    )
    expect(httpDelete).not.toHaveBeenCalled()
    expect(stdoutChunks.join("")).toContain("position 2 promoted to front")
  })

  it("--deliver <n> POSTs deliver (the interrupt-and-dispatch op) — distinct from promote", async () => {
    mockList(QUEUE)
    mockList(QUEUE)
    const code = await runSessions(["queue", "sess_1", "--deliver", "1"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sessions/sess_1/queue/q_aaa/deliver",
      {},
      "tok",
    )
    expect(stdoutChunks.join("")).toContain("position 1 delivered now")
  })

  it("--drop <n> DELETEs the item at 1-indexed position n", async () => {
    mockList(QUEUE)
    mockList([QUEUE[1]!]) // post-drop re-list (first item gone)
    const code = await runSessions(["queue", "sess_1", "--drop", "1"])
    expect(code).toBe(0)
    expect(httpDelete).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sessions/sess_1/queue/q_aaa",
      "tok",
    )
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stdoutChunks.join("")).toContain("position 1 dropped")
  })

  it("--force and --deliver are mutually exclusive (never overloaded)", async () => {
    const code = await runSessions(["queue", "sess_1", "--force", "1", "--deliver", "2"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("choose one of")
    expect(httpGetJson).not.toHaveBeenCalled()
  })

  it("rejects an out-of-range position without calling a mutator", async () => {
    mockList(QUEUE)
    const code = await runSessions(["queue", "sess_1", "--drop", "99"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("out of range")
    expect(httpDelete).not.toHaveBeenCalled()
  })

  it("rejects multiple positionals with a usage error", async () => {
    const code = await runSessions(["queue", "sess_1", "sess_2"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("unexpected extra positionals")
    expect(httpGetJson).not.toHaveBeenCalled()
  })
})