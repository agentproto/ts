/**
 * Account health: a persistent circuit breaker per REAL auth profile.
 *
 * The daemon used to have no memory of "this account is empty until such a
 * date": every spawn retried an account known to be spent, and `model-cooldowns.ts`
 * (per model, in memory, 10 to 60 min) says nothing about a wallet. This module
 * records, in `~/.agentproto/account-health.json`, which profiles are
 * `exhausted` and until when. Keys are real `profileRef`s, never `slot:` refs.
 *
 * States, derived at read time from the file and the clock:
 *   - `ok`         no entry;
 *   - `exhausted`  an entry whose `until` is still in the future: the account
 *                  is closed, nothing should be started on it;
 *   - `probing`    an entry whose `until` has passed: the account is eligible
 *                  again and the next real use is the trial. No manual
 *                  unblock is ever needed after a renewal.
 *
 * `until` comes, in decreasing order of trust, from a quota reader's
 * `resetsAt` (`untilBasis` `provider`, or `probe` for an undocumented
 * surface), from the provider's own message (`observed`: "resets in 1d 9h",
 * "resets 12pm (Europe/Paris)", "try again at ...", Retry-After), or from a
 * backoff on `strikes` (`estimated`: 30 min, 2 h, 6 h, then 24 h at most).
 * `untilBasis` reuses the AIP-67 `basis` vocabulary, since it answers the same
 * question: where this figure came from. A successful turn on the account
 * clears the entry; a new failure of the same kind while it is `probing` adds
 * a strike and a fresh `until`.
 *
 * Same persistence style as `remaining-quota-store.ts`: versioned file, mode
 * 0600, atomic replace, a read that never throws. `dir` is injectable so tests
 * round-trip against a temp directory.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"

export const ACCOUNT_UNTIL_BASES = ["provider", "probe", "observed", "estimated"] as const
export type AccountUntilBasis = (typeof ACCOUNT_UNTIL_BASES)[number]

/** Backoff by strike count when nothing better says when the account returns. */
export const ACCOUNT_BACKOFF_MS = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000] as const

/** A provider-claimed reset further away than this is clamped (one bad message
 *  must not park an account for a year). */
export const MAX_ACCOUNT_UNTIL_MS = 45 * 24 * 3_600_000

const entrySchema = z.object({
  state: z.literal("exhausted"),
  until: z.string(),
  untilBasis: z.enum(ACCOUNT_UNTIL_BASES),
  reason: z.string(),
  since: z.string(),
  strikes: z.number().int().positive(),
})

const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), entrySchema),
})

export type AccountHealthEntry = z.infer<typeof entrySchema>
export type AccountHealthFile = z.infer<typeof fileSchema>

/** What a caller sees for one account that is not `ok`. */
export interface AccountHealthView {
  profileRef: string
  state: "exhausted" | "probing"
  until: string
  untilBasis: AccountUntilBasis
  reason: string
  since: string
  strikes: number
  /** Milliseconds until `until` (0 once probing). */
  remainingMs: number
}

export interface AccountHealthOptions {
  /** Overrides `~/.agentproto` (tests inject a temp dir). */
  dir?: string
  /** Clock, injectable for tests. */
  now?: () => number
}

function healthDir(opts?: AccountHealthOptions): string {
  return opts?.dir ?? resolve(homedir(), ".agentproto")
}

export function accountHealthPath(opts?: AccountHealthOptions): string {
  return join(healthDir(opts), "account-health.json")
}

const nowOf = (opts?: AccountHealthOptions): number => (opts?.now ?? Date.now)()

function emptyFile(): AccountHealthFile {
  return { version: 1, accounts: {} }
}

/** Read the whole file. A missing, corrupt or version-mismatched file reads as
 *  empty: a half-written health file must never stop a spawn. Never throws. */
export async function loadAccountHealth(opts?: AccountHealthOptions): Promise<AccountHealthFile> {
  try {
    return fileSchema.parse(JSON.parse(await readFile(accountHealthPath(opts), "utf8")))
  } catch {
    return emptyFile()
  }
}

function project(profileRef: string, e: AccountHealthEntry, now: number): AccountHealthView {
  const until = Date.parse(e.until)
  const remainingMs = Number.isFinite(until) ? Math.max(0, until - now) : 0
  return {
    profileRef,
    state: remainingMs > 0 ? "exhausted" : "probing",
    until: e.until,
    untilBasis: e.untilBasis,
    reason: e.reason,
    since: e.since,
    strikes: e.strikes,
    remainingMs,
  }
}

