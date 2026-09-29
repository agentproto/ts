import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openSession, type SessionCookie } from "../index.js"

interface Call {
  method: string
  url: string
  body: unknown
}

function fakeCamofox(tabs: Array<{ tabId: string }> = []) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 })
    if (method === "GET" && url.includes("/tabs?")) return json({ tabs })
    if (method === "POST" && url.endsWith("/tabs")) return json({ tabId: "tab-new" })
    if (url.includes("/evaluate")) return json({ result: { status: 200, body: { ok: true } } })
    return json({})
  }) as typeof fetch
  return { calls, fetchImpl }
}

const cookie: SessionCookie = { name: "sid", value: "synthetic", domain: ".example.test", path: "/", secure: true, httpOnly: true }
const dirs: string[] = []
const stateFile = (): string => {
  const d = mkdtempSync(join(tmpdir(), "bp-camofox-"))
  dirs.push(d)
  return join(d, "tabs.json")
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("openSession (fake camofox, temp state file)", () => {
  it("injects cookies, creates a tab and remembers it", async () => {
    const f = fakeCamofox()
    const sf = stateFile()
    const s = await openSession({ userId: "u1", base: "http://camofox.test/", cookies: [cookie], keepAlive: true, stateFile: sf, fetch: f.fetchImpl, settleMs: 0 })
    expect(s.tabId).toBe("tab-new")
    expect(f.calls[0]).toMatchObject({ method: "POST", url: "http://camofox.test/sessions/u1/cookies" })
    expect(f.calls.find(c => c.url.endsWith("/tabs") && c.method === "POST")?.body).toMatchObject({ userId: "u1", keepAlive: true })
    expect(JSON.parse(readFileSync(sf, "utf8"))).toEqual({ u1: "tab-new" })
  })

  it("reuses a listed tab instead of creating another, and skips injection when told to", async () => {
    const f = fakeCamofox([{ tabId: "tab-old" }])
    const s = await openSession({ userId: "u2", base: "http://camofox.test", injectCookies: false, stateFile: stateFile(), fetch: f.fetchImpl, settleMs: 0 })
    expect(s.tabId).toBe("tab-old")
    expect(f.calls.some(c => c.url.includes("/cookies"))).toBe(false)
    expect(f.calls.some(c => c.method === "POST" && c.url.endsWith("/tabs"))).toBe(false)
  })

  it("api() reads in-page JSON and close() forgets the tab", async () => {
    const f = fakeCamofox()
    const sf = stateFile()
    const s = await openSession({ userId: "u3", base: "http://camofox.test", stateFile: sf, fetch: f.fetchImpl, settleMs: 0 })
    expect(await s.api("/x")).toEqual({ ok: true })
    await s.close()
    expect(JSON.parse(readFileSync(sf, "utf8"))).toEqual({})
  })

  it("does not carry the private anti-bot verbs", async () => {
    const f = fakeCamofox()
    const s = await openSession({ userId: "u4", base: "http://camofox.test", stateFile: stateFile(), fetch: f.fetchImpl, settleMs: 0 })
    for (const verb of ["gotoPaced", "slide", "isBlocked", "onChallenge", "acceptConsent", "readNextData", "startCapture"]) {
      expect(verb in s).toBe(false)
    }
  })
})
