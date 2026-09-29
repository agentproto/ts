/** Builds a throwaway Chrome-shaped user-data dir under the OS temp dir. Never touches a real profile. */
import { execFileSync } from "node:child_process"
import { createCipheriv } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeStorageKey } from "../local-session.js"

export const SYNTH_PASSWORD = "synthetic-safe-storage-password"

export function sqliteAvailable(): boolean {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const CHROME_EPOCH_S = 11644473600

export interface SynthCookie {
  host: string
  name: string
  value: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  /** Unix seconds; omitted is a session cookie. */
  expiresUnix?: number
}

export interface SynthProfile {
  dir: string
  name?: string
  email?: string
  cookies: SynthCookie[]
}

export function encryptValue(value: string): string {
  const c = createCipheriv("aes-128-cbc", safeStorageKey(SYNTH_PASSWORD), Buffer.alloc(16, " "))
  return Buffer.concat([Buffer.from("v10"), c.update(value, "utf8"), c.final()]).toString("hex")
}

export function makeSyntheticChromeRoot(profiles: SynthProfile[], lastUsed?: string): string {
  const root = mkdtempSync(join(tmpdir(), "bp-synth-chrome-"))
  const info: Record<string, Record<string, string>> = {}
  for (const p of profiles) {
    info[p.dir] = { ...(p.name ? { name: p.name } : {}), ...(p.email ? { user_name: p.email } : {}) }
    const pdir = join(root, p.dir)
    mkdirSync(pdir, { recursive: true })
    const db = join(pdir, "Cookies")
    const rows = p.cookies
      .map(c => {
        const exp = c.expiresUnix ? (c.expiresUnix + CHROME_EPOCH_S) * 1_000_000 : 0
        return `INSERT INTO cookies VALUES ('${c.host}','${c.name}','${c.path ?? "/"}',X'${encryptValue(c.value)}',${c.secure ? 1 : 0},${c.httpOnly ? 1 : 0},${exp});`
      })
      .join("\n")
    execFileSync("sqlite3", [
      db,
      `CREATE TABLE cookies (host_key TEXT, name TEXT, path TEXT, encrypted_value BLOB, is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER);\n${rows}`,
    ])
  }
  writeFileSync(
    join(root, "Local State"),
    JSON.stringify({ profile: { info_cache: info, ...(lastUsed ? { last_used: lastUsed } : {}) } }),
  )
  return root
}
