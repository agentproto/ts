/**
 * Read the logged-in browser on THIS machine, on demand and in memory. Nothing
 * is persisted: the browser is the source of truth. Cookie DB access is a
 * read-only copy to a temp dir; only cookie NAMES and expiry are read for the
 * auth signal, values are decrypted only by {@link decryptChromeCookies}, and
 * never logged.
 *
 * Backend: macOS Chrome/Chromium (Keychain "Chrome Safe Storage", PBKDF2-SHA1,
 * AES-128-CBC, `v10` prefix, a 32-byte SHA-256(domain) prefix stripped on newer
 * Chrome). Pass `safeStoragePassword` and `chromeRoot` for anything else.
 */

import { execFileSync } from "node:child_process"
import { createDecipheriv, pbkdf2Sync } from "node:crypto"
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { homedir, platform as osPlatform, tmpdir } from "node:os"
import path from "node:path"
import { defaultAuthSignalRegistry, type AuthCookieMeta, type AuthSignalRegistry } from "./auth-signals.js"
import { domainMatches, type SessionCookie } from "./cookie.js"
import { knownOr, type Known } from "./known.js"
import { readLocalState } from "./local-state.js"

export interface LocalBrowserSessionOptions {
  /** Root of the Chrome/Chromium user-data dir. Default: the macOS Chrome path. */
  chromeRoot?: string
  /** Safe-Storage password (e.g. for Chromium's own Keychain service). Default reads the macOS Keychain. */
  safeStoragePassword?: () => string
  /** Per-domain cookie aliases. Default: derived from the auth signal registry's aliases. */
  domainAliases?: Record<string, string[]>
  /** Extra domains for the host-presence scan beyond the registry's known domains. */
  extraDomains?: readonly string[]
  /** Per-site "signed in" detectors. Default: {@link defaultAuthSignalRegistry}. */
  authSignals?: AuthSignalRegistry
}

// A full cookie jar (hex-dumped) blows past execFileSync's 1 MB default (ENOBUFS).
const SQLITE_MAX_BUFFER = 256 * 1024 * 1024

/** Chrome stores `expires_utc` as microseconds since 1601-01-01. */
const CHROME_EPOCH_TO_UNIX_S = 11644473600

/** Profiles live as sibling dirs (`Default`, `Profile 1`, ...) each with a `Cookies` DB. */
export function profileDirs(chromeRoot: string): string[] {
  if (!existsSync(chromeRoot)) return []
  return readdirSync(chromeRoot, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => name === "Default" || /^Profile \d+$/.test(name))
    .filter(name => existsSync(path.join(chromeRoot, name, "Cookies")))
}

function defaultChromeRoot(): string {
  if (osPlatform() !== "darwin") {
    throw new Error("local browser sessions currently support macOS only; pass { chromeRoot } for other platforms.")
  }
  return path.join(homedir(), "Library", "Application Support", "Google", "Chrome")
}

/** The Chrome user-data root the scanner reads. Reading it is fine; launching Chrome against it is refused by the kit (F11). */
export function chromeUserDataRoot(opts: LocalBrowserSessionOptions = {}): string {
  return opts.chromeRoot ?? defaultChromeRoot()
}

function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1")
}

/** Read the Chrome Safe Storage key from the macOS Keychain. Touches the Keychain: call only on an explicit user action. */
export function readSafeStorageKey(): Buffer {
  const pw = execFileSync("security", ["find-generic-password", "-wa", "Chrome", "-s", "Chrome Safe Storage"])
    .toString()
    .trim()
  return deriveKey(pw)
}

/** Decrypt one hex-dumped Chrome `encrypted_value`. Exported for the synthetic-data tests. */
export function decryptChromeValue(hex: string, key: Buffer): string {
  const buf = Buffer.from(hex, "hex")
  if (buf.subarray(0, 3).toString() !== "v10") return buf.toString("utf8")
  const ct = buf.subarray(3)
  const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "))
  d.setAutoPadding(true)
  let pt = Buffer.concat([d.update(ct), d.final()])
  if (pt.length >= 32) {
    const headPrintable = [...pt.subarray(0, 32)].every(b => b >= 0x20 && b < 0x7f)
    const tail = pt.subarray(32).toString("utf8")
    if (!headPrintable && /^[\x20-\x7e]*$/.test(tail)) pt = pt.subarray(32)
  }
  return pt.toString("utf8")
}