/** Health of one account: `undefined` means `ok` (no entry). A `probing`
 *  account is returned too, so a caller can show it, but it is eligible. */
export async function accountHealthOf(
  profileRef: string,
  opts?: AccountHealthOptions,
): Promise<AccountHealthView | undefined> {
  const file = await loadAccountHealth(opts)
  const entry = file.accounts[profileRef]
  return entry ? project(profileRef, entry, nowOf(opts)) : undefined
}

/** True when the account is closed right now (`exhausted`, `until` in the
 *  future). `ok` and `probing` accounts are eligible. */
export function isAccountClosed(view: AccountHealthView | undefined): view is AccountHealthView {
  return view !== undefined && view.state === "exhausted"
}

/** Every account with an entry, soonest `until` first. */
export async function listAccountHealth(opts?: AccountHealthOptions): Promise<AccountHealthView[]> {
  const file = await loadAccountHealth(opts)
  const now = nowOf(opts)
  return Object.entries(file.accounts)
    .map(([profileRef, e]) => project(profileRef, e, now))
    .sort((a, b) => Date.parse(a.until) - Date.parse(b.until))
}

/** The closed accounts only, for `daemon_health`. */
export async function exhaustedAccounts(opts?: AccountHealthOptions): Promise<AccountHealthView[]> {
  return (await listAccountHealth(opts)).filter(v => v.state === "exhausted")
}

// Writes are read-modify-write on one small file: serialise them per path so
// two sessions failing together cannot lose each other's entry.
const writeChains = new Map<string, Promise<unknown>>()

async function mutate<T>(
  opts: AccountHealthOptions | undefined,
  fn: (file: AccountHealthFile) => { next: AccountHealthFile | undefined; result: T },
): Promise<T> {
  const path = accountHealthPath(opts)
  const run = async (): Promise<T> => {
    const file = await loadAccountHealth(opts)
    const { next, result } = fn(file)
    if (next) {
      await mkdir(healthDir(opts), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
      await rename(tmp, path)
    }
    return result
  }
  const prev = writeChains.get(path) ?? Promise.resolve()
  const job = prev.then(run, run)
  writeChains.set(path, job.catch(() => undefined))
  return job
}

export interface MarkExhaustedInput {
  /** Short human reason, e.g. the provider's message (echoed, trimmed). */
  reason: string
  /** Epoch ms the account returns, when known. */
  until?: number
  /** Where `until` came from. Required with `until`; ignored without. */
  untilBasis?: Exclude<AccountUntilBasis, "estimated">
}

/** Backoff duration for the n-th strike (1-based), capped at 24 h. */
export function backoffMsForStrikes(strikes: number): number {
  return ACCOUNT_BACKOFF_MS[Math.min(Math.max(strikes, 1), ACCOUNT_BACKOFF_MS.length) - 1]!
}

/**
 * Close an account. A first failure, or one that follows a `probing` entry
 * (the trial failed), takes a strike; a failure reported while the account is
 * already closed (another session failing on the same wallet) keeps the
 * strike count and only ever extends `until`. Never throws on a bad `until`:
 * a missing or unusable one falls back to the strike backoff.
 */
export async function markAccountExhausted(
  profileRef: string,
  input: MarkExhaustedInput,
  opts?: AccountHealthOptions,
): Promise<AccountHealthView> {
  const now = nowOf(opts)
  const reason = input.reason.length > 300 ? `${input.reason.slice(0, 300)}…` : input.reason
  return mutate(opts, file => {
    const prev = file.accounts[profileRef]
    const prevUntil = prev ? Date.parse(prev.until) : NaN
    const stillClosed = prev !== undefined && Number.isFinite(prevUntil) && prevUntil > now
    const strikes = prev === undefined ? 1 : stillClosed ? prev.strikes : prev.strikes + 1
    let until: number
    let untilBasis: AccountUntilBasis
    if (input.until !== undefined && Number.isFinite(input.until) && input.until > now) {
      until = Math.min(input.until, now + MAX_ACCOUNT_UNTIL_MS)
      untilBasis = input.untilBasis ?? "observed"
    } else {
      until = now + backoffMsForStrikes(strikes)
      untilBasis = "estimated"
    }
    if (stillClosed && prevUntil > until) {
      until = prevUntil
      untilBasis = prev!.untilBasis
    }
    const entry: AccountHealthEntry = {
      state: "exhausted",
      until: new Date(until).toISOString(),
      untilBasis,
      reason,
      since: stillClosed ? prev!.since : new Date(now).toISOString(),
      strikes,
    }
    return {
      next: { version: 1, accounts: { ...file.accounts, [profileRef]: entry } },
      result: project(profileRef, entry, now),
    }
  })
}

/** Forget an account's entry (a recharge, or a successful turn). Returns
 *  whether there was one. Writes nothing when there was none. */
export async function clearAccountHealth(profileRef: string, opts?: AccountHealthOptions): Promise<boolean> {
  return mutate(opts, file => {
    if (!(profileRef in file.accounts)) return { next: undefined, result: false }
    const { [profileRef]: _gone, ...rest } = file.accounts
    return { next: { version: 1, accounts: rest }, result: true }
  })
}

// ── reading "when does it come back" out of a provider message ────────────

const DURATION_PART_RE = /(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b/gi

function unitMs(unit: string): number {
  const u = unit.toLowerCase()
  if (u.startsWith("d")) return 86_400_000
  if (u.startsWith("h")) return 3_600_000
  if (u.startsWith("m")) return 60_000
  return 1_000
}

/** "1d 9h", "11h 30m", "2 hours 5 minutes" -> ms. Undefined when no part. */
function parseDurationMs(text: string): number | undefined {
  let total = 0
  let found = false
  for (const m of text.matchAll(DURATION_PART_RE)) {
    total += Number(m[1]) * unitMs(m[2]!)
    found = true
  }
  return found && total > 0 ? Math.round(total) : undefined
}

function tzOffsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at))
  const n = (type: string): number => Number(parts.find(p => p.type === type)?.value)
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"))
  return asUtc - Math.floor(at / 1000) * 1000
}

