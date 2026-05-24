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
  installChromeMcp,
  DEFAULT_CHROME_MCP_PREFIX,
  type InstallResult,
} from "./install.js"
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
  installChromeMcp,
  DEFAULT_CHROME_MCP_PREFIX,
} from "./install.js"
export type { InstallOptions, InstallResult } from "./install.js"
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
  /** Skip the chrome-devtools-mcp install step. Only safe when a
   *  prior setup already populated `chromeMcpPrefix`. */
  skipInstall?: boolean
  /** Install dir for chrome-devtools-mcp. Default
   *  `~/.agentproto/chrome-mcp`. */
  chromeMcpPrefix?: string
  /** chrome-devtools-mcp version to pin (`latest` by default). */
  chromeMcpVersion?: string
  /** Extra Chrome flags appended to the spawned MCP server's args. */
  extraChromeArgs?: string[]
  /** Progress hook fired for each file copied during clone. */
  onCloneProgress?: (relPath: string) => void
  /** Progress hook fired for each npm-install output line. */
  onInstallProgress?: (line: string) => void
}

export interface SetupResult {
  profile: ChromeProfile
  userDataDir: string
  clone: CloneResult | null
  install: InstallResult
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

  // Install (or refresh) chrome-devtools-mcp into a plugin-owned dir.
  // Subsequent setups are idempotent — npm short-circuits when the
  // pinned version is already on disk.
  let install: InstallResult
  if (opts.skipInstall) {
    const prefix = opts.chromeMcpPrefix ?? DEFAULT_CHROME_MCP_PREFIX()
    install = {
      prefix,
      binPath: join(prefix, "node_modules", ".bin", "chrome-devtools-mcp"),
      installedVersion: "(skipped)",
    }
  } else {
    install = await installChromeMcp({
      ...(opts.chromeMcpPrefix ? { prefix: opts.chromeMcpPrefix } : {}),
      ...(opts.chromeMcpVersion ? { version: opts.chromeMcpVersion } : {}),
      ...(opts.onInstallProgress ? { onProgress: opts.onInstallProgress } : {}),
    })
  }

  const register = await registerLocalBrowser({
    userDataDir: destUserDataDir,
    profileDirectory: profile.directory,
    chromeMcpBin: install.binPath,
    ...(opts.extraChromeArgs ? { extraChromeArgs: opts.extraChromeArgs } : {}),
  })

  return { profile, userDataDir: destUserDataDir, clone, install, register }
}

export async function teardown(): Promise<{ removed: number }> {
  return unregisterLocalBrowser()
}
