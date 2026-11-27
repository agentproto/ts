/**
 * HTTP-bound device access (AIP-59 pairing, HTTP binding): a person gets a
 * one-time link, the device that opens it asks for access, a human on a channel
 * already tied to the machine confirms (comparing a short number), and the
 * device receives a revocable token limited to the apps it was granted.
 *
 * Three separate things, on purpose:
 *   - an OFFER: a code, one use, 10 minutes, carrying a grant (the scope);
 *   - a REQUEST: what a device does with an offer; it waits for a confirmation;
 *   - a DEVICE: what exists after the confirmation, with its grant.
 * The grant is a property of the device, never baked into the token format.
 *
 * Only sha256 hashes are stored (codes, poll secrets, tokens). Devices persist
 * in `device-access.json` (0600) and show up in the daemon's device list.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { IncomingMessage } from "node:http"

export const DEVICE_TOKEN_PREFIX = "dvt_"
export const DEVICE_COOKIE = "agentproto_device"
export const DEFAULT_OFFER_TTL_MS = 10 * 60_000
export const MAX_OFFER_TTL_MS = 60 * 60_000
/** A request waits this long for its confirmation. */
export const REQUEST_TTL_MS = 10 * 60_000
/** A device that is not used for this long loses its access. */
export const DEVICE_IDLE_TTL_MS = 90 * 24 * 60 * 60_000
/** Wrong offers allowed before pending offers are burned and requests locked for a while. */
const MAX_BAD_ATTEMPTS = 8
const LOCK_MS = 60_000
const TOUCH_INTERVAL_MS = 60_000

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** What a device may do. `apps` is `"*"` or the exact app ids; the control of the whole machine is NOT a grant here. */
export interface DeviceGrant {
  apps: "*" | string[]
  /** May read the daemon's session routes (`GET /sessions/…`), as a chat viewer needs. */
  sessionsRead: boolean
}

export interface AccessDevice {
  id: string
  name: string
  platform: string
  tokenHash: string
  createdAt: string
  lastUsedAt?: string
  /** Sliding: pushed back on use. */
  idleExpiresAt: string
  revokedAt?: string
  grant: DeviceGrant
}

/** What the daemon shows about a device: never the token or its hash. */
export type AccessDeviceInfo = Omit<AccessDevice, "tokenHash"> & { active: boolean }

export type RequestStatus = "pending" | "approved" | "denied" | "expired"

interface Offer {
  codeHash: string
  grant: DeviceGrant
  label?: string
  expiresAt: number
}

interface PairRequest {
  id: string
  secretHash: string
  number: string
  deviceName: string
  platform: string
  grant: DeviceGrant
  createdAt: number
  expiresAt: number
  status: RequestStatus
  /** Set once the device has been created (at first read after the approval). */
  deviceId?: string
  delivered: boolean
  /** Approval record that carries the confirmation, when a channel is wired. */
  approvalId?: string
}

export type OfferFailure = "invalid_offer" | "offer_expired" | "locked"

export interface DeviceAccessStoreOptions {
  path?: string
  persist?: boolean
  now?: () => number
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

export function defaultDeviceAccessPath(): string {
  return join(process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto"), "device-access.json")
}

/** Normalise what a person typed or a link carried. */
export function normalizeOfferCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1")
}

export function formatOfferCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code
}

function newOfferCode(): string {
  let out = ""
  for (const b of randomBytes(16)) out += CROCKFORD[b & 31]
  return out
}

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Two digits, 10..99, uniform. */
function newComparisonNumber(): string {
  return String(10 + (randomBytes(2).readUInt16BE(0) % 90))
}

export class DeviceAccessStore {
  private readonly path: string
  private readonly persist: boolean
  private readonly now: () => number
  private devices: AccessDevice[] = []
  private offers = new Map<string, Offer>()
  private requests = new Map<string, PairRequest>()
  private badAttempts: number[] = []
  private lockedUntil = 0
  private lastTouch = new Map<string, number>()

