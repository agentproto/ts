/**
 * The consent host: the one place a grant is created, refreshed or revoked.
 * Human consent paths live here; agents get the narrower surface in `agent.ts`.
 * No cookie value ever reaches the ledger, a thrown error or a returned result:
 * values exist only in the per-grant jar file (derived material) and in the
 * arrays handed to a provider's cookie source.
 */

import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { browserCookieSchema, type BrowserCookie } from "@agentproto/driver-browser"
import { z } from "zod"
import type { SessionCookie } from "../cookie.js"
import { isFileInject, type SessionDescriptor } from "../descriptor.js"
import type { SessionStorePort } from "../store.js"
import { validateGrantDomains, hostCoveredBy, type GrantDomainPolicy } from "./domains.js"
import {
  AgentGrantRefusedError,
  ConsentDeclinedError,
  ConsentRequiredError,
  FullProfileGrantError,
  NonInteractiveConsentError,
  SinkAckRequiredError,
} from "./errors.js"
import {
  grantServesDevice,
  isGrantActive,
  type Grant,
  type GrantSink,
  type GrantStore,
} from "./grants.js"
import { cookieNameHash, type ConsentLedger, type LedgerActor } from "./ledger.js"
import type { ChromeProfilePort, ConsentPrompt } from "./ports.js"

/** Returned with every full-profile grant. Shown to the human verbatim. */
export const FULL_PROFILE_WARNING =
  "WARNING: full-profile grant. Every cookie in this Chrome profile becomes usable by this device, " +
  "for every site, not just the ones you know. It stays on this machine (local sink only). " +
  "Prefer naming domains with --domains. Revoke it any time; the grant and the revoke are in the consent ledger."

export type SinkRequest = { kind: "local" } | { kind: "remote"; providerId: string; acknowledged?: boolean }

export interface ImportRequest {
  sessionId: string
  /** Chrome profile dir (`Default`, `Profile 1`). */
  profile: string
  /** Explicit registrable domains. There is no "all". */
  domains?: readonly string[]
  /** `--yes`: the human confirmed the named domains without a prompt. */
  yes?: boolean
  deviceId?: string
  sinks?: readonly SinkRequest[]
  expiresAt?: string
  /** Defaults to a human. An `agent` here is refused and recorded as a deny row. */
  actor?: LedgerActor
}

export interface FullProfileRequest {
  sessionId: string
  profile: string
  yes?: boolean
  deviceId?: string
  expiresAt?: string
  actor?: LedgerActor
}

export interface GrantResult {
  grant: Grant
  /** Cookie counts per domain from the presence scan; `undefined` when the scan failed. */
  presence: Record<string, number> | undefined
  warnings: string[]
}

export interface FullProfileResult {
  grant: Grant
  /** The loud warning to show the human. */
  warning: string
  warnings: string[]
}

export interface RevokeResult {
  grant: Grant
  derived: { local: "deleted" | "none"; remote: "confirmed" | "unavailable" | "failed" | "not-applicable" }
}

export interface ConsentHostOptions {
  grants: GrantStore
  ledger: ConsentLedger
  /** L5a store holding the session descriptor this host derives. */
  store: SessionStorePort
  /** Directory of per-grant cookie jars (0700). Derived material: deleted on revoke. */
  jarDir: string
  chrome: ChromeProfilePort
  /** Present: a human can be asked. Absent: non-interactive, so `--domains` and `--yes` are mandatory (C4). */
  prompt?: ConsentPrompt
  domainPolicy?: GrantDomainPolicy
  /** C13: a device-scoped grant is honored only while its device is still paired. */
  isDevicePaired?: (deviceId: string) => boolean
  /** Asks a remote sink to delete what it received. Absent: `remote` is recorded as `unavailable`. */
  revokeRemote?: (grant: Grant) => Promise<"confirmed" | "failed" | "unavailable">
  /** Removes material this host does not own, such as a full-profile clone. True when something was deleted. */
  deleteExtraDerived?: (grant: Grant) => Promise<boolean>
  now?: () => Date
  newId?: () => string
}

export interface FullProfileSelector {
  grantId?: string
  sessionId?: string
  profile?: string
  deviceId?: string
}

export interface FullProfileProof {
  readonly grantId: string
  isActive(): boolean
}

