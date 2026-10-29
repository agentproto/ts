import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runSessions } from "../commands/sessions.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    httpPostJson: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)
const httpPostJson = vi.mocked(helpers.httpPostJson)

describe("sessions restart keeps the billing route", () => {
  let stdoutSpy: { mockRestore(): void }

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    } as Awaited<ReturnType<typeof helpers.discoverDaemon>>)
    httpGetJson.mockResolvedValue({
      id: "sess_old",
      kind: "agent-cli",
      status: "killed",
      adapterSlug: "opencode",
      adapterSessionId: "ses_native",
      workspaceSlug: "default",
      command: "opencode acp",
      cwd: process.cwd(),
      model: "opencode-go/beam-free",
      route: { gateway: "opencode-go" },
      accessProfile: { profileRef: "opencode-developerws003", endpoint: "opencode-go", method: "api-key" },
      modelPolicy: { allow: ["zero-cost"] },
      parentSessionId: "sess_parent",
      contextContinuity: { mode: "auto", autoCompactAtTokens: 150000 },
    } as Awaited<ReturnType<typeof helpers.httpGetJson>>)
    httpPostJson.mockResolvedValue({
      id: "sess_new",
      kind: "agent-cli",
      status: "running",
      command: "opencode acp",
      model: "opencode-go/beam-free",
    } as Awaited<ReturnType<typeof helpers.httpPostJson>>)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.clearAllMocks()
  })

  it("uses the daemon restart path so a plain restart retains the account and policy", async () => {
    expect(await runSessions(["restart", "sess_old"])).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sessions/sess_old/restart",
      { contextContinuity: { mode: "auto", autoCompactAtTokens: 150000 } },
      "tok",
    )
  })

  it("changes Zen to Go with model and account in one validated restart", async () => {
    expect(await runSessions([
      "restart", "sess_old", "--model", "opencode-go/beam-free",
      "--access-profile", "opencode-developerws003",
    ])).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sessions/sess_old/restart",
      {
        model: "opencode-go/beam-free",
        access: { profileRef: "opencode-developerws003" },
        contextContinuity: { mode: "auto", autoCompactAtTokens: 150000 },
      },
      "tok",
    )
  })
})
