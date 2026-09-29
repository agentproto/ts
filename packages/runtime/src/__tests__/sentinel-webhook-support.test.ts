/**
 * Supporting pieces of the `webhook` sentinel provider: public-URL
 * resolution, the "sentinel" inbound dialect, and the adapter lister's
 * readiness reporting.
 */

import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSetupLedger } from "@agentproto/provider-kit"
import { afterEach, describe, expect, it } from "vitest"

import { INBOUND_PROVIDERS, normalizeInbound, verifyInboundSignature } from "../inbound-adapters.js"
import { makeSentinelCredsStore, makeSentinelLister, type SentinelAdapterInfo } from "../sentinel-adapters.js"
import {
  makePublicUrlResolver,
  publicUrlFromEnv,
  resolveSentinelPublicUrl,
  setSentinelPublicUrlSource,
} from "../sentinel-public-url.js"

describe("sentinel public URL", () => {
  it("AGENTPROTO_PUBLIC_URL wins, is normalized to an origin, and counts as stable", () => {
    expect(publicUrlFromEnv({ AGENTPROTO_PUBLIC_URL: "https://hooks.example.com/" })).toEqual({
      url: "https://hooks.example.com",
      stable: true,
      source: "env",
    })
  })

  it("falls back to AGENTPROTO_PUBLIC_HTTP_ORIGIN", () => {
    expect(publicUrlFromEnv({ AGENTPROTO_PUBLIC_HTTP_ORIGIN: "https://b.example.com" })?.url).toBe("https://b.example.com")
  })

  it.each(["", "not a url", "ftp://x.example.com", "https://u:p@x.example.com", "https://x.example.com/a/b", "https://x.example.com/?q=1"])(
    "rejects unusable value %j",
    value => {
      expect(publicUrlFromEnv({ AGENTPROTO_PUBLIC_URL: value })).toBeUndefined()
    },
  )

  const tunnels = [
    { provider: "cloudflare-quick", targetPort: 7777, publicUrl: "https://quick.trycloudflare.com", status: "active" },
    { provider: "cloudflare-named", targetPort: 7777, publicUrl: "https://named.example.com", status: "active" },
    { provider: "cloudflare-named", targetPort: 9999, publicUrl: "https://other-port.example.com", status: "active" },
    { provider: "cloudflare-named", targetPort: 7777, publicUrl: "https://dead.example.com", status: "stopped" },
  ]
  const isStable = (p: string): boolean => p === "cloudflare-named"

  it("prefers a stable tunnel forwarding to THIS daemon's port, ignoring other ports and dead tunnels", () => {
    const resolve = makePublicUrlResolver({ port: 7777, listTunnels: () => tunnels, isStableProvider: isStable, env: {} })
    expect(resolve()).toEqual({ url: "https://named.example.com", stable: true, source: "tunnel" })
  })

  it("an only-unstable tunnel is usable but not stable", () => {
    const resolve = makePublicUrlResolver({ port: 7777, listTunnels: () => tunnels.slice(0, 1), isStableProvider: isStable, env: {} })
    expect(resolve()).toEqual({ url: "https://quick.trycloudflare.com", stable: false, source: "tunnel" })
  })

  it("no env and no matching tunnel = undefined; env beats a tunnel", () => {
    const none = makePublicUrlResolver({ port: 1, listTunnels: () => tunnels, isStableProvider: isStable, env: {} })
    expect(none()).toBeUndefined()
    const pinned = makePublicUrlResolver({
      port: 7777,
      listTunnels: () => tunnels,
      isStableProvider: isStable,
      env: { AGENTPROTO_PUBLIC_URL: "https://pinned.example.com" },
    })
    expect(pinned()?.url).toBe("https://pinned.example.com")
  })

  it("the daemon-wired source overrides the env-only default and can be cleared", () => {
    try {
      setSentinelPublicUrlSource(() => ({ url: "https://wired.example.com", stable: true, source: "tunnel" }))
      expect(resolveSentinelPublicUrl()?.url).toBe("https://wired.example.com")
    } finally {
      setSentinelPublicUrlSource(undefined)
    }
  })
})

describe('"sentinel" inbound dialect', () => {
  const body = '{"a":1}'
  const secret = "s3cret"
  const sig = (b: string, s: string): string => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`

  it("is a registered dialect", () => {
    expect(INBOUND_PROVIDERS).toContain("sentinel")
  })

  it("verifies X-Hub-Signature-256 (constant-time HMAC) — ok, bad, missing", () => {
    const ok = verifyInboundSignature("sentinel", { rawBody: body, headers: { "x-hub-signature-256": sig(body, secret) }, secret, nowMs: 0 })
    expect(ok).toEqual({ ok: true })
    const bad = verifyInboundSignature("sentinel", { rawBody: body, headers: { "x-hub-signature-256": sig(body, "other") }, secret, nowMs: 0 })
    expect(bad.ok).toBe(false)
    const missing = verifyInboundSignature("sentinel", { rawBody: body, headers: {}, secret, nowMs: 0 })
    expect(missing).toMatchObject({ ok: false })
    if (!missing.ok) expect(missing.reason).toMatch(/^missing/)
  })

  it("does not normalize into a session message (sentinel events take the runtime path)", () => {
    const r = normalizeInbound("sentinel", {}, { alias: "x" })
    expect(r.ok).toBe(false)
  })
})

describe("list_sentinel_adapters lister — webhook readiness", () => {
  const dirs: string[] = []
  const saved = { url: process.env.AGENTPROTO_PUBLIC_URL, origin: process.env.AGENTPROTO_PUBLIC_HTTP_ORIGIN }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    for (const [k, v] of [
      ["AGENTPROTO_PUBLIC_URL", saved.url],
      ["AGENTPROTO_PUBLIC_HTTP_ORIGIN", saved.origin],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    setSentinelPublicUrlSource(undefined)
  })

  it("shows webhook as available (NOT ready) with the reason when there is no public URL", async () => {
    delete process.env.AGENTPROTO_PUBLIC_URL
    delete process.env.AGENTPROTO_PUBLIC_HTTP_ORIGIN
    setSentinelPublicUrlSource(undefined)
    const home = mkdtempSync(join(tmpdir(), "wh-lister-"))
    dirs.push(home)
    const lister = makeSentinelLister({ credsStore: makeSentinelCredsStore(home), ledger: makeSetupLedger({ home }) })

    const entries = await lister()
    const webhook = entries.find(e => e.slug === "webhook")
    expect(webhook).toBeDefined()
    expect(webhook!.status).toBe("available")
    const info = webhook!.info as SentinelAdapterInfo
    expect(info.readiness?.ready).toBe(false)
    expect(info.readiness?.reason).toMatch(/public URL/)
    expect(info.capabilities).toMatchObject({ push: true, needsPublicUrl: true })

    // local-gh is unaffected
    const local = entries.find(e => e.slug === "local-gh")
    expect(local?.status).not.toBe("available")
  })
})
