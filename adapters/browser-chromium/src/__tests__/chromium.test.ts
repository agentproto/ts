import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  BROWSER_PROFILE_REFUSED_CODE,
  BrowserProfileRefusedError,
  defaultChromeUserDataDirs,
  runConformance,
  type BrowserProvider,
} from "@agentproto/driver-browser"
import { chromium, createChromiumProvider, parseDevToolsActivePort, type ChromiumProvider } from "../index.js"
import { startFixtureServer, type FixtureServer } from "./fixture-server.js"

const dataDir = mkdtempSync(join(tmpdir(), "chromium-provider-"))
afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const neverLoaded = async (): Promise<never> => {
  throw new Error("playwright must not be loaded for a refused launch")
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

describe("package surface", () => {
  it("imports and describes itself without launching a browser", () => {
    expect(chromium.id).toBe("chromium")
    expect(chromium.transport).toBe("sdk")
    expect(chromium.location).toBe("local")
    expect(chromium.capabilities).toMatchObject({ cdp: true, headless: true, headed: true, persistentProfile: true, stealth: false })
    expect(chromium.capabilities.canFullPageScreenshot).toBe(true)
    expect(chromium.config.some((c) => c.prompt.includes("npx playwright install chromium"))).toBe(true)
  })

  it("reports a clear error when playwright-core cannot be loaded", async () => {
    const provider = createChromiumProvider({
      dataDir,
      loadPlaywright: async () => {
        throw new Error("[chromium] playwright-core is not installed")
      },
    })
    await expect(provider.launch({ label: "no-playwright" }, {})).rejects.toThrow(/playwright-core is not installed/)
  })

  it("parses DevToolsActivePort", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/abc\n")).toEqual({ port: 9222, browserWsPath: "/devtools/browser/abc" })
    expect(parseDevToolsActivePort("")).toBeUndefined()
    expect(parseDevToolsActivePort("0\n/x")).toBeUndefined()
  })
})

describe("F11: the default Chrome profile is refused before anything is launched", () => {
  const provider = createChromiumProvider({ dataDir, loadPlaywright: neverLoaded })
  const realChrome = defaultChromeUserDataDirs()[0] as string

  it("refuses the default user-data-dir given as userDataDir", async () => {
    const err = await refusalOf(provider.launch({ label: "x", userDataDir: realChrome }, {}))
    expect(err.code).toBe(BROWSER_PROFILE_REFUSED_CODE)
    expect(err.reason).toBe("default-user-data-dir")
  })

  it("refuses the default user-data-dir given as the profile, and real profile names", async () => {
    expect((await refusalOf(provider.launch({ profile: realChrome }, {}))).reason).toBe("default-user-data-dir")
    expect((await refusalOf(provider.launch({ profile: "Default" }, {}))).reason).toBe("default-profile-name")
    expect((await refusalOf(provider.launch({ profile: "Profile 1" }, {}))).reason).toBe("default-profile-name")
  })

  it("refuses --full-profile as an option and as an extra argument", async () => {
    expect((await refusalOf(provider.launch({ fullProfile: true }, {}))).reason).toBe("full-profile")
    expect((await refusalOf(provider.launch({ args: ["--full-profile"] }, {}))).reason).toBe("full-profile")
  })

  it("refuses extra args that override the dir or the debugging port", async () => {
    expect((await refusalOf(provider.launch({ args: [`--user-data-dir=${realChrome}`] }, {}))).reason).toBe("arg-override")
    expect((await refusalOf(provider.launch({ args: ["--remote-debugging-port=9222"] }, {}))).reason).toBe("arg-override")
  })
})

interface FakeContext {
  closed: boolean
  handlers: Array<() => void>
  on(event: string, handler: () => void): void
  close(): Promise<void>
}

