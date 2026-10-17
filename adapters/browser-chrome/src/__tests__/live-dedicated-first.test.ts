import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createChromeLiveProvider,
  pinnedEndpoint,
  wantsAttachFirst,
  type ChromeProcess,
} from "../index.js"
import { startFakeChrome, type FakeChrome } from "./live-fake-chrome.js"

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chrome-live-dedicated-first-"))
  dirs.push(dir)
  return dir
}
const fakes: FakeChrome[] = []
async function fake(): Promise<FakeChrome> {
  const f = await startFakeChrome()
  fakes.push(f)
  return f
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  await Promise.all(fakes.splice(0).map((f) => f.close()))
})

/** A stubbed Chrome child that records its kill signal and honours SIGTERM → exit. */
function stubChild(pid = 9090): { process: ChromeProcess; signal: () => NodeJS.Signals | undefined } {
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

describe("wantsAttachFirst (pure decision, no network)", () => {
  // `env: {}` everywhere below: `pinnedEndpoint` falls back to the REAL
  // `process.env` when `config.env` is unset, so a CI runner or a dev shell
  // that happens to export CHROME_LIVE_PORT/CHROME_LIVE_WS_URL would flip
  // these expectations. Pinning an empty env keeps the decision hermetic.
  it("defaults to the dedicated Chrome: nothing pinned, no explicit ask", () => {
    expect(wantsAttachFirst({ env: {} }, {})).toBe(false)
  })

  it("attachIntent forces attach-first even with nothing pinned", () => {
    expect(wantsAttachFirst({ env: {} }, { attachIntent: true })).toBe(true)
  })

  it("preferDedicated: false restores the old global default for every call", () => {
    expect(wantsAttachFirst({ env: {}, preferDedicated: false }, {})).toBe(true)
  })

  it("autoLaunch: false makes attach the only path (nothing to prefer)", () => {
    expect(wantsAttachFirst({ env: {}, autoLaunch: false }, {})).toBe(true)
  })

  it("a pinned endpoint (opts.port) is a literal ask: attach-first regardless of preferDedicated", () => {
    expect(wantsAttachFirst({ env: {} }, { port: 1234 })).toBe(true)
    expect(pinnedEndpoint({ env: {} }, { port: 1234 })).toBe(true)
  })

  it("a pinned endpoint (config.wsUrl) is a literal ask: attach-first", () => {
    expect(wantsAttachFirst({ env: {}, wsUrl: "ws://127.0.0.1:1234/devtools/browser" }, {})).toBe(true)
  })

  it("a pinned endpoint via CHROME_LIVE_PORT env is a literal ask: attach-first", () => {
    expect(wantsAttachFirst({ env: { CHROME_LIVE_PORT: "1234" } }, {})).toBe(true)
  })

  it("plain bare opts with an unrelated env var stay on the dedicated-first default", () => {
    expect(wantsAttachFirst({ env: { SOME_OTHER_VAR: "x" } }, {})).toBe(false)
  })
})

describe("chrome-live: dedicated-first default (launch)", () => {
  it("launches the dedicated Chrome immediately on a bare launch({}) — no attach attempted, no consent wait", async () => {
    const f = await fake()
    const child = stubChild()
    const spawns: string[][] = []
    const logs: string[] = []
    const provider = createChromeLiveProvider({
      consentTimeoutMs: 60_000, // deliberately long: proves attach is never dialed, not just that it times out fast
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

    const start = Date.now()
    const instance = await provider.launch({}, { log: (line) => logs.push(line) })
    const elapsedMs = Date.now() - start

    expect(instance.wasAlreadyRunning).toBe(false)
    expect(instance.pid).toBe(9090)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toContain(`--remote-debugging-port=${f.port}`)
    // Resolves in well under the 60s consent window: attach was never tried.
    expect(elapsedMs).toBeLessThan(5_000)
    expect(logs.some((l) => l.includes("launching the dedicated Chrome"))).toBe(true)
    expect(logs.some((l) => l.includes("Allow"))).toBe(false)
    expect(logs.some((l) => l.includes("no attachable Chrome"))).toBe(false)
    // The dedicated connection never dials the attach endpoint at all.
    expect(f.connections).toBe(1)

    await instance.stop()
    expect(child.signal()).toBe("SIGTERM")
  })

  it("reuses the dedicated Chrome it already launched on a second bare launch({})", async () => {
    const f = await fake()
    const child = stubChild(9191)
    let spawns = 0
    const provider = createChromeLiveProvider({
      consentTimeoutMs: 60_000,
      env: {},
      launchDeps: {
        dataDir: tmpDir(),
        executablePath: "/fake/chrome",
        findFreePort: async () => f.port,
        spawn: () => {
          spawns++
          return child.process
        },
        fetchJsonVersion: async () => ({ webSocketDebuggerUrl: f.wsUrl }),
      },
    })

    const first = await provider.launch({}, {})
    expect(first.wasAlreadyRunning).toBe(false)
    expect(spawns).toBe(1)

    const second = await provider.launch({}, {})
    expect(second.wasAlreadyRunning).toBe(true)
    expect(spawns).toBe(1)

    await second.stop()
    await first.stop()
    expect(child.signal()).toBe("SIGTERM")
  })
})
