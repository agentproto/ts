/**
 * `agentproto devices list|rename|revoke` — the CLI counterpart to the
 * `device_*` MCP tools / `/devices` REST routes (DEVICES-PLAN PR-A).
 *
 * Fake-daemon pattern (see sessions-pin.test.ts): intercept `discoverDaemon`
 * / `httpGetJson` / `httpPatchRaw` / `httpDelete` from _daemon-helpers so no
 * real socket IO happens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runDevices } from "../commands/devices.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    httpPostJson: vi.fn(),
    httpPatchRaw: vi.fn(),
    httpDelete: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)
const httpPostJson = vi.mocked(helpers.httpPostJson)
const httpPatchRaw = vi.mocked(helpers.httpPatchRaw)
const httpDelete = vi.mocked(helpers.httpDelete)
const printNoDaemonError = vi.mocked(helpers.printNoDaemonError)

describe("agentproto devices", () => {
  let out: string[]
  let err: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spies: any[]

  beforeEach(() => {
    out = []
    err = []
    spies = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(process.stdout as any, "write").mockImplementation((c: unknown) => (out.push(String(c)), true)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(process.stderr as any, "write").mockImplementation((c: unknown) => (err.push(String(c)), true)),
    ]
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:18790", token: "tok" }, stale: [] })
  })
  afterEach(() => {
    for (const s of spies) s.mockRestore()
    vi.resetAllMocks()
  })

  describe("list", () => {
    it("prints a table of devices", async () => {
      httpGetJson.mockResolvedValue({
        devices: [
          {
            fingerprint: "fp1",
            name: "jeremy@laptop",
            role: "client",
            kind: "cli",
            rendezvous: "wss://rdv.example/v1",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastSeen: "2026-01-02T00:00:00.000Z",
            online: true,
          },
        ],
      })
      const code = await runDevices(["list"])
      expect(code).toBe(0)
      expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:18790/devices")
      const text = out.join("")
      expect(text).toContain("jeremy@laptop")
      expect(text).toContain("fp1")
      expect(text).toContain("yes")
    })

    it("--json prints the raw payload", async () => {
      httpGetJson.mockResolvedValue({ devices: [] })
      const code = await runDevices(["list", "--json"])
      expect(code).toBe(0)
      expect(JSON.parse(out.join(""))).toEqual({ devices: [] })
    })

    it("no devices prints a plain message", async () => {
      httpGetJson.mockResolvedValue({ devices: [] })
      const code = await runDevices(["list"])
      expect(code).toBe(0)
      expect(out.join("")).toContain("No devices.")
    })

    it("no daemon found exits 2", async () => {
      discoverDaemon.mockResolvedValue({ found: null, stale: [] })
      const code = await runDevices(["list"])
      expect(code).toBe(2)
      expect(printNoDaemonError).toHaveBeenCalled()
      expect(httpGetJson).not.toHaveBeenCalled()
    })

    it("a failed request surfaces the error and exits 1", async () => {
      httpGetJson.mockRejectedValue(new Error("HTTP 500: boom"))
      const code = await runDevices(["list"])
      expect(code).toBe(1)
      expect(err.join("")).toContain("boom")
    })
  })

  describe("rename", () => {
    it("PATCHes /devices/:target with the new name", async () => {
      httpPatchRaw.mockResolvedValue({ status: 200, body: { ok: true } })
      const code = await runDevices(["rename", "fp1", "new-name"])
      expect(code).toBe(0)
      expect(httpPatchRaw).toHaveBeenCalledWith(
        "http://127.0.0.1:18790/devices/fp1",
        { name: "new-name" },
        "tok",
      )
      expect(out.join("")).toContain('Renamed "fp1" to "new-name"')
    })

    it("missing args exits 2 without a network call", async () => {
      const code = await runDevices(["rename", "fp1"])
      expect(code).toBe(2)
      expect(httpPatchRaw).not.toHaveBeenCalled()
    })

    it("a 404 from the daemon surfaces its message and exits 1", async () => {
      httpPatchRaw.mockResolvedValue({ status: 404, body: { error: "not_found", message: 'no device matched "nope"' } })
      const code = await runDevices(["rename", "nope", "x"])
      expect(code).toBe(1)
      expect(err.join("")).toContain('no device matched "nope"')
    })
  })

  describe("revoke", () => {
    it("DELETEs /devices/:target", async () => {
      httpDelete.mockResolvedValue({ ok: true, revoked: "fp1" })
      const code = await runDevices(["revoke", "fp1"])
      expect(code).toBe(0)
      expect(httpDelete).toHaveBeenCalledWith("http://127.0.0.1:18790/devices/fp1", "tok")
      expect(out.join("")).toContain('Revoked device "fp1"')
    })

    it("missing target exits 2 without a network call", async () => {
      const code = await runDevices(["revoke"])
      expect(code).toBe(2)
      expect(httpDelete).not.toHaveBeenCalled()
    })
  })

  describe("add", () => {
    it("POSTs /devices/add with the offer URL and optional name", async () => {
      httpPostJson.mockResolvedValue({
        fingerprint: "fp1",
        name: "my-host",
        rendezvousUrl: "wss://rdv.example/v1",
      })
      const code = await runDevices(["add", "agentproto://pair?v=2&…&scope=host", "--name", "my-host"])
      expect(code).toBe(0)
      expect(httpPostJson).toHaveBeenCalledWith(
        "http://127.0.0.1:18790/devices/add",
        { offerUrl: "agentproto://pair?v=2&…&scope=host", name: "my-host" },
        "tok",
      )
      expect(out.join("")).toContain("Added host fp1")
      expect(out.join("")).toContain("my-host")
    })

    it("missing offer-url exits 2 without a network call", async () => {
      const code = await runDevices(["add"])
      expect(code).toBe(2)
      expect(httpPostJson).not.toHaveBeenCalled()
    })

    it("a refused (non-host-scoped) offer surfaces the daemon's message and exits 1", async () => {
      httpPostJson.mockRejectedValue(new Error('HTTP 400: {"message":"this offer is not host-scoped"}'))
      const code = await runDevices(["add", "agentproto://pair?v=2&…"])
      expect(code).toBe(1)
      expect(err.join("")).toContain("not host-scoped")
    })

    it("no daemon found exits 2", async () => {
      discoverDaemon.mockResolvedValue({ found: null, stale: [] })
      const code = await runDevices(["add", "agentproto://pair?v=2&…"])
      expect(code).toBe(2)
      expect(httpPostJson).not.toHaveBeenCalled()
    })
  })

  describe("status", () => {
    it("POSTs /devices/:target/exec with path /health and prints the JSON body", async () => {
      httpPostJson.mockResolvedValue({
        status: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
      })
      const code = await runDevices(["status", "my-host"])
      expect(code).toBe(0)
      expect(httpPostJson).toHaveBeenCalledWith(
        "http://127.0.0.1:18790/devices/my-host/exec",
        { path: "/health" },
        "tok",
      )
      expect(out.join("")).toContain("HTTP 200")
      expect(out.join("")).toContain('"ok": true')
    })

    it("a non-2xx status exits 1", async () => {
      httpPostJson.mockResolvedValue({
        status: 502,
        headers: {},
        bodyBase64: Buffer.from("bad gateway").toString("base64"),
      })
      const code = await runDevices(["status", "my-host"])
      expect(code).toBe(1)
      expect(out.join("")).toContain("HTTP 502")
    })

    it("missing target exits 2 without a network call", async () => {
      const code = await runDevices(["status"])
      expect(code).toBe(2)
      expect(httpPostJson).not.toHaveBeenCalled()
    })

    it("an unreachable host surfaces the error and exits 1", async () => {
      httpPostJson.mockRejectedValue(new Error("HTTP 502: could not reach host"))
      const code = await runDevices(["status", "my-host"])
      expect(code).toBe(1)
      expect(err.join("")).toContain("could not reach host")
    })
  })

  it("--help prints usage without touching the daemon", async () => {
    const code = await runDevices(["--help"])
    expect(code).toBe(0)
    expect(out.join("")).toContain("agentproto devices")
    expect(discoverDaemon).not.toHaveBeenCalled()
  })

  it("an unknown subcommand exits 2", async () => {
    const code = await runDevices(["bogus"])
    expect(code).toBe(2)
    expect(err.join("")).toContain('unknown subcommand "bogus"')
  })
})
