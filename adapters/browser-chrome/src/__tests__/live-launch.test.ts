import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CHROME_LIVE_LAUNCH_DIR_ENV,
  launchDetachedChrome,
  liveLaunchDataDir,
  type ChromeProcess,
} from "../index.js"

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chrome-live-launch-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A stubbed Chrome child that records its kill signal and honours SIGTERM → exit. */
function stubChild(pid = 4242): { process: ChromeProcess; signal: () => NodeJS.Signals | undefined } {
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

describe("liveLaunchDataDir", () => {
  it("defaults under AGENTPROTO_HOME/browser/chrome/live and keeps the profile across runs", () => {
    expect(liveLaunchDataDir({ AGENTPROTO_HOME: "/tmp/home" })).toBe("/tmp/home/browser/chrome/live")
    expect(liveLaunchDataDir({ AGENTPROTO_HOME: "/tmp/home" })).toBe("/tmp/home/browser/chrome/live")
  })

  it("honours CHROME_LIVE_LAUNCH_DATA_DIR and treats blank as unset", () => {
    expect(liveLaunchDataDir({ [CHROME_LIVE_LAUNCH_DIR_ENV]: "/tmp/dedicated" })).toBe("/tmp/dedicated")
    expect(liveLaunchDataDir({ [CHROME_LIVE_LAUNCH_DIR_ENV]: "  ", AGENTPROTO_HOME: "/tmp/home" })).toBe("/tmp/home/browser/chrome/live")
  })
})

describe("launchDetachedChrome", () => {
  it("spawns a headful Chrome on the given port + dedicated dir and returns the /json/version ws URL and pid", async () => {
    const dir = tmpDir()
    const child = stubChild(777)
    let spawnedArgs: string[] = []
    const launched = await launchDetachedChrome({
      dataDir: dir,
      executablePath: "/fake/chrome",
      findFreePort: async () => 45678,
      spawn: (_file, args) => {
        spawnedArgs = args
        return child.process
      },
      fetchJsonVersion: async (port) => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/uuid-1` }),
    })
    expect(launched.port).toBe(45678)
    expect(launched.pid).toBe(777)
    expect(launched.wsUrl).toBe("ws://127.0.0.1:45678/devtools/browser/uuid-1")
    const args = spawnedArgs
    expect(args).toContain("--remote-debugging-port=45678")
    expect(args).toContain(`--user-data-dir=${dir}`)
    expect(args).toContain("--no-first-run")
    expect(args.some((a) => a.startsWith("--headless"))).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })

  it("kills the child (SIGTERM) and throws when the debugging endpoint never appears", async () => {
    const child = stubChild(8080)
    await expect(
      launchDetachedChrome({
        dataDir: tmpDir(),
        executablePath: "/fake/chrome",
        findFreePort: async () => 45679,
        spawn: () => child.process,
        fetchJsonVersion: async () => undefined,
        sleep: async () => {},
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/json\/version/)
    expect(child.signal()).toBe("SIGTERM")
  })

  it("throws when the child exits before opening its endpoint", async () => {
    const child = stubChild(9000)
    await expect(
      launchDetachedChrome({
        dataDir: tmpDir(),
        executablePath: "/fake/chrome",
        findFreePort: async () => 45680,
        spawn: () => {
          // Exit right after spawn (the provider registers its exit listener
          // synchronously), before the first /json/version response.
          queueMicrotask(() => child.process.kill("SIGTERM"))
          return child.process
        },
        fetchJsonVersion: async () => undefined,
        sleep: async () => {},
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/exited before/)
  })

  it("throws a helpful error when no Chrome binary is available", async () => {
    await expect(
      launchDetachedChrome({ dataDir: tmpDir(), findChrome: () => undefined }),
    ).rejects.toThrow(/no Chrome found/)
  })
})
