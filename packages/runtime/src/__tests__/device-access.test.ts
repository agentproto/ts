import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEVICE_IDLE_TTL_MS,
  DeviceAccessStore,
  REQUEST_TTL_MS,
  buildPairingLinks,
  extractDeviceToken,
  grantAllowsApp,
  normalizeOfferCode,
} from "../device-access.js"

function store(start = 1_000_000) {
  const clock = { t: start }
  const s = new DeviceAccessStore({ persist: false, now: () => clock.t })
  return { s, clock }
}

function pair(s: DeviceAccessStore, grant: { apps: "*" | string[]; sessionsRead?: boolean } = { apps: ["a/one"] }) {
  const offer = s.offer({ grant })
  const req = s.request({ offer: offer.code, deviceName: "Pixel", platform: "android" })
  if (!req.ok) throw new Error(req.error)
  return { offer, req }
}

describe("offers and requests", () => {
  it("an offer is single use: replaying it fails", () => {
    const { s } = store()
    const { offer } = pair(s)
    expect(s.request({ offer: offer.code })).toEqual({ ok: false, error: "invalid_offer" })
  })

  it("an expired offer gives nothing", () => {
    const { s, clock } = store()
    const offer = s.offer({ grant: { apps: "*" }, ttlMs: 60_000 })
    clock.t += 61_000
    expect(s.request({ offer: offer.code })).toEqual({ ok: false, error: "offer_expired" })
    // Once said, it is gone.
    expect(s.request({ offer: offer.code })).toEqual({ ok: false, error: "invalid_offer" })
  })

  it("accepts the code as typed or linked (case, dashes, look-alike letters)", () => {
    const { s } = store()
    const offer = s.offer({ grant: { apps: "*" } })
    const typed = offer.code.toLowerCase().replace(/(.{4})/g, "$1-")
    expect(normalizeOfferCode(typed)).toBe(offer.code)
    expect(s.request({ offer: typed }).ok).toBe(true)
  })

  it("locks after too many wrong offers and burns the pending ones", () => {
    const { s, clock } = store()
    const good = s.offer({ grant: { apps: "*" } })
    for (let i = 0; i < 7; i++) expect(s.request({ offer: "WRONGWRONGWRONG0" })).toEqual({ ok: false, error: "invalid_offer" })
    expect(s.request({ offer: "WRONGWRONGWRONG1" })).toEqual({ ok: false, error: "locked" })
    // Even the right one is refused while locked, and it was burned anyway.
    expect(s.request({ offer: good.code })).toEqual({ ok: false, error: "locked" })
    clock.t += 61_000
    expect(s.request({ offer: good.code })).toEqual({ ok: false, error: "invalid_offer" })
  })

  it("a request carries a two-digit number to compare and never exposes the secret in its description", () => {
    const { s } = store()
    const { req } = pair(s)
    expect(req.number).toMatch(/^[1-9][0-9]$/)
    expect(JSON.stringify(s.describeRequest(req.requestId))).not.toContain(req.pollSecret)
  })
})

describe("confirmation and delivery", () => {
  it("no access before the confirmation; the token is delivered once, after it", () => {
    const { s } = store()
    const { req } = pair(s)
    expect(s.poll(req.requestId, req.pollSecret)).toEqual({ ok: true, status: "pending" })
    expect(s.list()).toHaveLength(0)
    expect(s.decide(req.requestId, "approve")).toBe(true)
    const first = s.poll(req.requestId, req.pollSecret)
    expect(first).toMatchObject({ ok: true, status: "approved" })
    if (!("token" in first)) throw new Error("no token")
    expect(first.token).toMatch(/^dvt_[A-Za-z0-9_-]{43}$/)
    expect(s.poll(req.requestId, req.pollSecret)).toEqual({ ok: false, error: "already_delivered" })
    expect(s.verify(first.token)).toMatchObject({ name: "Pixel", platform: "android", grant: { apps: ["a/one"], sessionsRead: false } })
  })

  it("a wrong poll secret or unknown id is a plain not_found", () => {
    const { s } = store()
    const { req } = pair(s)
    expect(s.poll(req.requestId, "nope")).toEqual({ ok: false, error: "not_found" })
    expect(s.poll("pr_unknown", req.pollSecret)).toEqual({ ok: false, error: "not_found" })
  })

  it("a refused or expired request gives no access", () => {
    const { s, clock } = store()
    const a = pair(s).req
    expect(s.decide(a.requestId, "deny")).toBe(true)
    expect(s.poll(a.requestId, a.pollSecret)).toEqual({ ok: true, status: "denied" })
    expect(s.decide(a.requestId, "approve")).toBe(false)
    const b = pair(s).req
    clock.t += REQUEST_TTL_MS + 1
    expect(s.poll(b.requestId, b.pollSecret)).toEqual({ ok: true, status: "expired" })
    expect(s.decide(b.requestId, "approve")).toBe(false)
    expect(s.list({ includeInactive: true })).toHaveLength(0)
  })

  it("follows the confirmation channel's answer while pending", () => {
    const { s } = store()
    const a = pair(s).req
    expect(s.poll(a.requestId, a.pollSecret, "approved")).toMatchObject({ ok: true, status: "approved" })
    const b = pair(s).req
    expect(s.poll(b.requestId, b.pollSecret, "denied")).toEqual({ ok: true, status: "denied" })
  })
})