/** Derive the AES key from a Safe-Storage password (Chrome's constants). */
export function safeStorageKey(password: string): Buffer {
  return deriveKey(password)
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Run `fn` against a temp copy of the profile's (often locked) Cookies DB. */
function withCookiesCopy<T>(profileDir: string, prefix: string, fn: (db: string) => T): T {
  const tmpDir = mkdtempSync(path.join(tmpdir(), prefix))
  try {
    const db = path.join(tmpDir, "Cookies")
    copyFileSync(path.join(profileDir, "Cookies"), db)
    return fn(db)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

const sqlite = (db: string, args: readonly string[]): string =>
  execFileSync("sqlite3", [db, ...args], { maxBuffer: SQLITE_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] }).toString().trim()

/** Total cookie count (no decryption). A failed read is `{ unknown }`, never 0. */
export function countCookies(profileDir: string): Known<number> {
  try {
    return { known: withCookiesCopy(profileDir, "bp-ct-", db => Number(sqlite(db, ["SELECT count(*) FROM cookies;"]))) }
  } catch (e) {
    return { unknown: errText(e) }
  }
}

/** Cookie counts per requested domain (host and subdomains), no decryption. A failed read is `{ unknown }`, never zeros. */
export function countCookiesByDomain(profileDir: string, domains: readonly string[]): Known<Record<string, number>> {
  try {
    const hosts = withCookiesCopy(profileDir, "bp-cd-", db =>
      sqlite(db, ["SELECT host_key FROM cookies;"])
        .split("\n")
        .filter(Boolean)
        .map(h => h.replace(/^\./, "").toLowerCase()),
    )
    const counts: Record<string, number> = Object.fromEntries(domains.map(d => [d, 0]))
    for (const host of hosts) {
      for (const d of domains) if (host === d || host.endsWith(`.${d}`)) counts[d] = (counts[d] ?? 0) + 1
    }
    return { known: counts }
  } catch (e) {
    return { unknown: errText(e) }
  }
}

/** Distinct cookie hosts (no decryption) mapped onto the registry's known domains plus `extraDomains`. */
export function profileLoggedInDomains(
  profileDir: string,
  registry: AuthSignalRegistry = defaultAuthSignalRegistry,
  extraDomains: readonly string[] = [],
): Known<string[]> {
  try {
    const hosts = withCookiesCopy(profileDir, "bp-host-", db =>
      sqlite(db, ["SELECT DISTINCT host_key FROM cookies;"])
        .split("\n")
        .map(h => h.replace(/^\./, "").toLowerCase()),
    )
    const of = [...new Set([...registry.knownDomains(), ...extraDomains])]
    const found = new Set<string>()
    for (const host of hosts) {
      for (const domain of of) if (registry.hostBelongsTo(host, domain)) found.add(domain)
    }
    return { known: [...found].sort() }
  } catch (e) {
    return { unknown: errText(e) }
  }
}

/**
 * Known domains the profile holds a valid, non-expired AUTH signal for. Reads
 * cookie NAME and expiry only (no value decryption), then asks the registry's
 * detector. A failed read is `{ unknown }`.
 */
export function profileAuthedDomains(
  profileDir: string,
  registry: AuthSignalRegistry = defaultAuthSignalRegistry,
  nowMs: number = Date.now(),
): Known<string[]> {
  try {
    const rows = withCookiesCopy(profileDir, "bp-auth-", db =>
      sqlite(db, ["SELECT host_key, name, expires_utc FROM cookies;"]).split("\n"),
    )
    const metas: AuthCookieMeta[] = []
    for (const row of rows) {
      const [hostRaw, name, expiresRaw] = row.split("|")
      if (!hostRaw || !name) continue
      const exp = Number(expiresRaw)
      metas.push({
        name,
        host: hostRaw.replace(/^\./, "").toLowerCase(),
        expiresUnix: !Number.isFinite(exp) || exp === 0 ? undefined : exp / 1_000_000 - CHROME_EPOCH_TO_UNIX_S,
      })
    }
    const found = registry.knownDomains().filter(d => registry.isAuthed(d, metas, nowMs))
    return { known: found.sort() }
  } catch (e) {
    return { unknown: errText(e) }
  }
}

/** A logged-in identity behind a Chrome profile: the unit a person reasons about, not the dir name. */
export interface ChromeIdentity {
  /** On-disk dir: the addressable key passed back as `label`/`profile`. */
  profile: string
  name: string | null
  email: string | null
  gaiaName: string | null
  lastUsed: boolean
  /** Display only; a failed read collapses to 0 here (see `domainsAuthed` for the honest value). */
  cookieCount: number
  /** Weak host-presence signal: any cookie on the domain counts. */
  domainsLoggedIn: string[]
  /** Strong signal: a valid, non-expired auth cookie, by name and expiry. `Known` so a failed read is never "authed nowhere". */
  domainsAuthed: Known<string[]>
}

/** Enumerate the machine's Chrome profiles as named identities. Pure read: Local State JSON plus a host-key scan. */
export function scanChromeIdentities(opts: LocalBrowserSessionOptions = {}): ChromeIdentity[] {
  const chromeRoot = opts.chromeRoot ?? defaultChromeRoot()
  const registry = opts.authSignals ?? defaultAuthSignalRegistry
  const { profiles, lastUsed } = readLocalState(chromeRoot)
  const info = new Map(profiles.map(p => [p.directory, p]))
  return profileDirs(chromeRoot).map(profile => {
    const dir = path.join(chromeRoot, profile)
    const meta = info.get(profile)
    return {
      profile,
      name: meta?.name ?? null,
      email: meta?.userName ?? null,
      gaiaName: meta?.gaiaName ?? null,
      lastUsed: profile === lastUsed,
      cookieCount: knownOr(countCookies(dir), 0),
      domainsLoggedIn: knownOr(profileLoggedInDomains(dir, registry, opts.extraDomains), []),
      domainsAuthed: profileAuthedDomains(dir, registry),
    }
  })
}

/** Decrypt cookies for `domains` from a single Chrome profile, in memory (the DB copy is removed). */
export function decryptChromeCookies(profileDir: string, domains: readonly string[], key: Buffer): SessionCookie[] {
  return withCookiesCopy(profileDir, "bp-ck-", db => {
    const rows = sqlite(db, [
      "-separator",
      "\t",
      "SELECT name, host_key, path, hex(encrypted_value), is_secure, is_httponly, expires_utc FROM cookies;",
    ])
      .split("\n")
      .filter(Boolean)
    const jar: SessionCookie[] = []
    for (const line of rows) {
      const [name, host, cpath, hex, secure, httpOnly, expires] = line.split("\t")
      if (!host || !domainMatches(host, domains)) continue
      let value: string
      try {
        value = decryptChromeValue(hex ?? "", key)
      } catch {
        continue
      }
      if (!value) continue
      const exp = Number(expires)
      const expiresUnix = exp > 0 ? Math.floor(exp / 1_000_000 - CHROME_EPOCH_TO_UNIX_S) : undefined
      jar.push({
        name: name ?? "",
        value,
        domain: host,
        path: cpath || "/",
        secure: secure === "1",
        httpOnly: httpOnly === "1",
        ...(expiresUnix && expiresUnix > 0 ? { expires: expiresUnix } : {}),
      })
    }
    return jar
  })
}

export interface LocalBrowserSession {
  /** Decrypted cookies for `domain` (and its aliases) from `profile`, or the first profile that has one. `null` when none. */
  getDecryptedForDomain(domain: string, profile?: string): Promise<{ cookies: SessionCookie[]; capturedAt: string } | null>
  /** One summary per Chrome profile (no decryption). */
  listProfiles(): Array<{ profile: string; cookieCount: Known<number> }>
}

/** A local, no-persistence provider reading this machine's browser. */
export function createLocalBrowserSession(opts: LocalBrowserSessionOptions = {}): LocalBrowserSession {
  const chromeRoot = opts.chromeRoot ?? defaultChromeRoot()
  const registry = opts.authSignals ?? defaultAuthSignalRegistry
  const getKey = opts.safeStoragePassword ? () => deriveKey(opts.safeStoragePassword!()) : readSafeStorageKey
  const domainsFor = (domain: string): string[] => {
    const d = domain.replace(/^\./, "").toLowerCase()
    const aliases = opts.domainAliases ? (opts.domainAliases[d] ?? []) : registry.equivalentDomains(d)
    return [d, ...aliases]
  }
  return {
    async getDecryptedForDomain(domain, profile) {
      const domains = domainsFor(domain)
      const key = getKey()
      const profiles = profile ? [profile] : profileDirs(chromeRoot)
      for (const p of profiles) {
        const dir = path.join(chromeRoot, p)
        if (!existsSync(path.join(dir, "Cookies"))) continue
        const cookies = decryptChromeCookies(dir, domains, key)
        if (cookies.length > 0) return { cookies, capturedAt: new Date().toISOString() }
      }
      return null
    },
    listProfiles() {
      return profileDirs(chromeRoot).map(profile => ({ profile, cookieCount: countCookies(path.join(chromeRoot, profile)) }))
    },
  }
}
