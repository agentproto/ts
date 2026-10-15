/**
 * In-memory simulation of the slice of the Cloudflare v4 API the
 * `cloudflare-managed` tunnel engine uses. Plugs in as an injected `fetch`
 * — no network, no real token. Records every request so tests can assert
 * ordering, and checks the Bearer token per account/zone.
 */

import type { FetchLike } from "../../remote-providers/cloudflare-api.js"

export interface FakeTunnel {
  id: string
  name: string
  account: string
  token: string
  ingress: Array<{ hostname?: string; service: string }>
  connections: number
  deleted_at?: string | null
}

export interface FakeDnsRecord {
  id: string
  zoneId: string
  type: string
  name: string
  content: string
  proxied?: boolean
  comment?: string | null
}

export interface FakeZone {
  id: string
  name: string
  account: string
  /** Token accepted for this zone's DNS + its account's tunnels. */
  token: string
}

export interface FakeRequest {
  method: string
  path: string
  body?: unknown
  auth?: string
}

export class FakeCloudflare {
  readonly zones: FakeZone[]
  readonly tunnels: FakeTunnel[] = []
  readonly records: FakeDnsRecord[] = []
  readonly requests: FakeRequest[] = []
  private seq = 0
  /** Force the next matching request to fail: `${METHOD} ${pathRegex}` → status. */
  readonly failures: Array<{ method: string; path: RegExp; status: number; once: boolean }> = []

  constructor(zones: FakeZone[]) {
    this.zones = zones
  }

  nextId(prefix: string): string {
    this.seq++
    return `${prefix}${String(this.seq).padStart(4, "0")}-0000-4000-8000-000000000000`.slice(0, 36)
  }

  addRecord(r: Omit<FakeDnsRecord, "id">): FakeDnsRecord {
    const rec = { id: this.nextId("r"), ...r }
    this.records.push(rec)
    return rec
  }

  liveTunnels(): FakeTunnel[] {
    return this.tunnels.filter(t => !t.deleted_at)
  }

  fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    const method = init?.method ?? "GET"
    const path = url.pathname.replace(/^\/client\/v4/, "")
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined
    const auth = init?.headers?.authorization
    this.requests.push({ method, path, ...(body !== undefined ? { body } : {}), ...(auth ? { auth } : {}) })

    const failIdx = this.failures.findIndex(f => f.method === method && f.path.test(path))
    if (failIdx >= 0) {
      const f = this.failures[failIdx]!
      if (f.once) this.failures.splice(failIdx, 1)
      return respond(f.status, { success: false, errors: [{ code: f.status, message: "forced" }] })
    }

    const token = auth?.replace(/^Bearer /, "")
    const segs = path.split("/").filter(Boolean)

    // /zones?name=…
    if (segs[0] === "zones" && segs.length === 1 && method === "GET") {
      const name = url.searchParams.get("name")
      const acct = url.searchParams.get("account.id")
      const hits = this.zones.filter(
        z => z.name === name && (!acct || z.account === acct) && z.token === token,
      )
      return ok(hits.map(z => ({ id: z.id, name: z.name })))
    }

    if (segs[0] === "zones" && segs[2] === "dns_records") {
      const zone = this.zones.find(z => z.id === segs[1])
      if (!zone) return notFound()
      if (zone.token !== token) return forbidden()
      const recId = segs[3]
      if (!recId && method === "GET") {
        const name = url.searchParams.get("name")
        return ok(this.records.filter(r => r.zoneId === zone.id && (!name || r.name === name)).map(strip))
      }
      if (!recId && method === "POST") {
        const b = body as Omit<FakeDnsRecord, "id" | "zoneId">
        if (this.records.some(r => r.zoneId === zone.id && r.name === b.name && r.type === "CNAME")) {
          return respond(400, { success: false, errors: [{ code: 81053, message: "record exists" }] })
        }
        const rec = this.addRecord({ ...b, zoneId: zone.id })
        return ok(strip(rec))
      }
      const rec = this.records.find(r => r.id === recId && r.zoneId === zone.id)
      if (!rec) return notFound()
      if (method === "PATCH") {
        Object.assign(rec, body as object)
        return ok(strip(rec))
      }
      if (method === "DELETE") {
        this.records.splice(this.records.indexOf(rec), 1)
        return ok({ id: rec.id })
      }
    }

    if (segs[0] === "accounts" && segs[2] === "cfd_tunnel") {
      const account = segs[1]!
      if (!this.zones.some(z => z.account === account && z.token === token)) return forbidden()
      const tid = segs[3]
      const sub = segs[4]
      if (!tid && method === "GET") {
        const name = url.searchParams.get("name")
        const isDeleted = url.searchParams.get("is_deleted")
        return ok(
          this.tunnels
            .filter(t => t.account === account && (!name || t.name === name))
            .filter(t => (isDeleted === "false" ? !t.deleted_at : true))
            .map(publicTunnel),
        )
      }
      if (!tid && method === "POST") {
        const b = body as { name: string; config_src?: string }
        const t: FakeTunnel = {
          id: this.nextId("t"),
          name: b.name,
          account,
          token: `tunnel-secret-${this.seq}`,
          ingress: [],
          connections: 0,
        }
        this.tunnels.push(t)
        return ok({ ...publicTunnel(t), token: t.token })
      }
      const t = this.tunnels.find(x => x.id === tid && x.account === account)
      if (!t || t.deleted_at) return notFound()
      if (!sub && method === "GET") return ok(publicTunnel(t))
      if (!sub && method === "DELETE") {
        if (t.connections > 0) {
          return respond(400, { success: false, errors: [{ code: 1022, message: "active connections" }] })
        }
        t.deleted_at = new Date().toISOString()
        return ok(publicTunnel(t))
      }
      if (sub === "token" && method === "GET") return ok(t.token)
      if (sub === "configurations" && method === "GET") return ok({ config: { ingress: t.ingress } })
      if (sub === "configurations" && method === "PUT") {
        t.ingress = (body as { config: { ingress: FakeTunnel["ingress"] } }).config.ingress
        return ok({ config: { ingress: t.ingress } })
      }
      if (sub === "connections" && method === "DELETE") {
        t.connections = 0
        return ok(null)
      }
    }

    return notFound()
  }

  /** Requests reduced to `METHOD /path` (query stripped), for order checks. */
  calls(): string[] {
    return this.requests.map(r => `${r.method} ${r.path}`)
  }
}

function strip(r: FakeDnsRecord): Omit<FakeDnsRecord, "zoneId"> {
  const { zoneId: _z, ...rest } = r
  return rest
}

function publicTunnel(t: FakeTunnel): { id: string; name: string; deleted_at: string | null } {
  return { id: t.id, name: t.name, deleted_at: t.deleted_at ?? null }
}

function respond(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

const ok = (result: unknown) => respond(200, { success: true, errors: [], result })
const notFound = () => respond(404, { success: false, errors: [{ code: 7003, message: "not found" }] })
const forbidden = () => respond(403, { success: false, errors: [{ code: 10000, message: "auth error" }] })
