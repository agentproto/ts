import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CHROME_LIVE_LAUNCH_PROFILE, CHROME_LIVE_PROVIDER_ID, ChromeLiveDriver, createChromeLiveProvider, type ChromeProcess } from "../index.js"
import { startFakeChrome, type FakeChrome } from "./live-fake-chrome.js"

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chrome-live-cookie-injection-"))
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

function stubChild(pid = 9090): ChromeProcess {
  const listeners = new Set<() => void>()
  return {
    pid,
    kill() {
      for (const l of [...listeners]) l()
      return true
    },
    once(event: "exit", listener: () => void) {
      if (event === "exit") listeners.add(listener)
      return this as ChromeProcess
    },
  }
}

/** A dedicated-launch provider wired to a fake CDP backend, same recipe as live-dedicated-first.test.ts. */
function dedicatedProvider(opts: Parameters<typeof createChromeLiveProvider>[0], f: FakeChrome) {
  return createChromeLiveProvider({
    ...opts,
    env: {},
    launchDeps: {
      dataDir: tmpDir(),
      executablePath: "/fake/chrome",
      findFreePort: async () => f.port,
      spawn: () => stubChild(),
      fetchJsonVersion: async () => ({ webSocketDebuggerUrl: f.wsUrl }),
    },
  })
}

function setCookiesCommands(f: FakeChrome): Array<{ method: string; params?: Record<string, unknown> }> {
  return f.commands.filter((c) => c.method === "Network.setCookies")
}

