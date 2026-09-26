/**
 * `agentproto pair offer --qr` — the phone link. Fake-daemon pattern (see
 * policy.test.ts): `discoverDaemon` / `httpPostJson` are intercepted, and the
 * QR renderer is replaced so the test sees exactly what it was asked to draw.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runPair } from "../commands/pair.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return { ...orig, discoverDaemon: vi.fn(), httpPostJson: vi.fn(), printNoDaemonError: vi.fn() }
})
vi.mock("../util/qr.js", () => ({ printQr: vi.fn(async () => {}) }))

const helpers = await import("../commands/_daemon-helpers.js")
const { printQr } = await import("../util/qr.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpPostJson = vi.mocked(helpers.httpPostJson)
const qr = vi.mocked(printQr)

const OFFER =
  "agentproto://pair?v=2&rv=wss%3A%2F%2Frdv.agentproto.sh%2Fv1&id=a1b2c3d4e5f60718&pk=AAA&sk=BBB&s=sec_ret-1&exp=1900000000"
const QUERY = OFFER.slice(OFFER.indexOf("?") + 1)

describe("agentproto pair offer --qr", () => {
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
    qr.mockClear()
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:18790", token: "tok" }, stale: [] })
    httpPostJson.mockResolvedValue({
      url: OFFER,
      fingerprint: "a1b2c3d4e5f60718",
      rendezvous: "wss://rdv.agentproto.sh/v1",
      rendezvousIsHostedDefault: true,
      expiresAt: "2030-03-17T17:46:40.000Z",
    })
  })
  afterEach(() => {
    for (const s of spies) s.mockRestore()
  })

  it("renders the web pair page with the offer in the fragment", async () => {
    expect(await runPair(["offer", "--qr"])).toBe(0)
    const web = `https://cli.agentproto.sh/pair#${QUERY}`
    expect(qr).toHaveBeenCalledTimes(1)
    expect(qr).toHaveBeenCalledWith(web)
    const text = out.join("")
    expect(text).toContain(web)
    expect(text).toContain(OFFER) // the CLI form is still printed
    expect(text).toContain("a1b2c3d4e5f60718")
  })

  it("--pair-page points the link at another page; --json adds webUrl", async () => {
    expect(await runPair(["offer", "--qr", "--pair-page", "http://localhost:3000/pair", "--json"])).toBe(0)
    const json = JSON.parse(out.join(""))
    expect(json.url).toBe(OFFER)
    expect(json.webUrl).toBe(`http://localhost:3000/pair#${QUERY}`)
    expect(qr).not.toHaveBeenCalled()
  })

  it("without --qr, the offer and its QR are unchanged", async () => {
    expect(await runPair(["offer"])).toBe(0)
    expect(qr).toHaveBeenCalledWith(OFFER)
    expect(out.join("")).not.toContain("cli.agentproto.sh")

    out.length = 0
    expect(await runPair(["offer", "--json"])).toBe(0)
    expect(JSON.parse(out.join("")).webUrl).toBeUndefined()
  })

  it("rejects conflicting flags", async () => {
    expect(await runPair(["offer", "--qr", "--no-qr"])).toBe(2)
    expect(await runPair(["offer", "--pair-page", "https://x.example/pair"])).toBe(2)
    expect(await runPair(["offer", "--qr", "--pair-page", "https://x.example/pair#frag"])).toBe(2)
    expect(err.join("")).toContain("mutually exclusive")
  })
})
