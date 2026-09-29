/** Injected seams of the consent host: the human prompt and the Chrome profile reader. */

import path from "node:path"
import { ChromeIdentityError } from "../errors.js"
import type { SessionCookie } from "../cookie.js"
import type { Known } from "../known.js"
import {
  countCookies,
  countCookiesByDomain,
  decryptChromeCookies,
  profileDirs,
  readSafeStorageKey,
  safeStorageKey,
} from "../local-session.js"

/** What the human is being asked. Counts only: a prompt never carries a cookie value. */
export type ConsentQuestion =
  | { kind: "domain"; domain: string; profile: string; presentCount: number | undefined; deviceId?: string }
  | { kind: "full-profile"; profile: string; warning: string; deviceId?: string }
  | { kind: "sink"; providerId: string; sessionId: string }

/** The interactive consent port. A CLI wires it to a terminal, a desktop app to a dialog, a test to a fake. */
export interface ConsentPrompt {
  confirm(question: ConsentQuestion): Promise<boolean>
}

/** Reads a Chrome profile. Every method that decrypts values is only called after consent. */
export interface ChromeProfilePort {
  /** Presence scan (C5): counts per domain, no values, no Keychain. */
  countByDomain(profile: string, domains: readonly string[]): Known<Record<string, number>>
  /** Whole-profile cookie count, no values. */
  countAll(profile: string): Known<number>
  /** Decrypt the cookies of `domains`. Touches the Keychain: only for an explicit, consented import. */
  readCookies(profile: string, domains: readonly string[]): SessionCookie[]
}

export interface LocalChromePortOptions {
  /** Chrome user-data root. Required: this package never guesses the real one here. */
  chromeRoot: string
  /** Safe-Storage password source. Default reads the macOS Keychain at import time. */
  safeStoragePassword?: () => string
}

/** The default reader over a Chrome user-data dir. The profile must be a real `Default` or `Profile N` dir. */
export function localChromePort(opts: LocalChromePortOptions): ChromeProfilePort {
  const dirFor = (profile: string): string => {
    if (!profileDirs(opts.chromeRoot).includes(profile)) {
      throw new ChromeIdentityError(`Chrome profile "${profile}" not found under the given user-data dir`)
    }
    return path.join(opts.chromeRoot, profile)
  }
  return {
    countByDomain: (profile, domains) => countCookiesByDomain(dirFor(profile), domains),
    countAll: profile => countCookies(dirFor(profile)),
    readCookies(profile, domains) {
      const key = opts.safeStoragePassword ? safeStorageKey(opts.safeStoragePassword()) : readSafeStorageKey()
      return decryptChromeCookies(dirFor(profile), domains, key)
    },
  }
}
