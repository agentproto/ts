/**
 * Keychain helpers — read/write a token in the platform Keychain.
 *
 * Uses the macOS `security` CLI. On non-macOS hosts, callers should swap this
 * module for a platform-appropriate equivalent (libsecret on Linux, Credential
 * Manager on Windows).
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

/**
 * Guard the macOS-only backend. Without this, `readKeychainToken` would swallow
 * the missing-`security` error and return undefined on Linux/Windows — making a
 * stored credential look absent and re-prompting on every run — while
 * `writeKeychainToken` would throw an opaque ENOENT. Fail loudly and clearly
 * instead, until a libsecret / Credential Manager backend exists.
 */
function assertKeychainSupported(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      `@agentproto/auth token-store: the Keychain backend only supports macOS ` +
        `(got platform "${process.platform}"). Provide a libsecret (Linux) or ` +
        `Credential Manager (Windows) implementation to run here.`,
    )
  }
}

/** Substitute `{server}` template in a tokenStore account spec. */
export function resolveAccount(
  account: string | undefined,
  server: string,
): string {
  if (!account) return server
  return account.replace("{server}", server)
}

/** Read a token from the Keychain. Returns undefined if not found. */
export async function readKeychainToken(
  service: string,
  account: string,
): Promise<string | undefined> {
  assertKeychainSupported()
  try {
    const { stdout } = await exec("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ])
    const t = stdout.replace(/\n$/, "")
    return t || undefined
  } catch {
    return undefined
  }
}

/** Write a token to the Keychain (-U updates in place). */
export async function writeKeychainToken(
  service: string,
  account: string,
  token: string,
): Promise<void> {
  assertKeychainSupported()
  await exec("security", [
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    account,
    "-w",
    token,
    "-D",
    "agentproto auth token",
  ])
}

/** Remove a token from the Keychain. Returns true if an entry was deleted,
 *  false when none existed (a delete of an absent entry is not an error —
 *  the desired end state, "no credential at this slot", already holds). */
export async function deleteKeychainToken(
  service: string,
  account: string,
): Promise<boolean> {
  assertKeychainSupported()
  try {
    await exec("security", [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      account,
    ])
    return true
  } catch {
    // `security` exits non-zero when the item isn't found — treat as a no-op.
    return false
  }
}
