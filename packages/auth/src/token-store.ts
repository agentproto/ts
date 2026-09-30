/**
 * Keychain helpers — read/write a token in the platform key store.
 *
 * Platform switch:
 * - macOS → the `security` CLI.
 * - Windows → a DPAPI-protected file per slot (`win-token-store.ts`, .NET
 *   `ProtectedData` at `CurrentUser` scope via PowerShell; per-user
 *   encryption, no PowerShell `Get-StoredCredential` module needed).
 * - Anything else (Linux) → still unsupported; libsecret would be the
 *   equivalent to bring next.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import {
  deleteDpapiToken,
  readDpapiToken,
  writeDpapiToken,
} from "./win-token-store.js"

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
      `@agentproto/auth token-store: the Keychain backend only supports macOS and Windows ` +
        `(got platform "${process.platform}"). Provide a libsecret (Linux) implementation ` +
        `to run here.`,
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

/** Read a token from the platform key store. Returns undefined if not found. */
export async function readKeychainToken(
  service: string,
  account: string,
): Promise<string | undefined> {
  if (process.platform === "win32") return readDpapiToken(service, account)
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

/** Write a token to the platform key store (upsert). */
export async function writeKeychainToken(
  service: string,
  account: string,
  token: string,
): Promise<void> {
  if (process.platform === "win32") return writeDpapiToken(service, account, token)
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

/** Remove a token from the platform key store. Returns true if an entry was deleted,
 *  false when none existed (a delete of an absent entry is not an error —
 *  the desired end state, "no credential at this slot", already holds). */
export async function deleteKeychainToken(
  service: string,
  account: string,
): Promise<boolean> {
  if (process.platform === "win32") return deleteDpapiToken(service, account)
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
