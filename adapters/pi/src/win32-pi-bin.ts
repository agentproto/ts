/**
 * Win32 pi binary resolution — issue #1637 field defect 2: the manifest
 * declares `bin: "pi"`, but on Windows the installed binary is a `.cmd` shim
 * (npm global or the curl installer, both put `pi.cmd` on PATH) and Node's
 * `spawn` without `shell` does not PATHEXT-resolve `pi` → `pi.cmd`, so every
 * pi session start died with `spawn pi ENOENT` (WIN11, agentproto 1.7.1).
 *
 * Policy (mirrors win32-spawn.ts's stage-1/stage-2, win32 only):
 *   0. An explicit absolute `bin` (an `AGENTPROTO_PI_BIN` override, or a
 *      manifest `bin` with separators) always wins — checked BEFORE the
 *      PATH scan, so a deliberately-pinned install is never shadowed by an
 *      unrelated `pi` resolving earlier on PATH.
 *   1. Otherwise scan `PATH` for the first hit of `<entry>/pi.exe`,
 *      `<entry>/pi.cmd`, `<entry>/pi.bat`, or a plain extensionless
 *      `<entry>/pi` (in that order — first entry wins, within an entry
 *      shim-aware).
 *   2. `.exe` / extensionless (real native binary or POSIX-layout shell
 *      script dir) → spawn directly.
 *   3. `.cmd`/`.bat` shim → prefer the stage-1 rewrite: when a sibling
 *      `node_modules/@earendil-works/pi-coding-agent` package exists beside
 *      the shim (npm global-prefix layout), spawn
 *      `{ bin: node, args: [packageEntryJs, …] }` — `shell:false`, no
 *      cmd.exe sees our argv. Else stage 2: spawn the `.cmd` with
 *      `shell: true`, quoting `bin`/each arg when it contains whitespace
 *      (args here are adapter-internal constants; user shell input never
 *      reaches this path, but a shim path under a spaced dir — e.g. a
 *      custom npm prefix or a spaced user profile — still needs quoting to
 *      survive cmd.exe's unescaped argv join).
 */

import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"

/** Quote a `shell: true` argv token for cmd.exe when it contains whitespace.
 *  Node's `shell: true` does no escaping of its own — it just joins
 *  `[bin, ...args]` with spaces and hands the result to `cmd.exe /d /s /c`
 *  — so an unquoted path containing a space (a custom npm prefix like
 *  `C:\Program Files\npm`, or a spaced user profile dir) splits into
 *  multiple tokens and misresolves or ENOENTs. Doubling any embedded `"`
 *  mirrors cmd.exe's own escaping convention. */
