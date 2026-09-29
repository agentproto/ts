/**
 * Test-wide guard: no test may read or write a real Chrome profile, and none may
 * ask the macOS Keychain for a key. Every fs and child_process entry point the
 * package uses is wrapped; a path inside a real default browser dir, or a
 * `security` invocation, throws and fails the test. `guard.test.ts` proves the
 * guard itself fires.
 */
import { homedir, platform } from "node:os"
import { join, resolve } from "node:path"
import { vi } from "vitest"

const home = homedir()
const REAL_DIRS: string[] = [
  join(home, "Library", "Application Support", "Google"),
  join(home, "Library", "Application Support", "Chromium"),
  join(home, "Library", "Application Support", "BraveSoftware"),
  join(home, "Library", "Application Support", "Microsoft Edge"),
  join(home, ".config", "google-chrome"),
  join(home, ".config", "chromium"),
  join(home, ".config", "BraveSoftware"),
  join(home, ".config", "microsoft-edge"),
  join(process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), "Google"),
]

export class RealProfileTouchedError extends Error {}

function check(value: unknown): void {
  if (typeof value !== "string" && !(value instanceof URL)) return
  const p = resolve(value instanceof URL ? value.pathname : value)
  const hit = REAL_DIRS.find(d => p === d || p.startsWith(`${d}/`) || p.startsWith(`${d}\\`))
  if (hit) throw new RealProfileTouchedError(`test touched a real browser profile path (${platform()}): ${hit}`)
}

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const wrap = <F extends (...a: never[]) => unknown>(fn: F, ...idx: number[]): F =>
    ((...a: unknown[]) => {
      for (const i of idx) check(a[i])
      return (fn as unknown as (...x: unknown[]) => unknown)(...a)
    }) as unknown as F
  return {
    ...actual,
    default: actual,
    existsSync: wrap(actual.existsSync, 0),
    readFileSync: wrap(actual.readFileSync, 0),
    writeFileSync: wrap(actual.writeFileSync, 0),
    copyFileSync: wrap(actual.copyFileSync, 0, 1),
    readdirSync: wrap(actual.readdirSync, 0),
    mkdirSync: wrap(actual.mkdirSync, 0),
    rmSync: wrap(actual.rmSync, 0),
    readlinkSync: wrap(actual.readlinkSync, 0),
    realpathSync: Object.assign(wrap(actual.realpathSync, 0), { native: actual.realpathSync.native }),
  }
})

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const wrap = <F extends (...a: never[]) => unknown>(fn: F, ...idx: number[]): F =>
    ((...a: unknown[]) => {
      try {
        for (const i of idx) check(a[i])
      } catch (e) {
        return Promise.reject(e)
      }
      return (fn as unknown as (...x: unknown[]) => unknown)(...a)
    }) as unknown as F
  return {
    ...actual,
    default: actual,
    readFile: wrap(actual.readFile, 0),
    writeFile: wrap(actual.writeFile, 0),
    readdir: wrap(actual.readdir, 0),
    copyFile: wrap(actual.copyFile, 0, 1),
  }
})

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    default: actual,
    execFileSync: ((file: string, args?: readonly string[], ...rest: unknown[]) => {
      if (file === "security") throw new RealProfileTouchedError("test asked the Keychain for a Safe Storage key")
      for (const a of args ?? []) check(a)
      return (actual.execFileSync as unknown as (...x: unknown[]) => unknown)(file, args, ...rest)
    }) as unknown as typeof actual.execFileSync,
  }
})