describe("idempotent launch (fake playwright, no browser)", () => {
  it("reuses one context per dedicated dir and stops only what it owns", async () => {
    const launched: string[] = []
    const contexts: FakeContext[] = []
    const dir = mkdtempSync(join(tmpdir(), "chromium-idem-"))
    const fake = createChromiumProvider({
      dataDir: dir,
      loadPlaywright: async () => ({
        chromium: {
          executablePath: () => "/nonexistent",
          launchPersistentContext: async (userDataDir: string) => {
            launched.push(userDataDir)
            writeFileSync(join(userDataDir, "DevToolsActivePort"), "45678\n/devtools/browser/fake\n")
            const ctx: FakeContext = {
              closed: false,
              handlers: [],
              on(_event, handler) {
                ctx.handlers.push(handler)
              },
              async close() {
                ctx.closed = true
                for (const h of ctx.handlers) h()
              },
            }
            contexts.push(ctx)
            return ctx as never
          },
        },
      }),
    })
    try {
      const [a, b] = await Promise.all([fake.launch({ label: "one" }, {}), fake.launch({ label: "one" }, {})])
      expect(launched).toHaveLength(1)
      expect(launched[0]).toBe(join(realpathSync(dir), "profiles", "one"))
      expect(a.id).toBe(b.id)
      expect([a.wasAlreadyRunning, b.wasAlreadyRunning].sort()).toEqual([false, true])
      expect(a.endpoints.cdp).toBe("ws://127.0.0.1:45678/devtools/browser/fake")

      const other = await fake.launch({ label: "two" }, {})
      expect(launched).toHaveLength(2)
      expect(other.id).not.toBe(a.id)

      const viewer = a.wasAlreadyRunning ? a : b
      const owner = a.wasAlreadyRunning ? b : a
      await viewer.stop()
      expect(contexts[0]?.closed).toBe(false)
      await owner.stop()
      await owner.stop()
      expect(contexts[0]?.closed).toBe(true)
      expect((await owner.health()).ok).toBe(false)

      const again = await fake.launch({ label: "one" }, {})
      expect(again.wasAlreadyRunning).toBe(false)
      expect(launched).toHaveLength(3)
      await again.stop()
      await other.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

async function binaryPath(): Promise<string | undefined> {
  try {
    const mod = await import("playwright-core")
    const path = mod.chromium.executablePath()
    return existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
}

const binary = await binaryPath()
if (!binary) {
  console.warn("[chromium conformance] SKIPPED: no Playwright Chromium binary installed (run `npx playwright install chromium`)")
}

describe.skipIf(!binary)("runConformance against real headless Chromium", () => {
  let fixture: FixtureServer
  beforeAll(async () => {
    fixture = await startFixtureServer()
  })
  afterAll(async () => {
    await fixture?.close()
  })

  it(
    "passes core, interaction and network, and download is skipped as unsupported",
    async () => {
      const provider: BrowserProvider = createChromiumProvider({ dataDir: join(dataDir, "conformance") })
      const report = await runConformance(provider, {
        levels: ["core", "interaction", "network", "download"],
        launch: { headless: true },
        fixture: { url: fixture.url, inputSelector: "#name", buttonSelector: "#go" },
        checkTimeoutMs: 90_000,
      })
      const summary = report.levels.map((l) => `${l.level}:${l.status}${l.skipReason ? ` (${l.skipReason})` : ""}`)
      console.warn(`[chromium conformance] RAN: ${summary.join(", ")}`)
      const byLevel = Object.fromEntries(report.levels.map((l) => [l.level, l]))
      for (const level of ["core", "interaction", "network"] as const) {
        const failing = byLevel[level]?.checks.filter((c) => c.status === "fail")
        expect(failing, `${level} failures`).toEqual([])
        expect(byLevel[level]?.status).toBe("pass")
      }
      expect(byLevel["download"]?.status).toBe("skipped")
      expect(fixture.hits.some((h) => h.startsWith("/api/echo?name=conformance"))).toBe(true)
      expect(report.ok).toBe(true)
    },
    600_000,
  )

  it(
    "injects granted cookies on attach",
    async () => {
      const provider: ChromiumProvider = createChromiumProvider({ dataDir: join(dataDir, "cookies") })
      const instance = await provider.launch({ label: "cookies" }, {})
      try {
        const driver = await instance.attach({
          initialUrl: fixture.url,
          sessionPayload: { cookies: [{ name: "sid", value: "granted-secret", domain: "127.0.0.1", path: "/" }] },
        })
        const seen = await driver.evaluate<string>({ expression: "document.cookie", awaitPromise: true, returnByValue: true, maxResultBytes: 1000 })
        expect(seen.value).toContain("sid=granted-secret")
        expect((await instance.health()).ok).toBe(true)
      } finally {
        await instance.stop()
      }
    },
    180_000,
  )
})
