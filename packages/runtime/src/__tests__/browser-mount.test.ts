import { describe, expect, it, vi, beforeEach } from "vitest"

const sandboxCfg = vi.hoisted(() => ({
  value: { mode: undefined as undefined | "off" | "workspace" | "strict", extraReadPaths: [], extraWritePaths: [], network: "allow" as "allow" | "deny" },
}))
vi.mock("@agentproto/command-sandbox", async importOriginal => ({
  ...(await importOriginal<typeof import("@agentproto/command-sandbox")>()),
  loadAdapterSpawnSandboxConfig: vi.fn(async () => sandboxCfg.value),
}))
const resolveChrome = vi.hoisted(() => vi.fn(async (_opts?: unknown) => ({ path: "/opt/chrome/chrome", source: "system" as const })))
vi.mock("@agentproto/plugin-local-browser", async importOriginal => ({
  ...(await importOriginal<typeof import("@agentproto/plugin-local-browser")>()),
  ensureChromeDevtoolsMcp: vi.fn(async () => ({
    prefix: "/h/.agentproto/chrome-mcp",
    binPath: "/h/.agentproto/chrome-mcp/node_modules/.bin/chrome-devtools-mcp",
    entryScript: "/h/.agentproto/chrome-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    version: "1.10.1",
    installed: false,
  })),
  resolveChrome,
}))

import {
  browserProfileDir,
  browserSessionMarker,
  parseBrowserMode,
  resolveBrowserMode,
  resolveHeadlessBrowser,
  sweepSessionBrowser,
  trackBrowserSession,
} from "../browser-mount.js"

describe("resolveBrowserMode / parseBrowserMode", () => {
  it("explicit > role > preset > defaults > off", () => {
    expect(resolveBrowserMode({})).toBe(false)
    expect(resolveBrowserMode({ defaults: "headless" })).toBe("headless")
    expect(resolveBrowserMode({ preset: false, defaults: "headless" })).toBe(false)
    expect(resolveBrowserMode({ role: "headless", preset: false })).toBe("headless")
    expect(resolveBrowserMode({ explicit: false, role: "headless" })).toBe(false)
  })

  it("parses the loose forms and ignores junk", () => {
    expect(parseBrowserMode("headless")).toBe("headless")
    for (const off of [false, "false", "off", "none"]) expect(parseBrowserMode(off)).toBe(false)
    expect(parseBrowserMode("chrome")).toBeUndefined()
    expect(parseBrowserMode(undefined)).toBeUndefined()
  })
})

describe("resolveHeadlessBrowser", () => {
  beforeEach(() => {
    resolveChrome.mockClear()
    sandboxCfg.value = { mode: undefined, extraReadPaths: [], extraWritePaths: [], network: "allow" }
  })

  it("unconfined: Chrome keeps its own sandbox, any Chrome source, session marker on the argv", async () => {
    const { entry, readPaths } = await resolveHeadlessBrowser({ sessionId: "s1", cwd: "/ws" })
    expect(resolveChrome).toHaveBeenCalledWith({})
    expect(entry.name).toBe("browser")
    expect(entry.args).toContain("--headless")
    expect(entry.args).not.toContain("--isolated")
    expect(entry.args?.[(entry.args?.indexOf("--userDataDir") ?? -2) + 1]).toBe(browserProfileDir("s1"))
    expect(entry.args).toContain("--chromeArg=--agentproto-session=s1")
    expect(entry.args).not.toContain("--chromeArg=--no-sandbox")
    expect(readPaths).toEqual(["/h/.agentproto/chrome-mcp", "/opt/chrome"])
  })

  it("workspace: --no-sandbox (Seatbelt refuses a nested sandbox_init), system Chrome allowed", async () => {
    const { entry } = await resolveHeadlessBrowser({ sessionId: "s1", cwd: "/ws", commandSandbox: "workspace" })
    expect(entry.args).toContain("--chromeArg=--no-sandbox")
    expect(resolveChrome).toHaveBeenCalledWith({})
  })

  it("strict: headless-shell only, the sandbox is not widened", async () => {
    await resolveHeadlessBrowser({ sessionId: "s1", cwd: "/ws", commandSandbox: "strict" })
    expect(resolveChrome).toHaveBeenCalledWith({ sources: ["env", "headless-shell"] })
  })

  it("falls back to the workspace adapterSpawn config when the spawn names no mode", async () => {
    sandboxCfg.value = { mode: "workspace", extraReadPaths: [], extraWritePaths: [], network: "deny" }
    const { entry } = await resolveHeadlessBrowser({ sessionId: "s1", cwd: "/ws" })
    expect(entry.args).toContain("--chromeArg=--no-sandbox")
    expect(resolveChrome).toHaveBeenCalledWith({ sources: ["env", "headless-shell"] })
  })
})

describe("sweepSessionBrowser", () => {
  const table = [
    { pid: 10, command: `node /p/chrome-devtools-mcp.js --headless --chromeArg=${browserSessionMarker("s1")}` },
    {
      pid: 11,
      command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/var/folders/x/T/puppeteer_dev_chrome_profile-AbC ${browserSessionMarker("s1")} --headless`,
    },
    { pid: 12, command: `/chrome --user-data-dir=/home/u/real-profile ${browserSessionMarker("s10")}` },
    { pid: 13, command: "/usr/bin/vim notes.md" },
  ]

  it("kills only this session's processes, then removes the session's profile dir", async () => {
    trackBrowserSession("s1")
    const kill = vi.fn()
    const removeDir = vi.fn(async () => {})
    const pids = await sweepSessionBrowser("s1", { listProcesses: async () => table, kill, removeDir, graceMs: 0, profileRoot: "/tmp/t" })
    expect(pids).toEqual([10, 11])
    expect(kill).toHaveBeenCalledTimes(2)
    expect(removeDir).toHaveBeenCalledExactlyOnceWith("/tmp/t/agentproto-browser/s1")
  })

  it("still removes the profile dir when every process already exited cleanly", async () => {
    trackBrowserSession("s3")
    const removeDir = vi.fn(async () => {})
    const pids = await sweepSessionBrowser("s3", { listProcesses: async () => table, kill: vi.fn(), removeDir, graceMs: 0, profileRoot: "/tmp/t" })
    expect(pids).toEqual([])
    expect(removeDir).toHaveBeenCalledExactlyOnceWith("/tmp/t/agentproto-browser/s3")
  })

  it("is a no-op for a session spawned without a browser (and after the first sweep)", async () => {
    const listProcesses = vi.fn(async () => table)
    expect(await sweepSessionBrowser("never-tracked", { listProcesses, graceMs: 0 })).toEqual([])
    trackBrowserSession("s2")
    await sweepSessionBrowser("s2", { listProcesses, kill: vi.fn(), graceMs: 0 })
    expect(await sweepSessionBrowser("s2", { listProcesses, graceMs: 0 })).toEqual([])
    expect(listProcesses).toHaveBeenCalledTimes(1)
  })

  it("never deletes the user-data-dir a matched process was using, only the session's own dir", async () => {
    trackBrowserSession("s10")
    const removeDir = vi.fn(async () => {})
    const pids = await sweepSessionBrowser("s10", { listProcesses: async () => table, kill: vi.fn(), removeDir, graceMs: 0, profileRoot: "/tmp/t" })
    expect(pids).toEqual([12])
    expect(removeDir).toHaveBeenCalledExactlyOnceWith("/tmp/t/agentproto-browser/s10")
  })
})
