import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  makeTokenResolver,
  parseManagedZones,
  parseStoredTokens,
  resolveZoneForHostname,
  type ManagedZoneConfig,
} from "../remote-providers/cloudflare-managed-config.js"
import {
  MANAGED_DNS_COMMENT,
  ManagedTunnelEngine,
  managedTunnelName,
  tunnelCnameTarget,
} from "../remote-providers/cloudflare-managed-engine.js"
import { FakeCloudflare } from "./helpers/fake-cloudflare.js"

const ZONES: ManagedZoneConfig[] = [
  { zone: "example.com", accountId: "acct-a", tokenRef: "stored:examplecom" },
  { zone: "example.dev", accountId: "acct-a", tokenRef: "stored:exampledev", maxLabels: 2 },
  { zone: "other.dev", accountId: "acct-b", tokenRef: "stored:other" },
]
const TOKENS = { examplecom: "tok-examplecom", exampledev: "tok-exampledev", other: "tok-other" }

function setup() {
  const cf = new FakeCloudflare([
    { id: "zone-examplecom", name: "example.com", account: "acct-a", token: "tok-examplecom" },
    { id: "zone-exampledev", name: "example.dev", account: "acct-a", token: "tok-exampledev" },
    { id: "zone-other", name: "other.dev", account: "acct-b", token: "tok-other" },
  ])
  const logs: string[] = []
  const engine = new ManagedTunnelEngine({
    zones: ZONES,
    resolveToken: makeTokenResolver({ storedTokens: TOKENS }),
    fetch: cf.fetch,
    onLog: l => logs.push(l),
  })
  return { cf, engine, logs }
}

const SERVICE = "http://127.0.0.1:8081"

