/**
 * WP-C1 — `agentproto sessions start --slug` and `sessions terminal --slug`.
 *
 * The CLI twins of the daemon's session `slug` (the addressable handle). The
 * `start` flag forwards `body.slug`; `terminal`'s long-standing `--name` is kept
 * as an alias (both map to the spawn's slug), with `--slug` winning when both
 * are passed.
 *
 * Follows the fake-daemon pattern in sessions-prompt.test.ts: intercept
 * `discoverDaemon` + `httpPostJson` so no socket IO happens, then assert on the
 * captured POST body.
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

const descriptor = {
  id: "sess_new",
  kind: "agent-cli",
  status: "running",
  command: "claude-code (agent)",
}

describe("sessions start --slug", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    stdoutSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation(() => true)
    stderrSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stderr as any, "write")
      .mockImplementation(() => true)
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpPostJson.mockResolvedValue({ ...descriptor })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("forwards --slug as body.slug on POST /sessions/agent", async () => {
    const code = await runSessions(["start", "claude-code", "--slug", "my-handle"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledTimes(1)
    const [url, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe("http://127.0.0.1:18790/sessions/agent")
    expect(body.slug).toBe("my-handle")
    expect(body.adapter).toBe("claude-code")
  })

  it("omits slug when --slug is not given", async () => {
    const code = await runSessions(["start", "claude-code"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.slug).toBeUndefined()
  })

  it("keeps --slug distinct from the display fields", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--slug",
      "the-handle",
      "--label",
      "A Label",
      "--title",
      "A Title",
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.slug).toBe("the-handle")
    expect(body.label).toBe("A Label")
    expect(body.title).toBe("A Title")
  })

  it("maps sessions terminal --slug onto the spawn's name (the slug)", async () => {
    const code = await runSessions(["terminal", "--slug", "dev-shell", "--", "bash"])
    expect(code).toBe(0)
    const [url, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe("http://127.0.0.1:18790/sessions/terminal")
    expect(body.name).toBe("dev-shell")
  })

  it("keeps sessions terminal --name working as the slug alias", async () => {
    const code = await runSessions(["terminal", "--name", "legacy-name", "--", "bash"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.name).toBe("legacy-name")
  })

  it("prefers --slug over --name when both are passed to terminal", async () => {
    const code = await runSessions([
      "terminal",
      "--name",
      "old",
      "--slug",
      "new",
      "--",
      "bash",
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.name).toBe("new")
  })
})
