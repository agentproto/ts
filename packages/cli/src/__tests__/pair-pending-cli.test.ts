/**
 * `agentproto pair pending|confirm|decline`: HTTP parity for the daemon's
 * pending-pairing routes (AIP-59 §3.7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runPair } from "../commands/pair.js"

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

describe("agentproto pair pending / confirm / decline", () => {
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

  it("lists pending pairings with their short code", async () => {
    httpGetJson.mockResolvedValue({
      pending: [
        {
          id: "abcdef0123456789abcdef0123456789",
          fingerprint: "abcdef0123456789abcdef0123456789",
          code: "abcdef01",
          name: "phone",
          createdAt: "2026-11-04T00:00:00.000Z",
          expiresAt: "2026-11-04T00:10:00.000Z",
          rendezvous: "wss://rdv.example/v1",
        },
      ],
    })
    const code = await runPair(["pending"])
    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:1/pairings/pending")
    expect(stdoutChunks.join("")).toContain("abcdef01")
    expect(stdoutChunks.join("")).toContain("phone")
  })

  it("confirm posts the target and exits 0", async () => {
    httpPostJson.mockResolvedValue({ ok: true, confirmed: "abcdef01" })
    const code = await runPair(["confirm", "abcdef01"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:1/pairings/confirm",
      { target: "abcdef01" },
      "apt_test",
    )
    expect(stdoutChunks.join("")).toContain("Confirmed pending pairing")
  })

  it("decline posts the target and exits 0", async () => {
    httpPostJson.mockResolvedValue({ ok: true, declined: "abcdef01" })
    const code = await runPair(["decline", "abcdef01"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:1/pairings/decline",
      { target: "abcdef01" },
      "apt_test",
    )
    expect(stdoutChunks.join("")).toContain("Declined pending pairing")
  })

  it("a missing target is a usage error", async () => {
    expect(await runPair(["confirm"])).toBe(2)
    expect(stderrChunks.join("")).toContain("missing <code|fingerprint>")
    expect(httpPostJson).not.toHaveBeenCalled()
  })
})
