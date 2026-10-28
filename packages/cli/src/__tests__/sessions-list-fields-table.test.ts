/**
 * `agentproto sessions list --fields a,b` without `--json` renders a plain
 * table of exactly the requested columns. The daemon projects rows down to
 * the listed fields (plus `id`), so the full-descriptor table renderer must
 * not be fed those rows.
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

describe("agentproto sessions list --fields (table output)", () => {
  let out: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    out = []
    stdoutSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation((chunk: unknown) => {
        out.push(String(chunk))
        return true
      })
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:18790", token: "tok" }, stale: [] })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
    httpGetJson.mockReset()
  })

  const lines = (): string[] =>
    out
      .join("")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .filter(l => l !== "")

  it("renders projected rows with exactly the requested columns, in order", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [
        { id: "sess_a", status: "running", alive: true },
        { id: "sess_b", status: "exited", alive: false },
      ],
      total: 2,
    })
    expect(await runSessions(["list", "--q", "sess", "--fields", "id,status,alive"])).toBe(0)
    const l = lines()
    expect(l[0]!.split(/\s+/)).toEqual(["ID", "STATUS", "ALIVE"])
    expect(l[1]!.split(/\s+/)).toEqual(["sess_a", "running", "true"])
    expect(l[2]!.split(/\s+/)).toEqual(["sess_b", "exited", "false"])
  })

  it("honours the requested order and drops the daemon-injected id when not requested", async () => {
    httpGetJson.mockResolvedValue({ sessions: [{ id: "sess_a", status: "running", kind: "agent-cli" }] })
    expect(await runSessions(["list", "--fields", "status,kind"])).toBe(0)
    const l = lines()
    expect(l[0]!.split(/\s+/)).toEqual(["STATUS", "KIND"])
    expect(l[1]!.split(/\s+/)).toEqual(["running", "agent-cli"])
  })

  it("prints - for missing/unknown fields and JSON-stringifies objects", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [{ id: "sess_a", labels: ["a", "b"], meta: { x: 1 }, nothing: null }],
    })
    expect(await runSessions(["list", "--fields", "id,bogus,nothing,labels,meta"])).toBe(0)
    const row = lines()[1]!
    expect(row.split(/\s{2,}/)).toEqual(["sess_a", "-", "-", '["a","b"]', '{"x":1}'])
  })

  it("keeps --json output as the raw projected JSON", async () => {
    httpGetJson.mockResolvedValue({ sessions: [{ id: "sess_a", status: "running" }] })
    expect(await runSessions(["list", "--json", "--fields", "status"])).toBe(0)
    expect(JSON.parse(out.join(""))).toEqual([{ id: "sess_a", status: "running" }])
  })

  it("reports an empty result instead of an empty table", async () => {
    httpGetJson.mockResolvedValue({ sessions: [], total: 0 })
    expect(await runSessions(["list", "--fields", "id,status"])).toBe(0)
    expect(lines()[0]).toBe("No sessions.")
  })

  it.each([" ", ",", " , "])("blank --fields %j sends no fields param and renders the full table", async raw => {
    httpGetJson.mockResolvedValue({
      sessions: [
        {
          id: "sess_a",
          kind: "agent-cli",
          workspaceSlug: "default",
          command: "claude",
          status: "running",
          startedAt: "2026-10-09T10:00:00.000Z",
          cwd: "/tmp/ws",
        },
      ],
    })
    expect(await runSessions(["list", "--fields", raw])).toBe(0)
    const url = new URL(String(httpGetJson.mock.calls.at(-1)?.[0]))
    expect(url.searchParams.has("fields")).toBe(false)
    expect(lines()[0]).toContain("WORKSPACE")
  })

  it("sends the normalized field list to the daemon", async () => {
    httpGetJson.mockResolvedValue({ sessions: [{ id: "sess_a", status: "running" }] })
    await runSessions(["list", "--fields", " id, status ,,id"])
    const url = new URL(String(httpGetJson.mock.calls.at(-1)?.[0]))
    expect(url.searchParams.get("fields")).toBe("id,status")
  })
})
