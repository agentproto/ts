/**
 * `agentproto remote enable --qr` asks the daemon for the opt-in tunnel
 * phone link (`phoneLink: true`) and tells the user, on stderr, that pairing
 * is the recommended phone path and that Cloudflare can read the link.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runRemote } from "../commands/remote.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpPostJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

vi.mock("../util/qr.js", () => ({ printQr: vi.fn(async () => {}) }))

const helpers = await import("../commands/_daemon-helpers.js")
const qr = await import("../util/qr.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpPostJson = vi.mocked(helpers.httpPostJson)
const printQr = vi.mocked(qr.printQr)

describe("agentproto remote enable --qr", () => {
  let stdoutChunks: string[]
  let stderrChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    stdoutChunks = []
    stderrChunks = []
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:1", token: "apt_test" }, stale: [] })
    httpPostJson.mockResolvedValue({
      provider: "quick",
      publicUrl: "https://fake.trycloudflare.com",
      bearerToken: "bearer_xyz",
      mcpEndpoint: "https://fake.trycloudflare.com/mcp",
      phoneUrl: "https://fake.trycloudflare.com/apps/@agentik/session-chat/ui#token=bearer_xyz",
      target: { host: "127.0.0.1", port: 18790 },
      exposesGateway: true,
    })
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
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.clearAllMocks()
  })

  it("passes phoneLink: true, prints the stderr notice and renders the QR, exit 0", async () => {
    const code = await runRemote(["enable", "--qr"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:1/remote/enable",
      { phoneLink: true },
      "apt_test",
    )
    const err = stderrChunks.join("")
    expect(err).toContain("pairing is the recommended phone path")
    expect(err).toContain("agentproto pair offer --qr")
    expect(err).toContain("readable by Cloudflare")
    expect(printQr).toHaveBeenCalledWith(
      "https://fake.trycloudflare.com/apps/@agentik/session-chat/ui#token=bearer_xyz",
    )
  })

  it("does not ask for a phone link without --qr", async () => {
    const code = await runRemote(["enable"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith("http://127.0.0.1:1/remote/enable", {}, "apt_test")
    expect(stderrChunks.join("")).not.toContain("readable by Cloudflare")
    expect(printQr).not.toHaveBeenCalled()
  })
})