  constructor(opts: DeviceAccessStoreOptions = {}) {
    this.path = opts.path ?? defaultDeviceAccessPath()
    this.persist = opts.persist ?? true
    this.now = opts.now ?? Date.now
    if (this.persist && existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { devices?: AccessDevice[] }
        this.devices = Array.isArray(parsed.devices) ? parsed.devices : []
      } catch {
        this.devices = []
      }
    }
  }

  private save(): void {
    if (!this.persist) return
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, devices: this.devices }, null, 2) + "\n", { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.path)
  }

  // ── offers ──────────────────────────────────────────────────────────────

  /** Create a one-time offer. The plain code is returned once and never stored. */
  offer(input: { grant: Partial<DeviceGrant> & { apps: "*" | string[] }; ttlMs?: number; label?: string }): {
    code: string
    expiresAt: string
  } {
    const ttl = Math.min(Math.max(input.ttlMs ?? DEFAULT_OFFER_TTL_MS, 30_000), MAX_OFFER_TTL_MS)
    this.prune()
    const code = newOfferCode()
    const expiresAt = this.now() + ttl
    this.offers.set(sha256(code), {
      codeHash: sha256(code),
      grant: normalizeGrant(input.grant),
      ...(input.label ? { label: input.label } : {}),
      expiresAt,
    })
    return { code, expiresAt: new Date(expiresAt).toISOString() }
  }

  private prune(keepOffers = false): void {
    const t = this.now()
    if (!keepOffers) for (const [k, o] of this.offers) if (o.expiresAt <= t) this.offers.delete(k)
    for (const [k, r] of this.requests) {
      if (r.status === "pending" && r.expiresAt <= t) r.status = "expired"
      // Forget finished requests a while after they end.
      if (r.expiresAt + 10 * 60_000 <= t) this.requests.delete(k)
    }
    this.badAttempts = this.badAttempts.filter(a => a > t - LOCK_MS)
  }

  /** A device presents an offer. The offer is consumed; the request waits for a confirmation. */
  request(input: { offer: string; deviceName?: string; platform?: string }):
    | { ok: true; requestId: string; pollSecret: string; number: string; expiresAt: string; grant: DeviceGrant; deviceName: string; platform: string }
    | { ok: false; error: OfferFailure } {
    // Keep expired offers for this lookup, so an expired code says so.
    this.prune(true)
    const t = this.now()
    if (this.lockedUntil > t) return { ok: false, error: "locked" }
    const key = sha256(normalizeOfferCode(input.offer))
    const offer = this.offers.get(key)
    if (!offer) {
      this.badAttempts.push(t)
      if (this.badAttempts.length >= MAX_BAD_ATTEMPTS) {
        // Too many wrong guesses: nothing pending survives, and nothing is accepted for a minute.
        this.offers.clear()
        this.badAttempts = []
        this.lockedUntil = t + LOCK_MS
        return { ok: false, error: "locked" }
      }
      return { ok: false, error: "invalid_offer" }
    }
    this.offers.delete(key)
    if (offer.expiresAt <= t) return { ok: false, error: "offer_expired" }
    const pollSecret = randomBytes(32).toString("base64url")
    const deviceName = (input.deviceName ?? "").trim().slice(0, 80) || offer.label || "Device"
    const platform = (input.platform ?? "").trim().slice(0, 40) || "unknown"
    const req: PairRequest = {
      id: `pr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      secretHash: sha256(pollSecret),
      number: newComparisonNumber(),
      deviceName,
      platform,
      grant: offer.grant,
      createdAt: t,
      expiresAt: t + REQUEST_TTL_MS,
      status: "pending",
      delivered: false,
    }
    this.requests.set(req.id, req)
    return {
      ok: true,
      requestId: req.id,
      pollSecret,
      number: req.number,
      expiresAt: new Date(req.expiresAt).toISOString(),
      grant: offer.grant,
      deviceName,
      platform,
    }
  }

  /** Link the confirmation record (an approval) to a request. */
  attachApproval(requestId: string, approvalId: string): void {
    const r = this.requests.get(requestId)
    if (r) r.approvalId = approvalId
  }

  /** The pending request details a confirmation card shows. */
  describeRequest(requestId: string):
    | { id: string; number: string; deviceName: string; platform: string; grant: DeviceGrant; expiresAt: string; status: RequestStatus; approvalId?: string }
    | undefined {
    this.prune()
    const r = this.requests.get(requestId)
    return r
      ? {
          id: r.id,
          number: r.number,
          deviceName: r.deviceName,
          platform: r.platform,
          grant: r.grant,
          expiresAt: new Date(r.expiresAt).toISOString(),
          status: r.status,
          ...(r.approvalId ? { approvalId: r.approvalId } : {}),
        }
      : undefined
  }

  /** Pending requests, for the operator's own list. */
  pendingRequests(): NonNullable<ReturnType<DeviceAccessStore["describeRequest"]>>[] {
    this.prune()
    return [...this.requests.values()]
      .filter(r => r.status === "pending")
      .map(r => this.describeRequest(r.id)!)
  }

  /** A human decided. Returns false when the request is unknown or no longer pending. */
  decide(requestId: string, decision: "approve" | "deny"): boolean {
    this.prune()
    const r = this.requests.get(requestId)
    if (!r || r.status !== "pending") return false
    r.status = decision === "approve" ? "approved" : "denied"
    return true
  }

  /**
   * The device polls. `decided` is what the confirmation channel says right
   * now (an approval record's status), consulted while the request is pending.
   * The token is returned once, on the first read after the approval.
   */
  poll(
    requestId: string,
    pollSecret: string,
    decided?: "approved" | "denied" | "expired" | undefined,
  ):
    | { ok: true; status: "pending" | "denied" | "expired" }
    | { ok: true; status: "approved"; token: string; deviceId: string }
    | { ok: false; error: "not_found" | "already_delivered" } {
    this.prune()
    const r = this.requests.get(requestId)
    if (!r || !eq(r.secretHash, sha256(pollSecret))) return { ok: false, error: "not_found" }
    if (r.status === "pending" && decided === "approved") r.status = "approved"
    else if (r.status === "pending" && decided === "denied") r.status = "denied"
    else if (r.status === "pending" && decided === "expired") r.status = "expired"
    if (r.status !== "approved") return { ok: true, status: r.status }
    if (r.delivered) return { ok: false, error: "already_delivered" }
    const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString("base64url")
    const t = this.now()
    const device: AccessDevice = {
      id: `dev_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      name: r.deviceName,
      platform: r.platform,
      tokenHash: sha256(token),
      createdAt: new Date(t).toISOString(),
      idleExpiresAt: new Date(t + DEVICE_IDLE_TTL_MS).toISOString(),
      grant: r.grant,
    }
    this.devices.push(device)
    r.delivered = true
    r.deviceId = device.id
    this.save()
    return { ok: true, status: "approved", token, deviceId: device.id }
  }

  // ── devices ─────────────────────────────────────────────────────────────

  private isActive(d: AccessDevice): boolean {
    return !d.revokedAt && Date.parse(d.idleExpiresAt) > this.now()
  }

  private info(d: AccessDevice): AccessDeviceInfo {
    const { tokenHash: _h, ...rest } = d
    return { ...rest, active: this.isActive(d) }
  }

  /** Why a token is not accepted: unknown, revoked or idle for too long. */
  check(token: string): { device: AccessDeviceInfo } | { error: "unknown" | "access_revoked" } {
    if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return { error: "unknown" }
    const h = sha256(token)
    const d = this.devices.find(x => eq(x.tokenHash, h))
    if (!d) return { error: "unknown" }
    if (!this.isActive(d)) return { error: "access_revoked" }
    const t = this.now()
    if (t - (this.lastTouch.get(d.id) ?? 0) >= TOUCH_INTERVAL_MS) {
      d.lastUsedAt = new Date(t).toISOString()
      d.idleExpiresAt = new Date(t + DEVICE_IDLE_TTL_MS).toISOString()
      this.lastTouch.set(d.id, t)
      this.save()
    }
    return { device: this.info(d) }
  }

  /** The active device a token belongs to. */
  verify(token: string): AccessDeviceInfo | undefined {
    const r = this.check(token)
    return "device" in r ? r.device : undefined
  }

  list(filter: { includeInactive?: boolean } = {}): AccessDeviceInfo[] {
    return this.devices.filter(d => filter.includeInactive || this.isActive(d)).map(d => this.info(d))
  }

  private find(idOrName: string): AccessDevice | undefined {
    const live = this.devices.filter(d => !d.revokedAt)
    const byId = live.filter(d => d.id === idOrName)
    if (byId.length === 1) return byId[0]
    const byName = live.filter(d => d.name === idOrName)
    return byName.length === 1 ? byName[0] : undefined
  }

  has(idOrName: string): boolean {
    return this.find(idOrName) !== undefined
  }

  revoke(idOrName: string): boolean {
    const d = this.find(idOrName)
    if (!d) return false
    d.revokedAt = new Date(this.now()).toISOString()
    this.save()
    return true
  }

  rename(idOrName: string, newName: string): boolean {
    const d = this.find(idOrName)
    const name = newName.trim().slice(0, 80)
    if (!d || !name) return false
    d.name = name
    this.save()
    return true
  }

  setGrant(idOrName: string, grant: Partial<DeviceGrant> & { apps: "*" | string[] }): AccessDeviceInfo | undefined {
    const d = this.find(idOrName)
    if (!d) return undefined
    d.grant = normalizeGrant(grant)
    this.save()
    return this.info(d)
  }

  /** An app was uninstalled: no device keeps it in its grant; one left with nothing is revoked. */
  dropApp(appId: string): number {
    let n = 0
    for (const d of this.devices) {
      if (d.revokedAt || d.grant.apps === "*" || !d.grant.apps.includes(appId)) continue
      d.grant = { ...d.grant, apps: d.grant.apps.filter(a => a !== appId) }
      if (d.grant.apps.length === 0) d.revokedAt = new Date(this.now()).toISOString()
      n++
    }
    for (const [k, o] of this.offers) {
      if (o.grant.apps !== "*" && o.grant.apps.includes(appId)) {
        o.grant = { ...o.grant, apps: o.grant.apps.filter(a => a !== appId) }
        if (o.grant.apps.length === 0) this.offers.delete(k)
      }
    }
    if (n > 0) this.save()
    return n
  }
}

