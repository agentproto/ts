import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  BROWSER_PROFILE_REFUSED_CODE,
  BrowserProfileRefusedError,
  defaultChromeUserDataDirs,
  isDefaultChromeUserDataDir,
  runConformance,
} from "@agentproto/driver-browser"
import { chrome, chromeCandidates, createChromeProvider, resolveChrome, type ChromeProcess } from "../index.js"
import { startFixtureServer, type FixtureServer } from "./fixture-server.js"

const here = dirname(fileURLToPath(import.meta.url))
const STUB = join(here, "fixtures", "stub-chrome.mjs")
const root = mkdtempSync(join(tmpdir(), "chrome-provider-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const SECRET = "granted-cookie-value-7f3a"

interface StubEntry {
  kind: string
  args?: string[]
  method?: string
  sessionId?: string
  params?: { cookies?: Array<{ name: string; value: string; domain: string }> }
}

function readLog(file: string): StubEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StubEntry)
}

function refusalOf(promise: Promise<unknown>): Promise<BrowserProfileRefusedError> {
  return promise.then(
    () => {
      throw new Error("expected browser:profile-refused")
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(BrowserProfileRefusedError)
      return err as BrowserProfileRefusedError
    },
  )
}

describe("resolveChrome", () => {
  it("prefers an existing CHROME_EXECUTABLE_PATH", () => {
    const bin = join(root, "my-chrome")
    writeFileSync(bin, "")
    expect(resolveChrome({ env: { CHROME_EXECUTABLE_PATH: bin }, exists: (p) => p === bin })).toBe(bin)
  })

  it("rejects an override that does not exist instead of falling back silently", () => {
    expect(() => resolveChrome({ env: { CHROME_EXECUTABLE_PATH: "/nope/chrome" }, exists: () => false })).toThrow(/CHROME_EXECUTABLE_PATH/)
    expect(() => resolveChrome({ env: { CHROME_EXECUTABLE_PATH: "relative/chrome" }, exists: () => true })).toThrow(/absolute/)
  })

  it("finds the standard install path on each OS, best first, and undefined when there is none", () => {
    const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    expect(resolveChrome({ env: {}, platform: "darwin", home: "/Users/t", exists: (p) => p === mac })).toBe(mac)
    expect(resolveChrome({ env: {}, platform: "linux", home: "/home/t", exists: (p) => p === "/usr/bin/google-chrome" })).toBe("/usr/bin/google-chrome")
    const win = join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe")
    expect(resolveChrome({ env: { PROGRAMFILES: "C:\\Program Files" }, platform: "win32", exists: (p) => p === win })).toBe(win)
    expect(resolveChrome({ env: { PATH: "/opt/bin:/usr/local/bin" }, platform: "linux", exists: (p) => p === "/opt/bin/chromium" })).toBe("/opt/bin/chromium")
    expect(resolveChrome({ env: {}, platform: "linux", exists: () => false })).toBeUndefined()
    expect(chromeCandidates({ env: {}, platform: "darwin", home: "/Users/t" })[0]).toBe(mac)
  })
})

