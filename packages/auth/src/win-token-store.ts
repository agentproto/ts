/**
 * Windows Credential-Manager-equivalent backend for `token-store.ts`.
 *
 * Windows can't use the macOS `security` CLI, and libsecret is Linux-only,
 * so this backend (recap D7) seals each secret in a DPAPI-protected file:
 * `.NET System.Security.Cryptography.ProtectedData` at `CurrentUser` scope,
 * invoked as a `powershell -NoProfile -NonInteractive -Command` child of the
 * CLI — no npm dependencies, no PowerShell Get-StoredCredential module. One
 * file per `(service, account)` pair under
 * `{home}/.agentproto/keychain-dpapi/`, mirroring the macOS Keychain's
 * "one opaque string per slot" model.
 *
 * Secret hygiene: the plaintext rides as a UTF-8 base64 payload inside the
 * constructed command string (the same exposure the macOS backend already
 * accepts, passing the token as a `security -w` argv), and paths are
 * base64-encoded rather than single-quoted so exotic home-dir characters
 * never enter PowerShell quoting. Tests inject `run` and never invoke the
 * real DPAPI (CI runners have no PowerShell).
 */

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** Injectable runners + home dir — unit tests pass a fake `run`. */
export interface DpapiDeps {
  /** Defaults to `~/`. */
  home?: string
  /** PowerShell invocation; scale/mirror `exec`'s default. */
  run?: (cmd: string, args: string[]) => Promise<{ stdout: string }>
}

/** Storage root: `{home}/.agentproto/keychain-dpapi/`. */
export function dpapiDir(deps?: DpapiDeps): string {
  return join(deps?.home ?? homedir(), ".agentproto", "keychain-dpapi")
}

const FILE_HASH = (service: string, account: string): string =>
  createHash("sha256").update(`${service}\u0000${account}`).digest("hex").slice(0, 24)

/** The `.dpapi` file for one `(service, account)` slot. */
export function dpapiFile(service: string, account: string, deps?: DpapiDeps): string {
  const svc = service.replace(/[^\dA-Za-z._-]/g, "_")
  const acct = account.replace(/[^\dA-Za-z._-]/g, "_")
  return join(dpapiDir(deps), `${svc}__${acct}__${FILE_HASH(service, account)}.dpapi`)
}

/** Default PowerShell runner — thin so tests can intercept it. */
async function runPowerShell(args: string[], deps?: DpapiDeps): Promise<{ stdout: string }> {
  if (deps?.run) return deps.run("powershell", args)
  return exec("powershell", args, { timeout: 15_000 })
}

const B64 = (s: string): string => Buffer.from(s, "utf8").toString("base64")

/** PowerShell decode helper woven into every command string. */
const DECODE = `$d={param($s)[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))};`

/** Command `writeKeychainToken` runs on win32: protect + write-bytes. */
export function buildDpapiWriteCommand(service: string, account: string, token: string, deps?: DpapiDeps): { cmd: string; args: string[] } {
  const file = dpapiFile(service, account, deps)
  const script =
    `${DECODE}` +
    `$ErrorActionPreference='Stop';` +
    `$p=&$d('${B64(file)}');` +
    `$raw=[Convert]::FromBase64String('${B64(token)}');` +
    `Add-Type -AssemblyName System.Security;` +
    `[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p))|Out-Null;` +
    `[IO.File]::WriteAllBytes($p, [Security.Cryptography.ProtectedData]::Protect(` +
    `$raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`
  return { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] }
}

/** Command `readKeychainToken` runs on win32: unprotect + write-stdout. */
export function buildDpapiReadCommand(service: string, account: string, deps?: DpapiDeps): { cmd: string; args: string[] } {
  const file = dpapiFile(service, account, deps)
  const script =
    `${DECODE}` +
    `$ErrorActionPreference='Stop';` +
    `$p=&$d('${B64(file)}');` +
    `Add-Type -AssemblyName System.Security;` +
    `$enc=[IO.File]::ReadAllBytes($p);` +
    `$raw=[Security.Cryptography.ProtectedData]::Unprotect(` +
    `$enc,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `[Console]::Out.Write([Text.Encoding]::UTF8.GetString($raw))`
  return { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] }
}

/** Command `deleteKeychainToken` runs on win32: "1" when a file was removed,
 *  "0" when it wasn't there. */
export function buildDpapiDeleteCommand(service: string, account: string, deps?: DpapiDeps): { cmd: string; args: string[] } {
  const file = dpapiFile(service, account, deps)
  const script =
    `${DECODE}` +
    `$p=&$d('${B64(file)}');` +
    `if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force;'1'}else{'0'}`
  return { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] }
}

/** PowerShell's stderr text from a caught error, for the failure message. */
function errMsg(err: unknown): string {
  const detail =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err)
  return detail.replace(/^Command failed: powershell.*?\n/, "").trim()
}

/**
 * Write (upsert) one DPAPI-protected file. Throws on a PowerShell failure —
 * the same shape `writeKeychainToken` has on macOS.
 */
export async function writeDpapiToken(service: string, account: string, token: string, deps?: DpapiDeps): Promise<void> {
  const { cmd, args } = buildDpapiWriteCommand(service, account, token, deps)
  try {
    await runPowerShell(args, deps)
  } catch (err) {
    throw new Error(`agentproto auth: cannot write the Windows DPAPI credential store: ${errMsg(err)}`)
  }
}

/** Read one DPAPI-protected file; `undefined` on a miss or on ANY PowerShell
 *  failure — the same swallow shape `readKeychainToken` has on macOS. */
export async function readDpapiToken(service: string, account: string, deps?: DpapiDeps): Promise<string | undefined> {
  const { cmd, args } = buildDpapiReadCommand(service, account, deps)
  try {
    const { stdout } = await runPowerShell(args, deps)
    return stdout.trimEnd() || undefined
  } catch {
    return undefined
  }
}

/** Delete one DPAPI-protected file; true when the entry existed. */
export async function deleteDpapiToken(service: string, account: string, deps?: DpapiDeps): Promise<boolean> {
  const { cmd, args } = buildDpapiDeleteCommand(service, account, deps)
  try {
    const { stdout } = await runPowerShell(args, deps)
    return stdout.trim() === "1"
  } catch {
    return false
  }
}
