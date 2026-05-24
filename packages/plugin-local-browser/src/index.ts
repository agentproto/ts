/**
 * @agentproto/plugin-local-browser — programmatic API.
 *
 * Hosts that want to drive the setup flow themselves (a GUI, an
 * automated installer) can call `setup()` directly with explicit
 * options. The CLI (`agentproto-browser`) wraps this with an
 * interactive prompt.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import {
  listChromeProfiles,
  chromeUserDataDir,
  type ChromeProfile,
} from "./chrome-profiles.js"
import { cloneChromeProfile, type CloneResult } from "./clone.js"
import {
  registerLocalBrowser,
  unregisterLocalBrowser,
  type RegisterResult,
} from "./register.js"

export {
  listChromeProfiles,
  chromeUserDataDir,
  chromeLocalStatePath,
} from "./chrome-profiles.js"
export type { ChromeProfile } from "./chrome-profiles.js"
export { cloneChromeProfile } from "./clone.js"
export type { CloneOptions, CloneResult } from "./clone.js"
export {
  registerLocalBrowser,
  unregisterLocalBrowser,
  IMPORTED_MCPS_PATH,
} from "./register.js"
export type { RegisterOptions, RegisterResult } from "./register.js"

export const DEFAULT_AUTOMATION_USER_DATA_DIR = (
  home: string = homedir()
): string => join(home, ".agentproto", "chrome-profile")

export interface SetupOptions {
  /** Chrome profile directory to clone (`Default`, `Profile 1`, …).
   *  Must match a real profile reported by `listChromeProfiles()`. */
  profileDirectory: string
  /** Destination user-data-dir for the clone. Default:
   *  `~/.agentproto/chrome-profile`. */
  destUserDataDir?: string
  /** Skip the clone step (useful when re-running setup just to
   *  refresh the imported-mcps entry, e.g. after a chrome-devtools-mcp
   *  upgrade). Default false. */
  skipClone?: boolean
  /** chrome-devtools-mcp version to pin (`latest` by default). */
  chromeMcpVersion?: string
  /** Extra Chrome flags appended to the spawned MCP server's args. */
  extraChromeArgs?: string[]
  /** Progress hook fired for each file copied during clone. */
  onCloneProgress?: (relPath: string) => void
}

export interface SetupResult {
  profile: ChromeProfile
  userDataDir: string
  clone: CloneResult | null
  register: RegisterResult
}

/**
 * Run the full plugin setup: clone the chosen Chrome profile to the
 * automation user-data-dir, then register a chrome-devtools-mcp
 * import in `~/.agentproto/imported-mcps.json`. Restart the daemon
 * for it to take effect.
 *
 * Throws when the requested profile doesn't exist — callers should
 * surface the error message verbatim; it lists the available
 * directories.
 */
export async function setup(opts: SetupOptions): Promise<SetupResult> {
  const profiles = await listChromeProfiles()
  const profile = profiles.find(p => p.directory === opts.profileDirectory)
  if (!profile) {
    const known = profiles.map(p => p.directory).join(", ") || "(none)"
    throw new Error(
      `setup: Chrome profile '${opts.profileDirectory}' not found. ` +
        `Available: ${known}`
    )
  }

  const destUserDataDir =
    opts.destUserDataDir ?? DEFAULT_AUTOMATION_USER_DATA_DIR()

  let clone: CloneResult | null = null
  if (!opts.skipClone) {
    clone = await cloneChromeProfile({
      sourceProfileDirectory: profile.directory,
      destUserDataDir,
      ...(opts.onCloneProgress ? { onProgress: opts.onCloneProgress } : {}),
    })
  }

  const register = await registerLocalBrowser({
    userDataDir: destUserDataDir,
    profileDirectory: profile.directory,
    ...(opts.chromeMcpVersion
      ? { chromeMcpVersion: opts.chromeMcpVersion }
      : {}),
    ...(opts.extraChromeArgs ? { extraChromeArgs: opts.extraChromeArgs } : {}),
  })

  return { profile, userDataDir: destUserDataDir, clone, register }
}

export async function teardown(): Promise<{ removed: number }> {
  return unregisterLocalBrowser()
}