export interface ConsentHost {
  importFromChrome(req: ImportRequest): Promise<GrantResult>
  grantFullProfile(req: FullProfileRequest): Promise<FullProfileResult>
  /** Re-read the grant's own domains from its own profile. Never widens. Allowed for an agent (C7). */
  refresh(grantId: string, opts?: { actor?: LedgerActor }): Promise<{ grant: Grant; cookieCount: number }>
  revoke(grantId: string, opts?: { actor?: LedgerActor }): Promise<RevokeResult>
  /** Proof for the kit's `fullProfile` unlock. Throws {@link FullProfileGrantError} when no active full-profile grant matches. */
  fullProfileProof(selector: FullProfileSelector): FullProfileProof
  /** A provider cookie source that serves only this device's active, granted domains. */
  cookieSourceFor(scope?: { deviceId?: string }): (request: { providerId: string; profile: string }) => readonly BrowserCookie[]
  /** Throws `browser:consent_required` unless an active grant of this session covers `host` for this device. */
  assertCovered(input: { sessionId: string; host: string; deviceId?: string }): Grant
  /** Record a refused agent attempt and throw {@link AgentGrantRefusedError}. */
  refuseAgent(attempt: string, ctx: { actor: LedgerActor; grantId?: string; sessionId?: string; domains?: readonly string[] }): never
  getGrant(id: string): Grant | undefined
  listGrants(): Grant[]
}

const jarSchema = z.object({ version: z.literal(1), cookies: z.array(browserCookieSchema) })

const SAME_SITE: Record<string, BrowserCookie["sameSite"]> = { strict: "Strict", lax: "Lax", none: "None" }

function toBrowserCookie(c: SessionCookie): BrowserCookie {
  const sameSite = c.sameSite ? SAME_SITE[c.sameSite.toLowerCase()] : undefined
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path ?? "/",
    ...(c.expires !== undefined && c.expires > 0 ? { expires: c.expires } : {}),
    ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
    ...(c.secure !== undefined ? { secure: c.secure } : {}),
    ...(sameSite ? { sameSite } : {}),
  }
}

const isPosix = process.platform !== "win32"
const HUMAN: LedgerActor = { kind: "human" }

