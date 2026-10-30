/**
 * PERSISTED CALLER-IDENTITY TOTALS (ts#2165 step 5).
 *
 * `http-server.ts` counts, per process, how callers identify themselves and
 * serves those counts at `GET /identity`. Without persistence every daemon
 * restart zeroes the totals and moves `since` to the boot time, so an
 * operator waiting for a clean seven-day reading can never complete the
 * window across a deploy. This module owns the pure arithmetic and the file
 * format of the totals: the server keeps its live per-process counters and
 * reports `base + live`, where `base` is what it loaded at start.
 *
 * The file (`identity-observations.json`, under the same home as
 * `session-credentials.ts`) is written atomically and best-effort: a failed
 * write only warns and never breaks the daemon. The reader is tolerant of a
 * corrupt or partial file (a bad counter reads as 0) but rejects a file that
 * is not version 1 or has no `since`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

/** How a caller identified itself on one request. */
export type IdentityKind = "verified" | "mismatch" | "invalid_token" | "claim_only" | "anonymous"
export type IdentityCounters = Record<IdentityKind, number>
/** What a `claim_only` request names. */
export type ClaimOnlyClass = "external" | "delivered" | "undelivered" | "unknown"

export const IDENTITY_KINDS: readonly IdentityKind[] = ["verified", "mismatch", "invalid_token", "claim_only", "anonymous"]
export const CLAIM_ONLY_CLASSES: readonly ClaimOnlyClass[] = ["external", "delivered", "undelivered", "unknown"]

export interface IdentityTotals {
  counters: IdentityCounters
  refused: IdentityCounters
  byRoute: Record<string, IdentityCounters>
  claimOnlyByClass: Record<ClaimOnlyClass, number>
}

export interface IdentityBoot {
  /** ISO time of the boot. */
  at: string
  /** Build sha of the daemon that booted, when it is known. */
  build?: string
}

export interface IdentityObservationsFile {
  version: 1
  /** ISO time of the first boot ever recorded in this file. */
  since: string
  totals: IdentityTotals
  boots: IdentityBoot[]
}

export const IDENTITY_OBSERVATIONS_FILE = "identity-observations.json"
export const IDENTITY_BOOTS_MAX = 50
/** Distinct `byRoute` keys kept when reading a file (a sanity bound). */
export const IDENTITY_ROUTES_MAX = 64

/** Default persist location, `<AGENTPROTO_HOME|~/.agentproto>/identity-observations.json`,
 *  the same home-dir resolution as `sessionCredentialsFile()`. */
export function identityObservationsFile(): string {
  return resolve(process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto"), IDENTITY_OBSERVATIONS_FILE)
}

export function emptyIdentityCounters(): IdentityCounters {
  return { verified: 0, mismatch: 0, invalid_token: 0, claim_only: 0, anonymous: 0 }
}

export function emptyClaimOnlyClasses(): Record<ClaimOnlyClass, number> {
  return { external: 0, delivered: 0, undelivered: 0, unknown: 0 }
}

export function emptyIdentityTotals(): IdentityTotals {
  return {
    counters: emptyIdentityCounters(),
    refused: emptyIdentityCounters(),
    byRoute: {},
    claimOnlyByClass: emptyClaimOnlyClasses(),
  }
}

/** Sum two totals. Pure: neither argument is changed. */
export function addIdentityTotals(a: IdentityTotals, b: IdentityTotals): IdentityTotals {
  const counters = emptyIdentityCounters()
  const refused = emptyIdentityCounters()
  for (const kind of IDENTITY_KINDS) {
    counters[kind] = a.counters[kind] + b.counters[kind]
    refused[kind] = a.refused[kind] + b.refused[kind]
  }
  const byRoute: Record<string, IdentityCounters> = {}
  for (const route of new Set([...Object.keys(a.byRoute), ...Object.keys(b.byRoute)])) {
    const left = a.byRoute[route] ?? emptyIdentityCounters()
    const right = b.byRoute[route] ?? emptyIdentityCounters()
    const merged = emptyIdentityCounters()
    for (const kind of IDENTITY_KINDS) merged[kind] = left[kind] + right[kind]
    byRoute[route] = merged
  }
  const claimOnlyByClass = emptyClaimOnlyClasses()
  for (const klass of CLAIM_ONLY_CLASSES) {
    claimOnlyByClass[klass] = a.claimOnlyByClass[klass] + b.claimOnlyByClass[klass]
  }
  return { counters, refused, byRoute, claimOnlyByClass }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A counter is a finite number >= 0; anything else reads as 0. */
function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function readCounters(value: unknown): IdentityCounters {
  const counters = emptyIdentityCounters()
  if (!isRecord(value)) return counters
  for (const kind of IDENTITY_KINDS) counters[kind] = readCount(value[kind])
  return counters
}

function readClaimOnlyClasses(value: unknown): Record<ClaimOnlyClass, number> {
  const classes = emptyClaimOnlyClasses()
  if (!isRecord(value)) return classes
  for (const klass of CLAIM_ONLY_CLASSES) classes[klass] = readCount(value[klass])
  return classes
}

/** Read the file. undefined when it is missing, unreadable, not JSON, or not version 1. */
export function loadIdentityObservations(path: string): IdentityObservationsFile | undefined {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.version !== 1) return undefined
  if (typeof parsed.since !== "string" || parsed.since.length === 0) return undefined
  const totalsRaw = isRecord(parsed.totals) ? parsed.totals : {}
  const byRoute: Record<string, IdentityCounters> = {}
  const byRouteRaw = isRecord(totalsRaw.byRoute) ? totalsRaw.byRoute : {}
  for (const route of Object.keys(byRouteRaw)) {
    if (Object.keys(byRoute).length >= IDENTITY_ROUTES_MAX) break
    byRoute[route] = readCounters(byRouteRaw[route])
  }
  const boots: IdentityBoot[] = []
  if (Array.isArray(parsed.boots)) {
    for (const boot of parsed.boots) {
      if (!isRecord(boot) || typeof boot.at !== "string") continue
      boots.push(typeof boot.build === "string" ? { at: boot.at, build: boot.build } : { at: boot.at })
    }
  }
  return {
    version: 1,
    since: parsed.since,
    totals: {
      counters: readCounters(totalsRaw.counters),
      refused: readCounters(totalsRaw.refused),
      byRoute,
      claimOnlyByClass: readClaimOnlyClasses(totalsRaw.claimOnlyByClass),
    },
    boots: boots.slice(-IDENTITY_BOOTS_MAX),
  }
}

/** Write the file atomically (temp file in the same directory, then rename).
 *  Best-effort: a failure logs one `console.warn` naming the path only and
 *  never throws. */
export function saveIdentityObservations(path: string, file: IdentityObservationsFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    console.warn(
      `[identity-observations] could not persist the caller identity totals to ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
