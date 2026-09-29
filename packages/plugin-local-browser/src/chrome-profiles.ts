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
import { homedir } from "node:os"
import {
  chromeLocalStatePath,
  chromeTimeToIso,
  chromeUserDataDir,
  parseLocalState,
} from "@agentproto/browser-profiles"

// One implementation of the path resolution and Local State parsing: it lives
// in @agentproto/browser-profiles and is re-exported here unchanged.
export { chromeLocalStatePath, chromeUserDataDir }

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
  const raw = await readFile(chromeLocalStatePath(home), "utf8")
  const parsed = parseLocalState(raw)

  const profiles: ChromeProfile[] = parsed.profiles.map(p => ({
    directory: p.directory,
    name: p.name ?? p.directory,
    email: p.userName ?? "",
    lastActive: chromeTimeToIso(p.activeTime),
    isLastUsed: p.directory === parsed.lastUsed,
  }))

  profiles.sort((a, b) => {
    if (a.isLastUsed !== b.isLastUsed) return a.isLastUsed ? -1 : 1
    return b.lastActive.localeCompare(a.lastActive)
  })

  return profiles
}
