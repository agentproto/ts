/**
 * Win32 spawn argv resolution for AgentCli adapter launches — recap point 10
 * (WIN11 test 2026-09-29/30): a device-sandbox spawn onto a joined Windows
 * host reached its daemon and ran the inner `agent_start`, but the headless
 * adapter launch died with Node `spawn EINVAL`. e2b/Linux hosts had never
 * shown it because only Windows has npm `.cmd` shims.
 *
 * The mechanism (both file:line cited in the PR that ships this):
 *   - `resolveSpawnBin` (`define-agent-cli.ts:115-121`) rewrites the
 *     manifest `bin: "npx"` (opencode, claude-code, codex, …) to the
 *     ABSOLUTE `<execPath-dir>\npx.cmd` on win32.
 *   - The ACP arm's spawn (`define-agent-cli.ts:527`) and the print arm's
 *     spawn (`print-arm.ts:188`) then pass that `.cmd` path to
 *     `child_process.spawn` WITHOUT the `shell` option.
 *   - Node ≥ 18.20.2 / 20.12.2 / 22.0 (CVE-2024-27980: `IsWindowsBatchFile`
 *     in `src/process_wrap.cc`) refuses every spawn whose file literal ends
 *     in `.bat`/`.cmd` without `shell: true` → the whole `agent_start`
 *     fails `spawn EINVAL`. Bare (extensionless) bins never hit that check
 *     — the spawn paths that work on Windows (the PTY/ConPTY launches,
 *     which cmd-resolve shims from a command-LINE string) pass either a
 *     bare name or a real `.exe` — which is exactly the divergence between
 *     the working local spawn and the device-bridge host spawn.
 *
 * Fix policy (two stages, keyed on the resolved bin's extension, win32 only):
 *   1. PREFERRED — rewrite a `.cmd`/`.bat` npm shim into the real node
 *      entry it wraps (`npx.cmd` → `node …/node_modules/npm/bin/npx-cli.js`):
 *      the spawn stays `shell:false` with clean argv, and no cmd.exe
 *      interpolation of our args. Every shipped adapter (bin `npx`/`npm`)
 *      takes this stage.
 *   2. FALLBACK — a `.cmd`/`.bat` bin we cannot rewrite (another global
 *      package's shim named directly in a manifest) spawns with
 *      `shell: true`, Node's documented escape hatch. Args reaching that
 *      stage come from adapter manifests plus operator `model`/`effort`
 *      values validated upstream — free-form shell input never goes here.
 */

import { basename, dirname, join } from "node:path"

/** True when `exe` is a batch file Node on Windows refuses to spawn
 *  directly without `shell: true` (see module doc — CVE-2024-27980). */
export function isWindowsBatchFile(
  exe: string,
  deps?: { platform?: NodeJS.Platform },
): boolean {
  if ((deps?.platform ?? process.platform) !== "win32") return false
  return /\.(?:bat|cmd)$/i.test(exe)
}

/** `spawn` options telling Node to run a batch-file bin through cmd.exe —
 *  empty (no options) on POSIX or for a non-batch bin. Spread verbatim
 *  into both arms' `spawn(execBin, execArgs, { … })` calls once the spawn
 *  args are final. */
export function windowsBatchShellOption(
  exe: string,
  deps?: { platform?: NodeJS.Platform },
): { shell: true } | { shell?: never } {
  if (isWindowsBatchFile(exe, deps)) return { shell: true }
  return {}
}

export interface WindowsBatchSpawnResolution {
  bin: string
  args: string[]
}

/** Stage 1: when `bin` is a `.cmd`/`.bat` npm shim whose real node entry
 *  sits beside it, swap the shim for
 *  `<execPath> <dirname(bin)/node_modules/npm/bin/<stem>-cli.js>`. npm's
 *  own `.cmd` shims (`npx.cmd`, `npm.cmd`) are exactly this: a two-line
 *  wrapper execing `node <…>/npm/bin/<npx|npm>-cli.js $*`, so the rewrite
 *  is behavior-identical while keeping the spawn `shell:false` (cmd.exe
 *  never sees our argv). `npx-cli.js`/`npm-cli.js` live next to their shim
 *  both in a Node install dir (`C:\Program Files\nodejs\`) and in an npm
 *  global-prefix dir (`%APPDATA%\npm\`), so `dirname(bin)` is the right
 *  root in both layouts. A third-party global bin shim (e.g.
 *  `opencode.cmd`) has no such sibling JS — this returns `undefined` and
 *  the caller falls back to {@link windowsBatchShellOption}. */
export function resolveWindowsBatchSpawn(
  bin: string,
  args: readonly string[],
  deps?: {
    platform?: NodeJS.Platform
    execPath?: string
    exists?: (p: string) => boolean
  },
): WindowsBatchSpawnResolution | undefined {
  if ((deps?.platform ?? process.platform) !== "win32") return undefined
  if (!isWindowsBatchFile(bin, deps)) return undefined
  const stem = basename(bin).replace(/\.(?:bat|cmd)$/i, "")
  if (stem !== "npx" && stem !== "npm") return undefined
  const script = join(dirname(bin), "node_modules", "npm", "bin", `${stem}-cli.js`)
  if (!(deps?.exists ?? (() => false))(script)) return undefined
  return { bin: deps?.execPath ?? process.execPath, args: [script, ...args] }
}