function quoteForShell(value: string): string {
  if (!/\s/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

export interface WindowsPiBinResolution {
  bin: string
  args: readonly string[]
  /** Spawn options to pass verbatim as `spawn(bin, args, opts)`. */
  shell?: true
}

export interface WindowsPiBinDeps {
  platform?: NodeJS.Platform
  pathEnv?: string | undefined
  exists?: (p: string) => boolean
  execPath?: string
}

/** The package entry `pi.cmd` npm shim actually runs (the npm -g install
 *  layout: the shim sits in the global `bin/` dir and the package it wraps
 *  is that same prefix's `node_modules`). */
const PI_PACKAGE_DIR_SEGMENTS = [
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
] as const

function firstExisting(
  candidates: readonly string[],
  exists: (p: string) => boolean,
): string | undefined {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return undefined
}

/** Scan PATH for a pi install, shim-aware: for each dir in `pathEnv`, look
 *  for `pi.exe` (native, spawn directly), then `pi.cmd`/`pi.bat` (npm-style
 *  shim), then a plain extensionless `pi` (real binary or POSIX-layout).
 *  Shim extensionality never wins over an earlier entry: the FIRST PATH
 *  ENTRY containing any pi of these forms wins; inside one entry the
 *  .exe/native check runs before the shim check. Returns the resolved
 *  absolute-ish candidate path plus its kind. */
export function locateWindowsPi(
  pathEnv: string,
  deps?: { exists?: (p: string) => boolean },
): { path: string; kind: "exe" | "shim" | "native" } | undefined {
  const exists = deps?.exists ?? existsSync
  // Windows PATH is `;`-separated exclusively (a drive-letter colon is part
  // of the entries, never a separator).
  for (const entry of pathEnv.split(";")) {
    if (entry.length === 0) continue
    const exe = firstExisting([join(entry, "pi.exe")], exists)
    if (exe) return { path: exe, kind: "exe" }
    const shim = firstExisting([join(entry, "pi.cmd"), join(entry, "pi.bat")], exists)
    if (shim) return { path: shim, kind: "shim" }
    const plain = firstExisting([join(entry, "pi")], exists)
    if (plain) return { path: plain, kind: "native" }
  }
  return undefined
}

/** The real node entry JS the `pi.cmd` shim wraps, when one sits beside it
 *  in npm's global-prefix layout: `<shimDir>/node_modules/@earendil-works/
 *  pi-coding-agent/dist/cli.js`. Pure fs read, like
 *  `resolveWindowsBatchSpawn`'s stage-1 probe. */
function findPiPackageEntry(
  shimDir: string,
  exists: (p: string) => boolean,
): string | undefined {
  const pkgDir = join(shimDir, ...PI_PACKAGE_DIR_SEGMENTS)
  for (const entry of [
    "dist/bundle/cli.js", // real peer package (npm view, 0.99.x bin map)
    "dist/cli.js",
    "dist/main.js",
    "cli.js",
  ]) {
    const candidate = join(pkgDir, entry)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/** Resolve the pi spawn on win32:
 *  - an explicit absolute `bin` always wins over the PATH scan (see module
 *    doc policy step 0).
 *  - no PATH hit (and no explicit absolute `bin`) → `undefined` (caller
 *    reports its own spawn ENOENT, and the error message still names the
 *    bare spec — same UX as POSIX).
 *  - `.exe` or extensionless `pi` → spawn directly, `shell` unset.
 *  - `.cmd`/`.bat` shim WITH a sibling package entry JS →
 *    `{ bin: node, args: [entryJs, ...rest] }`.
 *  - `.cmd`/`.bat` shim WITHOUT a sibling → spawn the shim with
 *    `shell: true`, `bin`/each arg quoted if it contains whitespace (args
 *    are adapter-internal constants only).
 *  Returns `undefined` on POSIX (no divergence there). */
export function resolveWindowsPiSpawn(
  bin: string,
  args: readonly string[],
  deps?: WindowsPiBinDeps,
): WindowsPiBinResolution | undefined {
  if ((deps?.platform ?? process.platform) !== "win32") return undefined
  const exists = deps?.exists ?? existsSync
  const pathEnv = deps?.pathEnv ?? process.env.PATH ?? ""

  // Explicit absolute path override (AGENTPROTO_PI_BIN, or a manifest `bin`
  // with separators) always wins — checked BEFORE the PATH scan so a
  // deliberately-pinned install is never shadowed by an unrelated `pi` that
  // happens to resolve earlier on PATH. Apply the same per-extension policy
  // a PATH-scanned shim would get.
  if (isAbsolute(bin)) {
    if (/\.(?:cmd|bat)$/i.test(bin)) {
      const entryJs = findPiPackageEntry(join(bin, ".."), exists)
      if (entryJs) {
        return {
          bin: deps?.execPath ?? process.execPath,
          args: [entryJs, ...args],
        }
      }
      return { bin: quoteForShell(bin), args: args.map(quoteForShell), shell: true }
    }
    // `.exe` or extensionless explicit path — spawn directly, no PATH scan
    // or shell needed.
    return { bin, args }
  }

  const located = locateWindowsPi(pathEnv, { exists })

  // Not found on PATH at all: fall through to the bare spec and let the OS
  // produce the ENOENT surface.
  if (located) {
    if (located.kind === "shim") {
      const entryJs = findPiPackageEntry(join(located.path, ".."), exists)
      if (entryJs) {
        return {
          bin: deps?.execPath ?? process.execPath,
          args: [entryJs, ...args],
        }
      }
      return { bin: quoteForShell(located.path), args: args.map(quoteForShell), shell: true }
    }
    // exe / native
    return { bin: located.path, args }
  }

  return undefined
}

