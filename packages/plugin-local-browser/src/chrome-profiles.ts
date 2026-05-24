/**
 * Enumerate Chrome user profiles from the OS-specific Local State
 * file. Chrome stores per-profile metadata (display name, signed-in
 * email, last-active timestamp) in `Local State`'s
 * `profile.info_cache` map, keyed by the profile directory name
 * (`Default`, `Profile 1`, …).
 *
 * macOS: ~/Library/Application Support/Google/Chrome/Local State
 * Linux: ~/.config/google-chrome/Local State
 * Win:   %LOCALAPPDATA%\Google\Chrome\User Data\Local State
 *
 * We only surface enough to drive a picker — display name, email,
 * directory, last-active. The full info_cache record carries 30+
 * fields most callers will never touch.
 */

import { readFile } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { join } from "node:path"

export interface ChromeProfile {
  /** Directory name under the Chrome user-data-dir (`Default`,
   *  `Profile 1`, …). What you pass to `--profile-directory`. */
  directory: string
  /** Human label set in Chrome's profile-edit dialog. */
  name: string
  /** Signed-in account email, when the profile is signed into a
   *  Google account. Empty for guest / signed-out profiles. */
  email: string
  /** Last activation timestamp as ISO-8601, when Chrome recorded
   *  one. Empty when the field is missing or unparseable. */
  lastActive: string
  /** True when this directory matches Chrome's `last_used` field —
   *  i.e. the profile Chrome would open next if launched plain. */
  isLastUsed: boolean
}

/** Resolves the platform-specific Chrome user-data-dir root. */
export function chromeUserDataDir(home: string = homedir()): string {
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Google", "Chrome")
    case "win32":
      // %LOCALAPPDATA% defaults to <home>\AppData\Local
      return join(
        process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
        "Google",
        "Chrome",
        "User Data"
      )
    default:
      return join(home, ".config", "google-chrome")
  }
}

export function chromeLocalStatePath(home: string = homedir()): string {
  return join(chromeUserDataDir(home), "Local State")
}

interface RawProfileInfo {
  name?: unknown
  user_name?: unknown
  active_time?: unknown
  last_active_time?: unknown
}

interface RawLocalState {
  profile?: {
    info_cache?: Record<string, RawProfileInfo>
    last_used?: unknown
  }
}

/**
 * Read + parse Chrome's Local State. Returns the profile list sorted
 * by last-active descending (most-recently-used first), with the
 * `last_used` profile guaranteed to be on top regardless of stamp.
 *
 * Throws when Local State is missing or malformed — callers should
 * handle that as "Chrome not installed, or never launched."
 */
export async function listChromeProfiles(
  home: string = homedir()
): Promise<ChromeProfile[]> {
  const path = chromeLocalStatePath(home)
  const raw = await readFile(path, "utf8")
  const parsed = JSON.parse(raw) as RawLocalState
  const cache = parsed.profile?.info_cache ?? {}
  const lastUsed =
    typeof parsed.profile?.last_used === "string" ? parsed.profile.last_used : ""

  const profiles: ChromeProfile[] = Object.entries(cache).map(
    ([directory, info]) => ({
      directory,
      name: typeof info.name === "string" ? info.name : directory,
      email: typeof info.user_name === "string" ? info.user_name : "",
      lastActive: chromeTimeToIso(info.active_time ?? info.last_active_time),
      isLastUsed: directory === lastUsed,
    })
  )

  profiles.sort((a, b) => {
    if (a.isLastUsed !== b.isLastUsed) return a.isLastUsed ? -1 : 1
    return b.lastActive.localeCompare(a.lastActive)
  })

  return profiles
}

/**
 * Chrome stores timestamps as microseconds since the Windows epoch
 * (1601-01-01 UTC). Convert to ISO-8601, or return "" when the field
 * is missing or out of plausible range (so callers can't accidentally
 * surface 1601 in a UI).
 */
function chromeTimeToIso(raw: unknown): string {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return ""
  // Heuristic: > 1e16 → microseconds since 1601 epoch (modern Chrome);
  // > 1e9 → unix seconds (legacy); else unparseable.
  let unixMs: number
  if (raw > 1e16) {
    // microseconds since 1601-01-01 → ms since unix epoch
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
