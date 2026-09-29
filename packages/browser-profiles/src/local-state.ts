/**
 * Chrome `Local State` parsing: the one implementation, shared by the Chrome
 * profile scanner here and by `@agentproto/plugin-local-browser`.
 *
 * macOS: ~/Library/Application Support/Google/Chrome/Local State
 * Linux: ~/.config/google-chrome/Local State
 * Win:   %LOCALAPPDATA%\Google\Chrome\User Data\Local State
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"

/** Resolves the platform-specific Chrome user-data-dir root. */
export function chromeUserDataDir(home: string = homedir()): string {
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Google", "Chrome")
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Google", "Chrome", "User Data")
    default:
      return join(home, ".config", "google-chrome")
  }
}

export function chromeLocalStatePath(home: string = homedir()): string {
  return join(chromeUserDataDir(home), "Local State")
}

/** One `profile.info_cache` entry, reduced to the fields callers use. */
export interface LocalStateProfile {
  /** Directory name under the user-data-dir (`Default`, `Profile 1`). */
  directory: string
  /** Friendly profile name. */
  name: string | undefined
  /** Signed-in Google account email (`user_name`). */
  userName: string | undefined
  /** Google display name. */
  gaiaName: string | undefined
  /** Raw Chrome activity stamp (`active_time`, else `last_active_time`), unconverted. */
  activeTime: unknown
}

export interface ParsedLocalState {
  profiles: LocalStateProfile[]
  /** `profile.last_used`, or `null` when absent. */
  lastUsed: string | null
}

interface RawProfileInfo {
  name?: unknown
  user_name?: unknown
  gaia_name?: unknown
  active_time?: unknown
  last_active_time?: unknown
}

interface RawLocalState {
  profile?: {
    info_cache?: Record<string, RawProfileInfo>
    last_used?: unknown
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

/** Parse Local State JSON text. Throws on malformed JSON. */
export function parseLocalState(text: string): ParsedLocalState {
  const parsed = JSON.parse(text) as RawLocalState
  const cache = parsed.profile?.info_cache ?? {}
  return {
    profiles: Object.entries(cache).map(([directory, info]) => ({
      directory,
      name: str(info.name),
      userName: str(info.user_name),
      gaiaName: str(info.gaia_name),
      activeTime: info.active_time ?? info.last_active_time,
    })),
    lastUsed: str(parsed.profile?.last_used) ?? null,
  }
}

/** Lenient read of `<chromeRoot>/Local State`: a missing or unreadable file is an empty result. */
export function readLocalState(chromeRoot: string): ParsedLocalState {
  const file = join(chromeRoot, "Local State")
  if (!existsSync(file)) return { profiles: [], lastUsed: null }
  try {
    return parseLocalState(readFileSync(file, "utf8"))
  } catch {
    return { profiles: [], lastUsed: null }
  }
}

/**
 * Chrome stores timestamps as microseconds since the Windows epoch (1601-01-01
 * UTC). Convert to ISO-8601, or return "" when the field is missing or out of
 * plausible range (so callers can't surface 1601 in a UI).
 */
export function chromeTimeToIso(raw: unknown): string {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return ""
  // > 1e16: microseconds since 1601 (modern Chrome); > 1e12: unix ms; > 1e9: unix seconds (legacy).
  let unixMs: number
  if (raw > 1e16) {
    unixMs = Math.floor(raw / 1000) - 11_644_473_600_000
  } else if (raw > 1e12) {
    unixMs = raw
  } else if (raw > 1e9) {
    unixMs = raw * 1000
  } else {
    return ""
  }
  if (unixMs <= 0 || unixMs > Date.now() + 86_400_000) return ""
  return new Date(unixMs).toISOString()
}