describe("chrome-live: cookieSource injection into the DEDICATED Chrome only", () => {
  it("injects the source's cookies via Network.setCookies on attach, without logging any value", async () => {
    const f = await fake()
    const logs: string[] = []
    const provider = dedicatedProvider(
      {
        cookieSource: () => [
          { name: "session", value: "super-secret-value", domain: "example.com", path: "/" },
        ],
      },
      f,
    )
    const instance = await provider.launch({}, { log: (l) => logs.push(l) })
    await instance.attach()

    const sent = setCookiesCommands(f)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.params?.cookies).toMatchObject([{ name: "session", domain: "example.com" }])
    // Count only — never the cookie's own value — in any log line.
    expect(logs.some((l) => l.includes("injecting 1 granted cookie"))).toBe(true)
    expect(logs.some((l) => l.includes("super-secret-value"))).toBe(false)

    await instance.stop()
  })

  it("narrows injection to the requested domains — an AND on top of the source, never a widening", async () => {
    const f = await fake()
    const provider = dedicatedProvider(
      {
        cookieSource: () => [
          { name: "a", value: "va", domain: "example.com", path: "/" },
          { name: "b", value: "vb", domain: "other.example", path: "/" },
        ],
      },
      f,
    )
    const instance = await provider.launch({ domains: ["example.com"] }, {})
    await instance.attach()

    const sent = setCookiesCommands(f)
    expect(sent).toHaveLength(1)
    const cookies = sent[0]?.params?.cookies as Array<{ name: string }>
    expect(cookies.map((c) => c.name)).toEqual(["a"])

    await instance.stop()
  })

  it("also filters a cookie source that ignores the domains hint itself (belt and suspenders)", async () => {
    const f = await fake()
    const provider = dedicatedProvider(
      {
        // Deliberately returns everything regardless of the request's `domains` field.
        cookieSource: () => [
          { name: "a", value: "va", domain: "keep.example", path: "/" },
          { name: "b", value: "vb", domain: "drop.example", path: "/" },
        ],
      },
      f,
    )
    const instance = await provider.launch({ domains: ["keep.example"] }, {})
    await instance.attach()

    const cookies = setCookiesCommands(f)[0]?.params?.cookies as Array<{ name: string }>
    expect(cookies.map((c) => c.name)).toEqual(["a"])

    await instance.stop()
  })

  it("forwards chromeProfile and domains verbatim to the cookie source's request", async () => {
    const f = await fake()
    const requests: Array<{ providerId: string; profile: string; domains?: readonly string[]; chromeProfile?: string }> = []
    const provider = dedicatedProvider(
      {
        cookieSource: (req) => {
          requests.push(req)
          return []
        },
      },
      f,
    )
    const instance = await provider.launch({ chromeProfile: "Profile 3", domains: ["example.com"] }, {})
    await instance.attach()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      providerId: CHROME_LIVE_PROVIDER_ID,
      profile: CHROME_LIVE_LAUNCH_PROFILE,
      chromeProfile: "Profile 3",
      domains: ["example.com"],
    })

    await instance.stop()
  })

  it("injects nothing and calls the source nothing extra when it returns no cookies", async () => {
    const f = await fake()
    const logs: string[] = []
    const provider = dedicatedProvider({ cookieSource: () => [] }, f)
    const instance = await provider.launch({}, { log: (l) => logs.push(l) })
    await instance.attach()

    expect(setCookiesCommands(f)).toHaveLength(0)
    expect(logs.some((l) => l.includes("injecting"))).toBe(false)

    await instance.stop()
  })

  it("never calls cookieSource at all when none is configured", async () => {
    const f = await fake()
    const provider = dedicatedProvider({}, f)
    const instance = await provider.launch({}, {})
    await instance.attach()
    expect(setCookiesCommands(f)).toHaveLength(0)
    await instance.stop()
  })

  it("still injects a session payload's cookies even with no cookieSource configured at all", async () => {
    const f = await fake()
    const provider = dedicatedProvider({}, f)
    const instance = await provider.launch({}, {})
    await instance.attach({ sessionPayload: { cookies: [{ name: "a", value: "va", domain: "example.com", path: "/" }] } })

    const cookies = setCookiesCommands(f)[0]?.params?.cookies as Array<{ name: string }>
    expect(cookies.map((c) => c.name)).toEqual(["a"])

    await instance.stop()
  })

  it("applies the domains ceiling to a session payload too, not just to the source", async () => {
    const f = await fake()
    const provider = dedicatedProvider({ cookieSource: () => [{ name: "src", value: "v", domain: "keep.example", path: "/" }] }, f)
    const instance = await provider.launch({ domains: ["keep.example"] }, {})
    await instance.attach({
      sessionPayload: {
        cookies: [
          { name: "payload-keep", value: "v", domain: "keep.example", path: "/" },
          { name: "payload-drop", value: "v", domain: "drop.example", path: "/" },
        ],
      },
    })

    const cookies = setCookiesCommands(f)[0]?.params?.cookies as Array<{ name: string }>
    expect(cookies.map((c) => c.name).sort()).toEqual(["payload-keep", "src"])

    await instance.stop()
  })
})

describe("chrome-live: cookieSource never applies to the user's own (attach-to-real-Chrome) profile", () => {
  it("is never invoked, and Network.setCookies is never sent, when attaching to the user's running Chrome", async () => {
    const f = await fake()
    let calls = 0
    const provider = createChromeLiveProvider({
      env: {},
      cookieSource: () => {
        calls++
        return [{ name: "x", value: "y", domain: "example.com", path: "/" }]
      },
    })
    // No pinned endpoint/attachIntent is set on the provider; force the attach
    // path explicitly via a pinned port, mirroring live.test.ts's own setup.
    const instance = await provider.launch({ port: f.port }, {})
    await instance.attach()

    expect(calls).toBe(0)
    expect(setCookiesCommands(f)).toHaveLength(0)

    await instance.stop()
  })

  it("refuses setCookies on an attach driver even when called directly with a non-empty array — driver-level, not caller-classification-level", async () => {
    const f = await fake()
    const provider = createChromeLiveProvider({ env: {} })
    const instance = await provider.launch({ port: f.port }, {})
    const driver = (await instance.attach()) as ChromeLiveDriver

    await expect(driver.setCookies([{ name: "x", value: "y", domain: "example.com", path: "/" }])).rejects.toThrow(/read-only/)
    expect(setCookiesCommands(f)).toHaveLength(0)

    await instance.stop()
  })
})