describe("F11: the default Chrome profile is refused before anything is spawned", () => {
  let spawned = 0
  const provider = createChromeProvider({
    dataDir: join(root, "refusals"),
    executablePath: STUB,
    spawn: () => {
      spawned++
      throw new Error("spawn must not be called")
    },
  })
  const realChrome = defaultChromeUserDataDirs()[0] as string

  it("refuses the default user-data-dir as userDataDir or as the profile, and real profile names", async () => {
    const a = await refusalOf(provider.launch({ userDataDir: realChrome }, {}))
    expect(a.code).toBe(BROWSER_PROFILE_REFUSED_CODE)
    expect(a.reason).toBe("default-user-data-dir")
    expect((await refusalOf(provider.launch({ profile: realChrome }, {}))).reason).toBe("default-user-data-dir")
    expect((await refusalOf(provider.launch({ profile: "Default" }, {}))).reason).toBe("default-profile-name")
    expect((await refusalOf(provider.launch({ label: "Profile 2" }, {}))).reason).toBe("default-profile-name")
  })

  it("refuses --full-profile as an option and as an extra argument", async () => {
    expect((await refusalOf(provider.launch({ fullProfile: true }, {}))).reason).toBe("full-profile")
    expect((await refusalOf(provider.launch({ args: ["--full-profile"] }, {}))).reason).toBe("full-profile")
  })

  it("refuses extra args that override the dir or the debugging port", async () => {
    expect((await refusalOf(provider.launch({ args: [`--user-data-dir=${realChrome}`] }, {}))).reason).toBe("arg-override")
    expect((await refusalOf(provider.launch({ args: ["--remote-debugging-port=9222"] }, {}))).reason).toBe("arg-override")
  })

  it("never spawned anything", () => {
    expect(spawned).toBe(0)
  })
})

describe("launch and attach against a stub Chrome binary that speaks minimal CDP", () => {
  const logFile = join(root, "stub.log")
  const dataDir = join(root, "stub-data")
  const lines: string[] = []
  const ctx = { log: (line: string) => void lines.push(line) }

  it("uses a fresh dedicated dir, injects cookies with Network.setCookies, and never logs a cookie value", async () => {
    const provider = createChromeProvider({
      dataDir,
      executablePath: STUB,
      cookieSource: () => [{ name: "sid", value: SECRET, domain: "example.test", path: "/", secure: true }],
    })
    const instance = await provider.launch({ label: "stub", env: { STUB_CHROME_LOG: logFile } }, ctx)
    try {
      expect(instance.wasAlreadyRunning).toBe(false)
      expect(instance.pid).toBeGreaterThan(0)
      expect(instance.endpoints.cdp).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/stub$/)
      expect((await instance.health()).ok).toBe(true)

      const argvEntries = readLog(logFile).filter((e) => e.kind === "argv")
      expect(argvEntries).toHaveLength(1)
      const args = argvEntries[0]?.args ?? []
      const dirArgs = args.filter((a) => a.startsWith("--user-data-dir="))
      expect(dirArgs).toHaveLength(1)
      const dir = (dirArgs[0] as string).slice("--user-data-dir=".length)
      expect(dir.startsWith(join(dataDir, "profiles").replace(/^\/var\//, "/private/var/")) || dir.startsWith(join(dataDir, "profiles"))).toBe(true)
      expect(isDefaultChromeUserDataDir(dir)).toBe(false)
      for (const def of defaultChromeUserDataDirs()) expect(args.join("\n")).not.toContain(def)
      expect(args).toContain("--remote-debugging-port=0")
      expect(args).toContain("--headless=new")

      const again = await provider.launch({ label: "stub", env: { STUB_CHROME_LOG: logFile } }, ctx)
      expect(again.wasAlreadyRunning).toBe(true)
      expect(again.id).toBe(instance.id)
      expect(readLog(logFile).filter((e) => e.kind === "argv")).toHaveLength(1)

      const driver = await instance.attach({ initialUrl: "http://example.test/", sessionPayload: { cookies: [{ name: "extra", value: `${SECRET}-2`, domain: "example.test" }] } })
      const set = readLog(logFile).filter((e) => e.method === "Network.setCookies")
      expect(set).toHaveLength(1)
      expect(set[0]?.sessionId).toMatch(/^session-target-/)
      expect(set[0]?.params?.cookies?.map((c) => c.name)).toEqual(["sid", "extra"])
      expect(set[0]?.params?.cookies?.[0]?.value).toBe(SECRET)

      const methods = readLog(logFile).map((e) => e.method)
      expect(methods.indexOf("Network.setCookies")).toBeLessThan(methods.indexOf("Page.navigate"))

      expect((await driver.evaluate<number>({ expression: "1+1", awaitPromise: true, returnByValue: true, maxResultBytes: 1000 })).value).toBe(2)
      expect(driver.target.url).toBe("http://example.test/")
      await driver.close()
      expect(driver.closed).toBe(true)
      expect(readLog(logFile).some((e) => e.method === "Target.closeTarget")).toBe(true)
    } finally {
      await instance.stop()
    }
    await instance.stop()
    expect((await instance.health()).ok).toBe(false)
    expect(readLog(logFile).some((e) => e.kind === "exit")).toBe(true)

    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join("\n")).not.toContain(SECRET)
    expect(readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes('"kind":"argv"')).join("\n")).not.toContain(SECRET)
  }, 60_000)

  it("replaces a stale DevToolsActivePort left by a dead browser", async () => {
    const provider = createChromeProvider({ dataDir: join(root, "stale-data"), executablePath: STUB })
    mkdirSync(join(root, "stale-data", "profiles", "stale"), { recursive: true })
    writeFileSync(join(root, "stale-data", "profiles", "stale", "DevToolsActivePort"), "1\n/devtools/browser/old\n")
    const instance = await provider.launch({ label: "stale", env: { STUB_CHROME_LOG: join(root, "stale.log") } }, {})
    try {
      expect(instance.endpoints.cdp).toContain("/devtools/browser/stub")
      expect((await instance.health()).ok).toBe(true)
    } finally {
      await instance.stop()
    }
  }, 60_000)

  it("does not take over a profile dir held by a live process outside this provider", async () => {
    const dir = join(root, "held-data")
    const held = join(dir, "profiles", "held")
    mkdirSync(held, { recursive: true })
    symlinkSync(`host-${process.pid}`, join(held, "SingletonLock"))
    let spawned = 0
    const provider = createChromeProvider({
      dataDir: dir,
      executablePath: STUB,
      spawn: (): ChromeProcess => {
        spawned++
        throw new Error("spawn must not be called")
      },
    })
    await expect(provider.launch({ label: "held" }, {})).rejects.toThrow(/already held by pid/)
    expect(spawned).toBe(0)
  })

  it("reports a clear error when there is no Chrome", async () => {
    const provider = createChromeProvider({
      dataDir: join(root, "nochrome"),
      findChrome: () => undefined,
      spawn: () => {
        throw new Error("spawn must not be called")
      },
    })
    await expect(provider.launch({ label: "none" }, {})).rejects.toThrow(/no Chrome found/)
  })
})