export function createConsentHost(opts: ConsentHostOptions): ConsentHost {
  const { grants, ledger, store, chrome } = opts
  const now = opts.now ?? ((): Date => new Date())
  const newId = opts.newId ?? ((): string => `grant_${randomUUID()}`)
  const jarPath = (grantId: string): string => path.join(opts.jarDir, `${grantId.replace(/[^\w.-]/g, "_")}.json`)

  const devicePaired = (g: Grant): boolean =>
    g.deviceId === undefined || opts.isDevicePaired === undefined || opts.isDevicePaired(g.deviceId)
  const usable = (g: Grant, deviceId: string | undefined): boolean =>
    isGrantActive(g, now()) && devicePaired(g) && grantServesDevice(g, deviceId)

  const writeJar = (grantId: string, cookies: readonly BrowserCookie[]): void => {
    mkdirSync(opts.jarDir, { recursive: true, mode: 0o700 })
    const file = jarPath(grantId)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, cookies }), { mode: 0o600 })
    renameSync(tmp, file)
    if (isPosix && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600)
  }

  const readJar = (grantId: string): BrowserCookie[] => {
    const file = jarPath(grantId)
    if (!existsSync(file)) return []
    const parsed = jarSchema.safeParse(JSON.parse(readFileSync(file, "utf8")))
    return parsed.success ? parsed.data.cookies : []
  }

  const nameHashes = (grantId: string, cookies: readonly BrowserCookie[]): string[] =>
    [...new Set(cookies.map(c => c.name))].map(n => cookieNameHash(grantId, n))

  /** Recompute the session descriptor from the session's active domain grants, or drop it when none remain. */
  const syncDescriptor = async (sessionId: string): Promise<void> => {
    const active = grants
      .list()
      .filter(g => g.sessionId === sessionId && g.domains !== undefined && isGrantActive(g, now()) && existsSync(jarPath(g.id)))
      .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt))
    const prev = await store.load(sessionId)
    const latest = active[active.length - 1]
    if (!latest || !latest.domains) {
      if (prev?.inject && isFileInject(prev.inject) && path.dirname(prev.inject.path) === opts.jarDir) await store.remove(sessionId)
      return
    }
    const desc: SessionDescriptor = {
      ...(prev ?? { id: sessionId, backend: "camofox" as const }),
      identity: { ...(prev?.identity ?? {}), profile: latest.source.profile },
      inject: { from: "file", domains: latest.domains, path: jarPath(latest.id) },
      savedAt: now().toISOString(),
    }
    await store.save(desc)
  }

  const refuseAgent: ConsentHost["refuseAgent"] = (attempt, ctx) => {
    const named = ctx.domains && ctx.domains.length > 0 ? ` (${ctx.domains.join(", ")})` : ""
    ledger.append({
      event: "deny",
      actor: ctx.actor,
      ...(ctx.grantId ? { grantId: ctx.grantId } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      reason: `agent attempted to ${attempt}${named}`.slice(0, 500),
    })
    throw new AgentGrantRefusedError(attempt)
  }

  const guardHuman = (actor: LedgerActor | undefined, attempt: string, ctx: { sessionId: string; domains?: readonly string[] }): LedgerActor => {
    const a = actor ?? HUMAN
    if (a.kind === "agent") refuseAgent(attempt, { actor: a, sessionId: ctx.sessionId, ...(ctx.domains ? { domains: ctx.domains } : {}) })
    return a
  }

  return {
    async importFromChrome(req) {
      const actor = guardHuman(req.actor, "grant access to a Chrome profile", { sessionId: req.sessionId, ...(req.domains ? { domains: req.domains } : {}) })
      const named = req.domains ?? []
      if (!opts.prompt) {
        const missing: string[] = []
        if (named.length === 0) missing.push("--domains")
        if (req.yes !== true) missing.push("--yes")
        if (missing.length > 0) throw new NonInteractiveConsentError(missing)
      }
      const domains = validateGrantDomains(named, opts.domainPolicy)
      const scan = chrome.countByDomain(req.profile, domains)
      const presence = "known" in scan ? scan.known : undefined

      if (req.yes !== true && opts.prompt) {
        for (const domain of domains) {
          const ok = await opts.prompt.confirm({
            kind: "domain",
            domain,
            profile: req.profile,
            presentCount: presence?.[domain],
            ...(req.deviceId ? { deviceId: req.deviceId } : {}),
          })
          if (!ok) throw new ConsentDeclinedError(`domain ${domain}`)
        }
      }

      const remoteSinks: Array<{ providerId: string }> = []
      const sinks: GrantSink[] = []
      for (const s of req.sinks ?? [{ kind: "local" as const }]) {
        if (s.kind === "local") {
          if (!sinks.some(x => x.kind === "local")) sinks.push({ kind: "local" })
          continue
        }
        let acked = s.acknowledged === true
        if (!acked && opts.prompt) acked = await opts.prompt.confirm({ kind: "sink", providerId: s.providerId, sessionId: req.sessionId })
        if (!acked) throw new SinkAckRequiredError(s.providerId)
        remoteSinks.push({ providerId: s.providerId })
      }
      if (sinks.length === 0 && remoteSinks.length === 0) sinks.push({ kind: "local" })

      const cookies = chrome.readCookies(req.profile, domains).map(toBrowserCookie)
      const id = newId()
      const via = req.yes === true ? "flag" : "interactive"
      const grantActor: LedgerActor = { ...actor, via, ...(req.deviceId ? { deviceId: req.deviceId } : {}) }

      ledger.append({
        event: "grant",
        actor: grantActor,
        grantId: id,
        sessionId: req.sessionId,
        domains,
        cookieCount: cookies.length,
        nameHashes: nameHashes(id, cookies),
      })
      writeJar(id, cookies)
      for (const r of remoteSinks) {
        const row = ledger.append({ event: "sink-ack", actor: grantActor, grantId: id, sessionId: req.sessionId, sinkId: r.providerId })
        sinks.push({ kind: "remote", providerId: r.providerId, ackSeq: row.seq })
      }
      const grant: Grant = {
        id,
        sessionId: req.sessionId,
        ...(req.deviceId ? { deviceId: req.deviceId } : {}),
        source: { kind: "chrome", profile: req.profile },
        domains,
        sinks,
        grantedAt: now().toISOString(),
        grantedVia: via,
        ...(req.expiresAt ? { expiresAt: req.expiresAt } : {}),
        cookieCount: cookies.length,
      }
      grants.put(grant)
      await syncDescriptor(req.sessionId)
      const warnings = presence
        ? domains.filter(d => (presence[d] ?? 0) === 0).map(d => `no cookies found for ${d} in profile ${req.profile}`)
        : ["presence scan failed; the import may hold fewer cookies than expected"]
      return { grant, presence, warnings }
    },

    async grantFullProfile(req) {
      const actor = guardHuman(req.actor, "grant a full Chrome profile", { sessionId: req.sessionId })
      if (!opts.prompt && req.yes !== true) throw new NonInteractiveConsentError(["--full-profile", "--yes"])
      if (req.yes !== true && opts.prompt) {
        const ok = await opts.prompt.confirm({
          kind: "full-profile",
          profile: req.profile,
          warning: FULL_PROFILE_WARNING,
          ...(req.deviceId ? { deviceId: req.deviceId } : {}),
        })
        if (!ok) throw new ConsentDeclinedError(`full profile ${req.profile}`)
      }
      const count = chrome.countAll(req.profile)
      const cookieCount = "known" in count ? count.known : 0
      const id = newId()
      const via = req.yes === true ? "flag" : "interactive"
      ledger.append({
        event: "grant",
        actor: { ...actor, via, ...(req.deviceId ? { deviceId: req.deviceId } : {}) },
        grantId: id,
        sessionId: req.sessionId,
        fullProfile: true,
        cookieCount,
      })
      const grant: Grant = {
        id,
        sessionId: req.sessionId,
        ...(req.deviceId ? { deviceId: req.deviceId } : {}),
        source: { kind: "chrome", profile: req.profile },
        fullProfile: true,
        sinks: [{ kind: "local" }],
        grantedAt: now().toISOString(),
        grantedVia: via,
        ...(req.expiresAt ? { expiresAt: req.expiresAt } : {}),
        cookieCount,
      }
      grants.put(grant)
      const warnings = "known" in count ? [] : ["cookie count unavailable; recorded as 0"]
      return { grant, warning: FULL_PROFILE_WARNING, warnings }
    },

    async refresh(grantId, o = {}) {
      const actor = o.actor ?? HUMAN
      const grant = grants.get(grantId)
      if (!grant || !usable(grant, actor.deviceId) || !grant.domains) throw new ConsentRequiredError()
      const cookies = chrome.readCookies(grant.source.profile, grant.domains).map(toBrowserCookie)
      ledger.append({
        event: "refresh",
        actor,
        grantId,
        sessionId: grant.sessionId,
        domains: grant.domains,
        cookieCount: cookies.length,
        nameHashes: nameHashes(grantId, cookies),
      })
      writeJar(grantId, cookies)
      const next: Grant = { ...grant, cookieCount: cookies.length }
      grants.put(next)
      await syncDescriptor(grant.sessionId)
      return { grant: next, cookieCount: cookies.length }
    },

    async revoke(grantId, o = {}) {
      const actor = o.actor ?? HUMAN
      const grant = grants.get(grantId)
      if (!grant) throw new ConsentRequiredError(`no grant "${grantId}"`)
      if (grant.revokedAt !== undefined) return { grant, derived: { local: "none", remote: "not-applicable" } }
      const hadJar = existsSync(jarPath(grantId))
      rmSync(jarPath(grantId), { force: true })
      const extra = opts.deleteExtraDerived ? await opts.deleteExtraDerived(grant) : false
      const hasRemote = grant.sinks.some(s => s.kind === "remote")
      const remote: RevokeResult["derived"]["remote"] = !hasRemote
        ? "not-applicable"
        : opts.revokeRemote
          ? await opts.revokeRemote(grant)
          : "unavailable"
      const derived: RevokeResult["derived"] = { local: hadJar || extra ? "deleted" : "none", remote }
      const revoked: Grant = { ...grant, revokedAt: now().toISOString() }
      grants.put(revoked)
      await syncDescriptor(grant.sessionId)
      ledger.append({ event: "revoke", actor, grantId, sessionId: grant.sessionId, derived })
      return { grant: revoked, derived }
    },

    fullProfileProof(sel) {
      const match = (g: Grant): boolean =>
        g.fullProfile === true &&
        (sel.grantId === undefined || g.id === sel.grantId) &&
        (sel.sessionId === undefined || g.sessionId === sel.sessionId) &&
        (sel.profile === undefined || g.source.profile === sel.profile) &&
        usable(g, sel.deviceId)
      const found = grants.list().find(match)
      if (!found) {
        throw new FullProfileGrantError(
          "no active full-profile grant covers this request. --full-profile needs an explicit, recorded grant (run the full-profile consent first).",
        )
      }
      return {
        grantId: found.id,
        isActive: () => {
          const g = grants.get(found.id)
          return g !== undefined && g.fullProfile === true && usable(g, sel.deviceId)
        },
      }
    },

    cookieSourceFor(scope = {}) {
      return ({ providerId, profile }) => {
        const out: BrowserCookie[] = []
        for (const g of grants.list()) {
          if (g.sessionId !== profile || !g.domains || !usable(g, scope.deviceId)) continue
          const servesProvider = g.sinks.some(s => s.kind === "local" || s.providerId === providerId)
          if (!servesProvider) continue
          const allowed = g.domains
          out.push(...readJar(g.id).filter(c => allowed.some(d => hostCoveredBy(c.domain, d))))
        }
        return out
      }
    },

    assertCovered({ sessionId, host, deviceId }) {
      const hit = grants
        .list()
        .find(g => g.sessionId === sessionId && g.domains?.some(d => hostCoveredBy(host, d)) === true && usable(g, deviceId))
      if (!hit) throw new ConsentRequiredError(`no active grant covers ${host} for this device`)
      return hit
    },

    refuseAgent,
    getGrant: id => grants.get(id),
    listGrants: () => grants.list(),
  }
}