/** Wall-clock `y-m-d h:min` in `timeZone` (or the process zone) -> epoch ms. */
function zonedToEpoch(y: number, mo: number, d: number, h: number, min: number, timeZone: string | undefined): number {
  const guess = Date.UTC(y, mo, d, h, min)
  if (!timeZone) return new Date(y, mo, d, h, min).getTime()
  let epoch = guess - tzOffsetMs(timeZone, guess)
  epoch = guess - tzOffsetMs(timeZone, epoch)
  return epoch
}

function wallClockNow(now: number, timeZone: string | undefined): { y: number; mo: number; d: number } {
  if (!timeZone) {
    const dt = new Date(now)
    return { y: dt.getFullYear(), mo: dt.getMonth(), d: dt.getDate() }
  }
  const shifted = new Date(now + tzOffsetMs(timeZone, now))
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate() }
}

function to24h(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour
  const pm = meridiem.toLowerCase() === "pm"
  return (hour % 12) + (pm ? 12 : 0)
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return zone
  } catch {
    return undefined
  }
}

/**
 * Read the return time of an exhausted account out of the provider's own
 * words. Recognised, all observed or documented forms:
 *   - OpenCode Go: `usage limit reached (weekly, resets in 1d 9h)`,
 *     `(5-hour, resets in 2h 1m)`;
 *   - Claude: `resets 5pm`, `resets 12pm (Europe/Paris)`, `resets Nov 20, 12pm`;
 *   - generic: `retry after 30s`, `Retry-After: 12`, `try again in 2 minutes`,
 *     `try again at 2026-11-20T05:00:00Z`.
 * Returns epoch ms in the future, or undefined (the caller then uses the strike
 * backoff). Never throws, never returns a past time.
 */
