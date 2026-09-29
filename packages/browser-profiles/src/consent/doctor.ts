/**
 * `doctor`: why can't Bureau read this Chrome profile? Every probe goes through
 * an injected port, so tests use fakes and never touch a real profile. The
 * Keychain is probed only when the caller asks for it explicitly.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseLocalState } from "../local-state.js"

export type DoctorFailure = "missing" | "full-disk-access" | "unreadable" | "keychain-denied"

export interface DoctorCheck {
  id: "local-state" | "cookies-db" | "keychain"
  status: "ok" | "fail" | "skipped"
  detail: string
  failure?: DoctorFailure
  /** What to do about it. */
  fix?: string
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
  /** Set when any check failed: the way around needing the profile at all. */
  recommendation?: string
}

/** Probes the doctor runs. Each throws a Node-style error (with `code`) on failure. */
export interface DoctorPort {
  /** Raw text of `Local State`. */
  readLocalState(): string
  /** Copy the profile's Cookies db somewhere temporary and remove the copy. */
  copyCookiesDb(profile: string): void
  /** Ask the Keychain for the Safe Storage key. Only called when `checkKeychain` is true. */
  probeKeychain?(): void
  /** The exact executable that needs Full Disk Access. */
  binary: string
}

export interface DoctorOptions {
  port: DoctorPort
  profile: string
  /** Explicit action: touch the Keychain. Default false. */
  checkKeychain?: boolean
}

const NATIVE_LOGIN_RECOMMENDATION =
  "Sign in natively instead: run the native-login flow in the Bureau browser. It needs no access to your Chrome profile, Keychain or Full Disk Access."

const errCode = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string"
    ? (e as { code: string }).code
    : undefined

function classify(e: unknown, binary: string, what: string): Pick<DoctorCheck, "failure" | "detail" | "fix"> {
  const code = errCode(e)
  if (code === "EPERM" || code === "EACCES") {
    return {
      failure: "full-disk-access",
      detail: `${what} was blocked (${code}). Full Disk Access is missing for "${binary}".`,
      fix: `System Settings > Privacy & Security > Full Disk Access: enable "${binary}", then restart it.`,
    }
  }
  if (code === "ENOENT") {
    return { failure: "missing", detail: `${what} does not exist.`, fix: "Check the Chrome profile name (Default, Profile 1) and that Chrome is installed." }
  }
  return { failure: "unreadable", detail: `${what} could not be read (${code ?? "unknown error"}).` }
}

export function runDoctor(opts: DoctorOptions): DoctorReport {
  const { port } = opts
  const checks: DoctorCheck[] = []

  try {
    const state = parseLocalState(port.readLocalState())
    checks.push({ id: "local-state", status: "ok", detail: `Local State readable, ${state.profiles.length} profile(s) listed.` })
  } catch (e) {
    checks.push({ id: "local-state", status: "fail", ...classify(e, port.binary, "Local State") })
  }

  try {
    port.copyCookiesDb(opts.profile)
    checks.push({ id: "cookies-db", status: "ok", detail: `Cookies db of "${opts.profile}" is copyable.` })
  } catch (e) {
    checks.push({ id: "cookies-db", status: "fail", ...classify(e, port.binary, `Cookies db of "${opts.profile}"`) })
  }

  if (opts.checkKeychain === true && port.probeKeychain) {
    try {
      port.probeKeychain()
      checks.push({ id: "keychain", status: "ok", detail: "Keychain returned the Safe Storage key (value not shown)." })
    } catch {
      checks.push({
        id: "keychain",
        status: "fail",
        failure: "keychain-denied",
        detail: "The Keychain did not release the Safe Storage key.",
        fix: "Approve the Keychain prompt for this run, or use native login.",
      })
    }
  } else {
    checks.push({ id: "keychain", status: "skipped", detail: "Keychain not touched. Pass the explicit keychain check to probe it." })
  }

  const ok = checks.every(c => c.status !== "fail")
  return { ok, checks, ...(ok ? {} : { recommendation: NATIVE_LOGIN_RECOMMENDATION }) }
}

export interface LocalDoctorPortOptions {
  chromeRoot: string
  binary?: string
  probeKeychain?: () => void
}

/** The real-filesystem port. The Cookies copy lives in a temp dir and is removed at once. */
export function localDoctorPort(opts: LocalDoctorPortOptions): DoctorPort {
  return {
    binary: opts.binary ?? process.execPath,
    readLocalState: () => readFileSync(path.join(opts.chromeRoot, "Local State"), "utf8"),
    copyCookiesDb(profile) {
      const dir = mkdtempSync(path.join(tmpdir(), "bp-doctor-"))
      try {
        copyFileSync(path.join(opts.chromeRoot, profile, "Cookies"), path.join(dir, "Cookies"))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    ...(opts.probeKeychain ? { probeKeychain: opts.probeKeychain } : {}),
  }
}