describe("devices, grants and revocation", () => {
  function connect(s: DeviceAccessStore, grant: { apps: "*" | string[] }) {
    const { req } = pair(s, grant)
    s.decide(req.requestId, "approve")
    const r = s.poll(req.requestId, req.pollSecret)
    if (!("token" in r)) throw new Error("no token")
    return r
  }

  it("the grant lives on the device, not in the token: changing it changes what the same token may do", () => {
    const { s } = store()
    const { token, deviceId } = connect(s, { apps: ["a/one"] })
    expect(grantAllowsApp(s.verify(token)!.grant, "a/one")).toBe(true)
    expect(grantAllowsApp(s.verify(token)!.grant, "b/two")).toBe(false)
    s.setGrant(deviceId, { apps: ["a/one", "b/two"] })
    expect(grantAllowsApp(s.verify(token)!.grant, "b/two")).toBe(true)
    s.setGrant(deviceId, { apps: "*", sessionsRead: true })
    expect(s.verify(token)!.grant).toEqual({ apps: "*", sessionsRead: true })
  })

  it("revocation is immediate and reported as access_revoked, not unknown", () => {
    const { s } = store()
    const { token, deviceId } = connect(s, { apps: "*" })
    expect(s.revoke(deviceId)).toBe(true)
    expect(s.verify(token)).toBeUndefined()
    expect(s.check(token)).toEqual({ error: "access_revoked" })
    expect(s.check("dvt_unknown")).toEqual({ error: "unknown" })
    expect(s.check("not-a-device-token")).toEqual({ error: "unknown" })
    expect(s.revoke(deviceId)).toBe(false)
  })

  it("an idle device loses access after 90 days, a used one keeps it", () => {
    const { s, clock } = store()
    const { token } = connect(s, { apps: "*" })
    clock.t += 80 * 24 * 3600_000
    expect(s.verify(token)).toBeDefined()
    clock.t += 80 * 24 * 3600_000
    expect(s.verify(token)).toBeDefined()
    clock.t += DEVICE_IDLE_TTL_MS + 1000
    expect(s.check(token)).toEqual({ error: "access_revoked" })
  })

  it("lists active devices without any token or hash, renames by name, refuses an ambiguous name", () => {
    const { s } = store()
    const a = connect(s, { apps: "*" })
    connect(s, { apps: "*" })
    const listed = JSON.stringify(s.list())
    expect(listed).not.toContain("tokenHash")
    expect(listed).not.toContain(a.token)
    // Two devices called "Pixel": the name alone is ambiguous, the id is not.
    expect(s.revoke("Pixel")).toBe(false)
    expect(s.rename(a.deviceId, "Jeremy's phone")).toBe(true)
    expect(s.revoke("Jeremy's phone")).toBe(true)
  })

  it("uninstalling an app removes it from grants and revokes a device left with nothing", () => {
    const { s } = store()
    const one = connect(s, { apps: ["a/one"] })
    const two = connect(s, { apps: ["a/one", "b/two"] })
    s.dropApp("a/one")
    expect(s.check(one.token)).toEqual({ error: "access_revoked" })
    expect(s.verify(two.token)!.grant.apps).toEqual(["b/two"])
  })
})

describe("persistence", () => {
  it("keeps devices (hashed, 0600) across a restart and never the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "device-access-"))
    try {
      const path = join(dir, "device-access.json")
      const a = new DeviceAccessStore({ path })
      const offer = a.offer({ grant: { apps: ["a/one"] } })
      const req = a.request({ offer: offer.code, deviceName: "Pixel" })
      if (!req.ok) throw new Error("request")
      a.decide(req.requestId, "approve")
      const r = a.poll(req.requestId, req.pollSecret)
      if (!("token" in r)) throw new Error("token")
      expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600")
      const raw = await readFile(path, "utf8")
      expect(raw).not.toContain(r.token)
      expect(raw).not.toContain(offer.code)
      const b = new DeviceAccessStore({ path })
      expect(b.verify(r.token)?.name).toBe("Pixel")
      // Offers and requests do not survive a restart.
      expect(b.request({ offer: offer.code })).toEqual({ ok: false, error: "invalid_offer" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("links and token extraction", () => {
  it("builds the one link format, code in the fragment", () => {
    const l = buildPairingLinks({ baseUrl: "https://host.example/x/y", code: "ABCD1234EFGH5678" })
    expect(l.link).toBe("https://host.example/pair#o=ABCD-1234-EFGH-5678")
    expect(l.fallbackLink).toBe("agentapp://pair?h=https%3A%2F%2Fhost.example&o=ABCD-1234-EFGH-5678")
    expect(new URL(l.link).search).toBe("")
  })

  it("reads a device token from a bearer header or the cookie, and nothing else", () => {
    const req = (headers: Record<string, string>) => ({ headers }) as never
    expect(extractDeviceToken(req({ authorization: "Bearer dvt_abc-_1" }))).toBe("dvt_abc-_1")
    expect(extractDeviceToken(req({ cookie: "x=1; agentproto_device=dvt_zzz" }))).toBe("dvt_zzz")
    expect(extractDeviceToken(req({ authorization: "Bearer sk-other" }))).toBeUndefined()
    expect(extractDeviceToken(req({ cookie: "agentproto_device=nope" }))).toBeUndefined()
    expect(extractDeviceToken(req({}))).toBeUndefined()
  })
})
