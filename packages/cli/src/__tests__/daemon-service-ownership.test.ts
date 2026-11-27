/**
 * `daemon stop|restart|uninstall` ownership guard: they act on the one
 * per-user service, so a process under another HOME or port (an isolated
 * test daemon) must not be able to take it down by accident.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { evaluateServiceOwnership, parseServicePort, runDaemon } from "../commands/daemon.js"

const SAME = {
  currentHome: "/Users/me",
  serviceHome: "/Users/me",
  currentPort: 18790,
  servicePort: 18790,
}

describe("evaluateServiceOwnership", () => {
  it("allows the service's own HOME and port", () => {
    expect(evaluateServiceOwnership("stop", SAME)).toBeNull()
  })

  it("refuses a different HOME with a clear message", () => {
    const msg = evaluateServiceOwnership("stop", { ...SAME, currentHome: "/tmp/test-home" })
    expect(msg).toMatch(/not the daemon of this HOME/)
    expect(msg).toMatch(/pid/)
    expect(msg).toMatch(/--force-service/)
  })

  it("refuses a different port", () => {
    const msg = evaluateServiceOwnership("restart", { ...SAME, currentPort: 18791 })
    expect(msg).toMatch(/not the daemon of this port/)
    expect(msg).toMatch(/18791/)
  })

  it("names both when HOME and port differ", () => {
    const msg = evaluateServiceOwnership("uninstall", {
      ...SAME,
      currentHome: "/tmp/h",
      currentPort: 18791,
    })
    expect(msg).toMatch(/HOME\/port/)
  })
})

describe("parseServicePort", () => {
  it("reads the port from a launchd plist, a systemd unit and a flag=value form", () => {
    expect(parseServicePort("<string>--port</string>\n    <string>18795</string>")).toBe(18795)
    expect(parseServicePort("ExecStart=/usr/bin/node cli.mjs serve --port 18796 --bind x")).toBe(18796)
    expect(parseServicePort("serve --port=18797")).toBe(18797)
  })
  it("returns null when the definition carries no port", () => {
    expect(parseServicePort("<string>serve</string>")).toBeNull()
  })
})

describe("runDaemon guard wiring", () => {
  const realHome = process.env.HOME
  afterEach(() => {
    process.env.HOME = realHome
    vi.restoreAllMocks()
  })

  it("exits non-zero and acts on nothing when HOME differs from the OS user's", async () => {
    process.env.HOME = "/tmp/agentproto-test-home-does-not-exist"
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    for (const verb of ["stop", "restart", "uninstall"]) {
      expect(await runDaemon([verb])).toBe(1)
    }
    expect(err.mock.calls.map(c => String(c[0])).join("")).toMatch(/refusing/)
  })
})
