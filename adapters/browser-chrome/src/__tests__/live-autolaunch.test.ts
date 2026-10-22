import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BROWSER_REMOTE_DEBUGGING_OFF_CODE, createChromeLiveProvider, type ChromeProcess } from "../index.js"
import { startFakeChrome, type FakeChrome } from "./live-fake-chrome.js"

const fakes: FakeChrome[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fake(options?: Parameters<typeof startFakeChrome>[0]): Promise<FakeChrome> {
  const f = await startFakeChrome(options)
  fakes.push(f)
  return f
}

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chrome-live-autolaunch-"))
  dirs.push(dir)
  return dir
}

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** A stubbed Chrome child; `spawn` returns it and it answers SIGTERM with an exit. */
function stubChild(pid = 3131): { process: ChromeProcess; signal: () => NodeJS.Signals | undefined } {
  let signal: NodeJS.Signals | undefined
  const listeners = new Set<() => void>()
  const process: ChromeProcess = {
    pid,
    kill(sig?: NodeJS.Signals) {
      signal = sig ?? "SIGTERM"
      for (const l of [...listeners]) l()
      return true
    },
    once(event: "exit", listener: () => void) {
      if (event === "exit") listeners.add(listener)
      return process
    },
  }
  return { process, signal: () => signal }
}

describe("chrome-live: auto-launch fallback", () => {
  it("launches a dedicated Chrome on the default endpoint, records its pid, and stop kills ONLY it", async () => {
    const f = await fake()
    const child = stubChild()
    const spawns: string[][] = []
    const provider = createChromeLiveProvider({
      consentTimeoutMs: 300,
      env: {},
      launchDeps: {
        dataDir: tmpDir(),
        executablePath: "/fake/chrome",
        findFreePort: async () => f.port,
        spawn: (_file, args) => {
          spawns.push(args)
          return child.process
        },
        fetchJsonVersion: async () => ({ webSocketDebuggerUrl: f.wsUrl }),
      },
    })

    const instance = await provider.launch({ port: await closedPort(), forceAutoLaunch: true }, {})
    expect(instance.wasAlreadyRunning).toBe(false)
    expect(instance.pid).toBe(3131)
    expect(instance.endpoints.cdp).toBe(f.wsUrl)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toContain(`--remote-debugging-port=${f.port}`)
    expect(spawns[0]?.some((a) => a.startsWith("--user-data-dir="))).toBe(true)
    expect((await instance.health()).ok).toBe(true)

    // A second launch on the same default endpoint reuses the launched Chrome.
    const again = await provider.launch({ port: await closedPort(), forceAutoLaunch: true }, {})
    expect(again.wasAlreadyRunning).toBe(true)
    expect(spawns).toHaveLength(1)

    await again.stop()
    await instance.stop()
    expect(child.signal()).toBe("SIGTERM")
    expect(f.commands.map((c) => c.method)).not.toContain("Browser.close")
  })

  it("NEVER silently falls back to a dedicated Chrome when attaching fails", async () => {
    // Before this fix the provider launched a dedicated Chrome after a consent
    // timeout/locked port, so the agent believed it was driving the user's
    // Chrome while it was driving a blank one. It must fail loudly instead.
    const holding = await fake({ consent: "hold" })
    const child = stubChild(5151)
    let spawns = 0
    const provider = createChromeLiveProvider({
      consentTimeoutMs: 300,
      env: {},
      launchDeps: {
        dataDir: tmpDir(),
        executablePath: "/fake/chrome",
        findFreePort: async () => 1,
        spawn: () => {
          spawns++
          return child.process
        },
        fetchJsonVersion: async () => undefined,
      },
    })
    const err = await provider.launch({ port: holding.port }, {}).then(
      () => { throw new Error("expected a rejection") },
      (e: unknown) => e as Error,
    )
    expect(err.message).toMatch(/browser:consent-timeout|did not accept the debugging connection/)
    expect(err.message).toMatch(/No dedicated browser was started/)
    expect(err.message).toMatch(/chrome:\/\/inspect/)
    expect(spawns).toBe(0)
  })

  it("a closed debugging port fails with an actionable error and no fallback", async () => {
    const child = stubChild()
    let spawns = 0
    const provider = createChromeLiveProvider({
      consentTimeoutMs: 300,
      env: {},
      launchDeps: {
        dataDir: tmpDir(),
        executablePath: "/fake/chrome",
        findFreePort: async () => 1,
        spawn: () => {
          spawns++
          return child.process
        },
        fetchJsonVersion: async () => undefined,
      },
    })
    await expect(provider.launch({ port: await closedPort() }, {})).rejects.toThrow(/No dedicated browser was started/)
    expect(spawns).toBe(0)
  })

  it("does not auto-launch when an explicit endpoint is pinned (attach-only failure surfaces)", async () => {
    const child = stubChild()
    let spawns = 0
    const provider = createChromeLiveProvider({
      consentTimeoutMs: 300,
      env: {},
      launchDeps: {
        dataDir: tmpDir(),
        executablePath: "/fake/chrome",
        findFreePort: async () => 1,
        spawn: () => {
          spawns++
          return child.process
        },
        fetchJsonVersion: async () => undefined,
      },
    })
    await expect(provider.launch({ port: await closedPort() }, {})).rejects.toMatchObject({
      code: BROWSER_REMOTE_DEBUGGING_OFF_CODE,
    })
    expect(spawns).toBe(0)
  })

  it("autoLaunch: false disables the fallback even with forceAutoLaunch", async () => {
    const child = stubChild()
    let spawns = 0
    const provider = createChromeLiveProvider({
      consentTimeoutMs: 300,
      env: {},
      autoLaunch: false,
      launchDeps: {
        dataDir: tmpDir(),
        executablePath: "/fake/chrome",
        findFreePort: async () => 1,
        spawn: () => {
          spawns++
          return child.process
        },
        fetchJsonVersion: async () => undefined,
      },
    })
    await expect(provider.launch({ port: await closedPort(), forceAutoLaunch: true }, {})).rejects.toMatchObject({
      code: BROWSER_REMOTE_DEBUGGING_OFF_CODE,
    })
    expect(spawns).toBe(0)
  })
})