describe("cloudflare-managed config", () => {
  it("parses zones and rejects raw tokens / missing fields", () => {
    expect(
      parseManagedZones(JSON.stringify([{ zone: "Example.COM.", accountId: "a", tokenRef: "env:X" }])),
    ).toEqual([{ zone: "example.com", accountId: "a", tokenRef: "env:X" }])
    expect(() => parseManagedZones(undefined)).toThrow(/not configured/)
    expect(() => parseManagedZones("{")).toThrow(/JSON array/)
    expect(() =>
      parseManagedZones(JSON.stringify([{ zone: "a.net", accountId: "a", tokenRef: "abcd1234" }])),
    ).toThrow(/reference/)
    expect(() => parseManagedZones(JSON.stringify([{ zone: "a.net", tokenRef: "env:X" }]))).toThrow(
      /accountId/,
    )
    expect(() =>
      parseManagedZones(
        JSON.stringify([{ zone: "a.net", accountId: "a", tokenRef: "env:X", maxLabels: 0 }]),
      ),
    ).toThrow(/maxLabels/)
  })

  it("picks the zone by suffix, longest first", () => {
    const zones: ManagedZoneConfig[] = [
      { zone: "example.com", accountId: "a", tokenRef: "env:A" },
      { zone: "eu.example.com", accountId: "a", tokenRef: "env:B" },
    ]
    expect(resolveZoneForHostname(zones, "wa.example.com").zone).toBe("example.com")
    expect(resolveZoneForHostname(zones, "wa.eu.example.com").zone).toBe("eu.example.com")
  })

  it("errors clearly on no matching zone, apex, or a too-deep hostname", () => {
    expect(() => resolveZoneForHostname(ZONES, "wa.example.org")).toThrow(
      /no configured zone serves "wa.example.org".*example.com, example.dev, other.dev/,
    )
    expect(() => resolveZoneForHostname(ZONES, "example.com")).toThrow(/apex/)
    expect(() => resolveZoneForHostname(ZONES, "a.b.example.com")).toThrow(
      /2 labels deep under zone "example.com".*only serves 1/,
    )
    // example.dev allows 2 labels (ACM).
    expect(resolveZoneForHostname(ZONES, "a.b.example.dev").zone).toBe("example.dev")
    expect(() => resolveZoneForHostname(ZONES, "bad_host.example.com")).toThrow(/not a valid/)
  })

  it("resolves token refs without ever putting the value in an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-tok-"))
    try {
      const f = join(dir, "tok")
      writeFileSync(f, "file-secret\n")
      chmodSync(f, 0o644)
      const resolve = makeTokenResolver({
        env: { CF_TOK: "env-secret" },
        storedTokens: { k: "stored-secret" },
        keychain: { read: async ref => (ref.path === "cf/examplecom" ? { value: "kc-secret", kind: "pat" } : undefined) },
        platform: "linux",
      })
      expect(await resolve("env:CF_TOK")).toBe("env-secret")
      expect(await resolve("stored:k")).toBe("stored-secret")
      expect(await resolve("keychain:cf/examplecom")).toBe("kc-secret")
      await expect(resolve(`file:${f}`)).rejects.toThrow(/chmod 600/)
      chmodSync(f, 0o600)
      expect(await resolve(`file:${f}`)).toBe("file-secret")
      await expect(resolve("env:MISSING")).rejects.toThrow(/resolved to nothing/)
      const err = (await resolve("stored:nope").catch((e: unknown) => e)) as Error
      expect(err.message).toMatch(/stored:nope/)
      expect(err.message).not.toMatch(/secret/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("validates zoneTokens shape", () => {
    expect(parseStoredTokens(undefined)).toEqual({})
    expect(parseStoredTokens('{"a":"b"}')).toEqual({ a: "b" })
    expect(() => parseStoredTokens("[1]")).toThrow(/JSON object/)
    expect(() => parseStoredTokens('{"a":""}')).toThrow(/zoneTokens\["a"\]/)
  })
})

describe("ManagedTunnelEngine.reconcile", () => {
  it("creates tunnel, ingress and a proxied, comment-marked CNAME", async () => {
    const { cf, engine } = setup()
    const res = await engine.reconcile({ key: "wa", hostnames: ["wa.example.com"] }, SERVICE)

    expect(res.created).toBe(true)
    expect(res.tunnelName).toBe("agentproto-managed-wa")
    expect(res.token).toBe(cf.tunnels[0]!.token)
    const t = cf.tunnels[0]!
    expect(t.name).toBe("agentproto-managed-wa")
    expect(t.ingress).toEqual([
      { hostname: "wa.example.com", service: SERVICE },
      { service: "http_status:404" },
    ])
    expect(cf.records).toEqual([
      expect.objectContaining({
        zoneId: "zone-examplecom",
        type: "CNAME",
        name: "wa.example.com",
        content: tunnelCnameTarget(t.id),
        proxied: true,
        comment: MANAGED_DNS_COMMENT,
      }),
    ])
    const create = cf.requests.find(r => r.method === "POST" && r.path.endsWith("/cfd_tunnel"))
    expect(create?.body).toEqual({ name: "agentproto-managed-wa", config_src: "cloudflare" })
    // list-before-create
    expect(cf.calls().indexOf("GET /accounts/acct-a/cfd_tunnel")).toBeLessThan(
      cf.calls().indexOf("POST /accounts/acct-a/cfd_tunnel"),
    )
    // every call authenticated with the zone's token, never another one
    expect(cf.requests.every(r => r.auth === "Bearer tok-examplecom")).toBe(true)
  })

  it("is idempotent: a replay never duplicates the tunnel or the record", async () => {
    const { cf, engine } = setup()
    const a = await engine.reconcile({ key: "wa", hostnames: ["wa.example.com"] }, SERVICE)
    const b = await engine.reconcile(
      { key: "wa", hostnames: ["wa.example.com"] },
      "http://127.0.0.1:9999",
    )
    expect(b.created).toBe(false)
    expect(b.tunnelId).toBe(a.tunnelId)
    expect(b.token).toBe(a.token)
    expect(cf.liveTunnels()).toHaveLength(1)
    expect(cf.records).toHaveLength(1)
    // the replay re-PUTs the ingress with the new origin
    expect(cf.tunnels[0]!.ingress[0]).toEqual({
      hostname: "wa.example.com",
      service: "http://127.0.0.1:9999",
    })
  })

  it("refuses to touch a DNS record it did not create", async () => {
    const { cf, engine } = setup()
    cf.addRecord({ zoneId: "zone-examplecom", type: "A", name: "wa.example.com", content: "1.2.3.4" })
    await expect(
      engine.reconcile({ key: "wa", hostnames: ["wa.example.com"] }, SERVICE),
    ).rejects.toThrow(/A wa.example.com already exists and was not created by agentproto/)
    expect(cf.records[0]).toMatchObject({ type: "A", content: "1.2.3.4" })
    expect(cf.requests.some(r => r.method === "PATCH" || r.method === "DELETE")).toBe(false)
  })

  it("repoints its own CNAME left behind by a dead tunnel, but never steals a live one", async () => {
    const { cf, engine } = setup()
    cf.addRecord({
      zoneId: "zone-examplecom",
      type: "CNAME",
      name: "wa.example.com",
      content: "dead0000-0000-4000-8000-000000000000.cfargotunnel.com",
      proxied: true,
      comment: MANAGED_DNS_COMMENT,
    })
    const res = await engine.reconcile({ key: "wa", hostnames: ["wa.example.com"] }, SERVICE)
    expect(cf.records).toHaveLength(1)
    expect(cf.records[0]!.content).toBe(tunnelCnameTarget(res.tunnelId))

    // a second managed tunnel asking for the same hostname is refused
    await expect(
      engine.reconcile({ key: "other", hostnames: ["wa.example.com"] }, SERVICE),
    ).rejects.toThrow(/already routed to live tunnel agentproto-managed-wa/)
    expect(cf.records[0]!.content).toBe(tunnelCnameTarget(res.tunnelId))
  })

  it("fails before any API call when the hostname has no zone or is too deep", async () => {
    const { cf, engine } = setup()
    await expect(
      engine.reconcile({ key: "wa", hostnames: ["wa.example.org"] }, SERVICE),
    ).rejects.toThrow(/no configured zone/)
    await expect(
      engine.reconcile({ key: "wa", hostnames: ["a.b.example.com"] }, SERVICE),
    ).rejects.toThrow(/maxLabels/)
    expect(cf.requests).toHaveLength(0)
  })

  it("rejects hostnames spanning two accounts", async () => {
    const { engine } = setup()
    expect(() => engine.validateHostnames(["wa.example.com", "wa.other.dev"])).toThrow(
      /a tunnel can only serve zones of its own account/,
    )
  })

  it("sanitises the key into a Cloudflare-safe, prefixed tunnel name", () => {
    expect(managedTunnelName("WA Relay_1")).toBe("agentproto-managed-wa-relay-1")
    expect(() => managedTunnelName("***")).toThrow(/empty/)
  })
})

describe("ManagedTunnelEngine swap + destroy", () => {
  it("swap: both hostnames served during overlap, old one removed on demand", async () => {
    const { cf, engine } = setup()
    await engine.reconcile({ key: "wa", hostnames: ["wa.example.com"] }, SERVICE)
    // add the new hostname on another zone of the same account (new first = primary)
    await engine.reconcile({ key: "wa", hostnames: ["wa.example.dev", "wa.example.com"] }, SERVICE)
    const t = cf.liveTunnels()[0]!
    expect(cf.liveTunnels()).toHaveLength(1)
    expect(t.ingress.map(r => r.hostname)).toEqual(["wa.example.dev", "wa.example.com", undefined])
    expect(cf.records.map(r => r.name).sort()).toEqual(["wa.example.com", "wa.example.dev"])
    // the exampledev record was written with the exampledev token
    const post = cf.requests.find(r => r.method === "POST" && r.path === "/zones/zone-exampledev/dns_records")
    expect(post?.auth).toBe("Bearer tok-exampledev")

    await engine.removeHostname(
      { key: "wa", hostnames: ["wa.example.dev", "wa.example.com"] },
      "wa.example.com",
    )
    expect(t.ingress).toEqual([
      { hostname: "wa.example.dev", service: SERVICE },
      { service: "http_status:404" },
    ])
    expect(cf.records.map(r => r.name)).toEqual(["wa.example.dev"])
    await expect(
      engine.removeHostname({ key: "wa", hostnames: ["wa.example.dev"] }, "wa.example.dev"),
    ).rejects.toThrow(/last hostname/)
  })

  it("reconcile with service=null keeps the remote origin (tunnel not running here)", async () => {
    const { cf, engine } = setup()
    await engine.reconcile({ key: "wa", hostnames: ["wa.example.com"] }, SERVICE)
    await engine.reconcile({ key: "wa", hostnames: ["wa2.example.com", "wa.example.com"] }, null)
    expect(cf.liveTunnels()[0]!.ingress).toEqual([
      { hostname: "wa2.example.com", service: SERVICE },
      { hostname: "wa.example.com", service: SERVICE },
      { service: "http_status:404" },
    ])
  })

  it("destroy: CNAME → connections → tunnel, in that order", async () => {
    const { cf, engine } = setup()
    const res = await engine.reconcile({ key: "wa", hostnames: ["wa.example.com"] }, SERVICE)
    cf.tunnels[0]!.connections = 4
    const recordId = cf.records[0]!.id
    const before = cf.requests.length
    await engine.destroy({ key: "wa", hostnames: ["wa.example.com"] })
    const calls = cf.calls().slice(before).filter(c => c.startsWith("DELETE"))
    expect(calls).toEqual([
      `DELETE /zones/zone-examplecom/dns_records/${recordId}`,
      `DELETE /accounts/acct-a/cfd_tunnel/${res.tunnelId}/connections`,
      `DELETE /accounts/acct-a/cfd_tunnel/${res.tunnelId}`,
    ])
    expect(cf.records).toHaveLength(0)
    expect(cf.liveTunnels()).toHaveLength(0)
  })

  it("destroy tolerates everything already being gone", async () => {
    const { cf, engine } = setup()
    await engine.destroy({ key: "wa", hostnames: ["wa.example.com"] })
    expect(cf.requests.some(r => r.method === "DELETE")).toBe(false)

    const res = await engine.reconcile({ key: "wa", hostnames: ["wa.example.com"] }, SERVICE)
    cf.records.length = 0 // CNAME removed out-of-band
    cf.failures.push({
      method: "DELETE",
      path: new RegExp(`/cfd_tunnel/${res.tunnelId}$`),
      status: 404,
      once: true,
    })
    await expect(engine.destroy({ key: "wa", hostnames: ["wa.example.com"] })).resolves.toBeUndefined()
  })

  it("destroy leaves foreign and other-tunnel records alone", async () => {
    const { cf, engine } = setup()
    await engine.reconcile({ key: "wa", hostnames: ["wa.example.com"] }, SERVICE)
    // a foreign TXT on the same name + an engine-marked CNAME of another tunnel
    cf.addRecord({ zoneId: "zone-examplecom", type: "TXT", name: "wa.example.com", content: "v=spf1" })
    cf.records.find(r => r.type === "CNAME")!.content = "aaaa.cfargotunnel.com"
    await engine.destroy({ key: "wa", hostnames: ["wa.example.com"] })
    expect(cf.records.map(r => r.type).sort()).toEqual(["CNAME", "TXT"])
  })

  it("never lists or deletes a tunnel without the managed prefix", async () => {
    const { cf, engine } = setup()
    cf.tunnels.push({
      id: "hand-made",
      name: "wa",
      account: "acct-a",
      token: "x",
      ingress: [],
      connections: 0,
    })
    await engine.reconcile({ key: "wa", hostnames: ["wa.example.com"] }, SERVICE)
    await engine.destroy({ key: "wa", hostnames: ["wa.example.com"] })
    expect(cf.tunnels.find(t => t.id === "hand-made")?.deleted_at).toBeUndefined()
    expect(cf.requests.some(r => r.path.includes("hand-made"))).toBe(false)
  })

  it("surfaces API errors without leaking the token", async () => {
    const { cf, engine } = setup()
    cf.failures.push({ method: "POST", path: /cfd_tunnel$/, status: 403, once: true })
    const err = await engine
      .reconcile({ key: "wa", hostnames: ["wa.example.com"] }, SERVICE)
      .catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/cloudflare POST \/accounts\/acct-a\/cfd_tunnel failed \(403\)/)
    expect((err as Error).message).not.toContain("tok-examplecom")
  })
})