export function parseExhaustionUntil(message: string | undefined, now: number): number | undefined {
  if (!message) return undefined
  try {
    const rel = /\bresets?\s+in\s+((?:\d+(?:\.\d+)?\s*[a-z]+\s*)+)/i.exec(message)
    if (rel?.[1]) {
      const ms = parseDurationMs(rel[1])
      if (ms !== undefined) return now + ms
    }
    const retry =
      /\b(?:retry[ -]after|try again in|retry in)\b["':\s]*((?:\d+(?:\.\d+)?\s*[a-z]*\s*)+)/i.exec(message)
    if (retry?.[1]) {
      const bare = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(retry[1])
      const ms = bare ? Math.round(Number(bare[1]) * 1000) : parseDurationMs(retry[1])
      if (ms !== undefined && ms > 0) return now + ms
    }
    const at = /\btry again at\s+([^\n.;]+?)(?:[.;]|\s*$)/i.exec(message)
    if (at?.[1]) {
      const t = Date.parse(at[1].trim())
      if (Number.isFinite(t) && t > now) return t
    }
    const clock =
      /\bresets?\s+(?:at\s+)?(?:(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC|GMT)\))?/i.exec(
        message,
      )
    if (clock && (clock[5] || clock[4] || clock[1])) {
      const hour = to24h(Number(clock[3]), clock[5])
      const min = clock[4] ? Number(clock[4]) : 0
      if (hour > 23 || min > 59) return undefined
      const zone = validZone(clock[6])
      const today = wallClockNow(now, zone)
      if (clock[1]) {
        const mo = MONTHS.indexOf(clock[1].toLowerCase())
        const d = Number(clock[2])
        let t = zonedToEpoch(today.y, mo, d, hour, min, zone)
        if (t <= now) t = zonedToEpoch(today.y + 1, mo, d, hour, min, zone)
        return t
      }
      let t = zonedToEpoch(today.y, today.mo, today.d, hour, min, zone)
      if (t <= now) t = zonedToEpoch(today.y, today.mo, today.d + 1, hour, min, zone)
      return t
    }
  } catch {
    return undefined
  }
  return undefined
}

/** A usage-limit message that names a PER-IP cap rather than a wallet
 *  ("Free usage limit reached" on OpenCode Zen free models): the account is
 *  fine, only the model on this address is cooling down. Never marks an
 *  account exhausted. */
export function isPerAddressCapMessage(message: string | undefined): boolean {
  return message !== undefined && /\bfree usage\b/i.test(message)
}

// ── injectable port ────────────────────────────────────────────────────────

/** The slice of the health store the daemon logic talks to, so a test (or a
 *  future remote store) can swap it. Every method resolves; none throws on a
 *  missing or corrupt file. */
export interface AccountHealthStore {
  get(profileRef: string): Promise<AccountHealthView | undefined>
  list(): Promise<AccountHealthView[]>
  mark(profileRef: string, input: MarkExhaustedInput): Promise<AccountHealthView>
  clear(profileRef: string): Promise<boolean>
}

/** The store over `~/.agentproto/account-health.json` (or `opts.dir`). */
export function createAccountHealthStore(opts?: AccountHealthOptions): AccountHealthStore {
  return {
    get: profileRef => accountHealthOf(profileRef, opts),
    list: () => listAccountHealth(opts),
    mark: (profileRef, input) => markAccountExhausted(profileRef, input, opts),
    clear: profileRef => clearAccountHealth(profileRef, opts),
  }
}

/** One quota window as a reader reports it, reduced to what health needs. */
export interface QuotaWindowFigure {
  /** 0-100. */
  remainingPct: number
  resetsAt?: string
}

/**
 * A quota reader just read `profileRef`. When a window is at 0 % with a
 * `resetsAt`, the account is closed until the latest such reset
 * (`untilBasis` is the reader's own `basis`). When every window with a figure
 * has headroom and the account was closed, the entry is cleared: the reader
 * says it is usable. Best-effort; never throws.
 */
export async function reconcileHealthFromQuota(
  store: AccountHealthStore,
  profileRef: string,
  windows: readonly QuotaWindowFigure[],
  now: number = Date.now(),
  basis: Exclude<AccountUntilBasis, "estimated" | "observed"> = "provider",
): Promise<void> {
  try {
    if (windows.length === 0) return
    const empty = windows.filter(w => w.remainingPct <= 0)
    if (empty.length > 0) {
      const resets = empty
        .map(w => (w.resetsAt ? Date.parse(w.resetsAt) : NaN))
        .filter(t => Number.isFinite(t) && t > now)
      if (resets.length === 0) return
      await store.mark(profileRef, {
        reason: "quota reader: 0% remaining",
        until: Math.max(...resets),
        untilBasis: basis,
      })
      return
    }
    if (await store.get(profileRef)) await store.clear(profileRef)
  } catch {
    // health is advisory: a failed write must never fail a quota read
  }
}