export function normalizeGrant(g: Partial<DeviceGrant> & { apps: "*" | string[] }): DeviceGrant {
  const apps = g.apps === "*" ? "*" : [...new Set(g.apps.map(a => a.trim()).filter(Boolean))]
  return { apps, sessionsRead: g.sessionsRead === true }
}

/** Does `grant` allow `appId`? */
export function grantAllowsApp(grant: DeviceGrant, appId: string): boolean {
  return grant.apps === "*" || grant.apps.includes(appId)
}

// ── request helpers ────────────────────────────────────────────────────────

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie
  if (typeof raw !== "string") return undefined
  for (const part of raw.split(";")) {
    const i = part.indexOf("=")
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

/**
 * A device token in `Authorization: Bearer dvt_…` or the device cookie. No HTTP
 * route issues the cookie: the native shell sets it itself in its web view from
 * the token it holds in the system's secure storage, so the page never sees it.
 */
export function extractDeviceToken(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization
  const m = typeof h === "string" ? /^Bearer\s+(dvt_[A-Za-z0-9_-]+)$/.exec(h.trim()) : null
  if (m?.[1]) return m[1]
  const c = cookieValue(req, DEVICE_COOKIE)
  return c && c.startsWith(DEVICE_TOKEN_PREFIX) ? c : undefined
}

/** The one link format: an https page that opens the app (or explains how), the code in the fragment. */
export function buildPairingLinks(input: { baseUrl: string; code: string }): { link: string; fallbackLink: string } {
  const origin = new URL(input.baseUrl).origin
  const code = encodeURIComponent(formatOfferCode(input.code))
  return {
    link: `${origin}/pair#o=${code}`,
    fallbackLink: `agentapp://pair?h=${encodeURIComponent(origin)}&o=${code}`,
  }
}

// ── process-wide store ─────────────────────────────────────────────────────

let shared: DeviceAccessStore | undefined

/** The daemon's device access store (one per process; the tools and the HTTP routes share it). */
export function getDeviceAccessStore(): DeviceAccessStore {
  return (shared ??= new DeviceAccessStore())
}

/** Test seam: swap (or reset) the process-wide store. */
export function setDeviceAccessStoreForTests(store: DeviceAccessStore | undefined): void {
  shared = store
}
