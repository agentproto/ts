/**
 * The profile clone is a full-profile grant (AIP-63 C3): it copies every cookie
 * of a Chrome profile to a second directory. This module is the explicit,
 * recorded path to it. Nothing here reads cookie values.
 */

import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  chromeUserDataDir,
  createConsentHost,
  createConsentLedger,
  fileGrantStore,
  fileSessionStore,
  localChromePort,
  type ChromeProfilePort,
  type ConsentHost,
  type ConsentPrompt,
  type FullProfileProof,
} from "@agentproto/browser-profiles"

/** Grants made through this plugin belong to this session id. */
export const LOCAL_BROWSER_SESSION_ID = "local-browser"

export interface LocalConsentOptions {
  /** Base for `~/.agentproto/bureau/*` state. Default: the user's home. */
  home?: string
  /** Chrome user-data root the profile is counted from. Default: the OS Chrome dir. */
  chromeRoot?: string
  /** Reader override, for tests. */
  chrome?: ChromeProfilePort
  /** A human at a terminal. Absent means non-interactive. */
  prompt?: ConsentPrompt
  /** The clone dir deleted when the grant is revoked. */
  cloneDir?: string
}

/** A consent host over the default `~/.agentproto/bureau` ledger, grants and jars. */
export function createLocalBrowserConsent(opts: LocalConsentOptions = {}): ConsentHost {
  const base = join(opts.home ?? homedir(), ".agentproto", "bureau")
  const cloneDir = opts.cloneDir ?? join(opts.home ?? homedir(), ".agentproto", "chrome-profile")
  return createConsentHost({
    grants: fileGrantStore(join(base, "grants.json")),
    ledger: createConsentLedger({ path: join(base, "consent.jsonl") }),
    store: fileSessionStore(join(base, "sessions")),
    jarDir: join(base, "jars"),
    chrome: opts.chrome ?? localChromePort({ chromeRoot: opts.chromeRoot ?? chromeUserDataDir() }),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    deleteExtraDerived: async grant => {
      if (grant.sessionId !== LOCAL_BROWSER_SESSION_ID || grant.fullProfile !== true) return false
      await rm(cloneDir, { recursive: true, force: true })
      return true
    },
  })
}

export interface FullProfileConsent {
  proof: FullProfileProof
  grantId: string
  /** The loud warning to show the human. */
  warning: string
}

/**
 * Record a full-profile grant for `profile` and return the proof `setup()`
 * needs to clone it. Non-interactive callers must pass `yes` (C4); an agent
 * cannot reach this path.
 */
export async function grantFullProfileClone(input: {
  host: ConsentHost
  profile: string
  yes?: boolean
  deviceId?: string
}): Promise<FullProfileConsent> {
  const res = await input.host.grantFullProfile({
    sessionId: LOCAL_BROWSER_SESSION_ID,
    profile: input.profile,
    ...(input.yes !== undefined ? { yes: input.yes } : {}),
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
  })
  return {
    proof: input.host.fullProfileProof({ grantId: res.grant.id }),
    grantId: res.grant.id,
    warning: res.warning,
  }
}