describe("package surface", () => {
  it("describes itself without launching anything", () => {
    expect(chrome.id).toBe("chrome")
    expect(chrome.transport).toBe("sdk")
    expect(chrome.location).toBe("local")
    expect(chrome.capabilities).toMatchObject({ cdp: true, headless: true, headed: true, persistentProfile: true, stealth: false })
  })
})

const smokeBinary = process.env["CHROME_SMOKE_BIN"]
if (!smokeBinary) {
  console.warn("[chrome smoke] SKIPPED: set CHROME_SMOKE_BIN to a Chrome or Chromium binary to run the real-browser conformance smoke")
}

describe.skipIf(!smokeBinary)("real Chrome smoke: runConformance on a fresh dedicated profile", () => {
  let fixture: FixtureServer
  beforeAll(async () => {
    fixture = await startFixtureServer()
  })
  afterAll(async () => {
    await fixture?.close()
  })

  it("passes core, interaction and network headless", async () => {
    const provider = createChromeProvider({ dataDir: join(root, "smoke"), executablePath: smokeBinary as string })
    const report = await runConformance(provider, {
      levels: ["core", "interaction", "network", "download"],
      launch: { headless: true },
      fixture: { url: fixture.url, inputSelector: "#name", buttonSelector: "#go" },
      checkTimeoutMs: 90_000,
    })
    console.warn(`[chrome smoke] RAN: ${report.levels.map((l) => `${l.level}:${l.status}`).join(", ")}`)
    expect(report.failed).toEqual([])
    expect(report.ok).toBe(true)
  }, 600_000)
})
