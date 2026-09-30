/**
 * Bootstrap the ADAPTER PACKAGE itself for a slug — `npm i -g
 * @agentproto/adapter-<slug>` when resolution missed because the package is
 * simply not installed.
 *
 * Recap point 5 (WIN11 test 2026-09-29/30): on a fresh Windows,
 * `agentproto setup opencode` failed with "can't find package
 * '@agentproto/adapter-opencode'" — expecting the user to npm-install a
 * machine dependency by hand first. The bootstrap behavior existed in
 * `agentproto install <slug>` (`commands/install.ts`) but `agentproto
 * setup <slug>` resolved the adapter directly and died on the missing
 * package instead. This module extracts the install verb's bootstrap into
 * one shared implementation so both verbs (and any future caller) get the
 * identical behavior:
 *
 *   - Gate on the bundled CATALOG (so we're confident the npm package
 *     exists before trying) and on a missing-package error shape (never
 *     "installed but import-broken" — that rethrows as before).
 *   - Run the package manager that owns the CLI itself: npm, which is
 *     what every installer docs (`npm i -g @agentproto/cli`) and what
 *     `scripts/bootstrap/install.ps1` sets up. On Windows the plain
 *     "npm" spawn must go through cmd.exe: libuv argv-spawns resolve
 *     only `.exe` (npm global bins are `.cmd` shims only) and Node
 *     ≥ 18.20.2 (CVE-2024-27980) refuses direct `.cmd` spawning —
 *     `spawn EINVAL`, the recap-point-10 failure shape for adapter
 *     launches (`@agentproto/driver-agent-cli`'s win32-spawn.ts).
 *   - Deliberately NOT wired into the daemon's spawn-time resolution
 *     (`serve.ts`'s `resolveAgentAdapter`): a headless `npm i -g` fired
 *     from inside a tenant `agent_start` can run for minutes against a
 *     live daemon. The verb surface is where an operator's install intent
 *     lives — this keeps that honest and the spawn path fail-fast (its
 *     error still points at `npm i -g`).
 */

import type { ResolvedAdapter } from "./resolve.js"
import { resolveAdapter } from "./resolve.js"
import { CATALOG } from "./catalog.js"
import { spawn } from "node:child_process"

/** True when `err` is resolveAdapter's "the adapter package is not
 *  installed" failure shape — the only shape the bootstrap may answer.
 *  A package that IS on disk but fails to import (mid-rebuild, broken
 *  exports) rethrows: installing it again cannot fix that. The message
 *  match mirrors the same check `commands/install.ts` ran inline before
 *  this extraction. */
export function isMissingAdapterPackageError(
  err: unknown,
  slug: string
): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /could not load adapter|Cannot find package|ERR_MODULE_NOT_FOUND/i.test(
      msg
    ) && msg.includes(`@agentproto/adapter-${slug}`)
  )
}

export interface BootstrapDeps {
  /** Inventory deciding whether `@agentproto/adapter-<slug>` is a real
   *  npm package (overridable in tests). Defaults to the bundled CATALOG. */
  catalog?: readonly (readonly [
    /* slug */ string,
    /* packageName? */ string | undefined,
  ])[]
  /** The package-manager spawn (defaults to a real inherit-spawn of npm —
   *  cmd.exe-wrapped on win32, see the module doc). */
  npmSpawn?: (args: readonly string[]) => Promise<number>
  /** The adapter resolver (defaults to the real `resolveAdapter`;
   *  injected in tests so no real resolution happens). */
  resolve?: (slug: string) => Promise<ResolvedAdapter>
  stdout?: { write(chunk: string): unknown }
  stderr?: { write(chunk: string): unknown }
}

interface BootstrapOptions {
  dryRun?: boolean
  /** Which verb's name to imprint on the output lines ("install" /
   *  "setup" today). */
  verb?: string
  deps?: BootstrapDeps
}

/** Spawn one npm invocation with its output inherited by this process.
 *  Returns the child's exit code; a spawn error (npm not on PATH) resolves
 *  127 instead of rejecting — a missing package manager is "install
 *  failed", not "crashed the verb". `deps.npmSpawn` replaces it in tests
 *  (fake package-manager command, no network). Shared with
 *  `commands/install.ts` (the manifest `npm` steps + vendored install
 *  hints spawn through the same helper). */
export async function spawnNpmInherit(
  args: readonly string[],
  npmSpawn?: (args: readonly string[]) => Promise<number>
): Promise<number> {
  if (npmSpawn) return npmSpawn(args)
  return new Promise<number>((resolve) => {
    let child: ReturnType<typeof spawn>
    if (process.platform === "win32") {
      // npm is a `.cmd` shim on Windows: a shell-less argv spawn resolves
      // only `.exe` through libuv, and Node ≥ 18.20.2 (CVE-2024-27980)
      // refuses a literal `.cmd` without `shell: true` — go through cmd.exe.
      child = spawn(
        process.env["ComSpec"] ?? "cmd.exe",
        ["/d", "/s", "/c", `npm ${args.join(" ")}`],
        { stdio: "inherit" }
      )
    } else {
      child = spawn("npm", [...args], { stdio: "inherit" })
    }
    child.once("error", () => resolve(127))
    child.once("exit", (code) => resolve(code ?? 0))
  })
}

/**
 * Attempt `npm i -g <pkg>` for a slug whose adapter package is missing.
 * Returns the child's exit code ({0 = installed / would-run in dry-run}),
 * after printing what ran. Does NOT re-resolve the adapter — callers do
 * (they keep their own resolution niceties; see install.ts's retry
 * comment).
 */
export async function bootstrapAdapterPackage(
  slug: string,
  opts: BootstrapOptions = {}
): Promise<number> {
  const verb = opts.verb ?? "install"
  const catalog =
    opts.deps?.catalog ?? CATALOG.map((e) => [e.slug, e.packageName] as const)
  const out = opts.deps?.stdout ?? process.stdout
  const errOut = opts.deps?.stderr ?? process.stderr

  const pkg = catalog.find(([s]) => s === slug)?.[1]
  if (!pkg) {
    errOut.write(
      `agentproto ${verb}: could not bootstrap '${slug}' — it's not in the ` +
        `bundled adapter catalog and no package name is known for it. ` +
        `Install its adapter package manually (npm i -g ` +
        `@agentproto/adapter-${slug}) if that's the real package name.\n`
    )
    return 1
  }

  if (opts.dryRun) {
    out.write(`agentproto ${verb}: [bootstrap] would run: npm i -g ${pkg}\n`)
    return 0
  }
  out.write(`agentproto ${verb}: [bootstrap] running: npm i -g ${pkg}\n`)
  const code = await spawnNpmInherit(["install", "-g", pkg], opts.deps?.npmSpawn)
  if (code !== 0) {
    errOut.write(
      `agentproto ${verb}: npm i -g ${pkg} failed (exit ${code}). ` +
        `Install it manually: npm i -g ${pkg}\n`
    )
  }
  return code
}

/** The adapter-package slug rule resolveAdapter enforces — mirrored here
 *  so the npm command string built for cmd.exe never carries shell
 *  metacharacters. */
const SLUG_RE = /^[a-z][a-z0-9-]*$/

export interface ResolveAdapterWithBootstrapResult {
  ok: boolean
  adapter?: ResolvedAdapter
  /** The original resolution failure when the bootstrap could not recover
   *  it (or `dryRun` stopped before installing). Callers rethrow this
   *  verbatim so resolveAdapter's own error — "Install it with:
   *  npm i -g …" — stays intact even after a failed bootstrap attempt. */
  error?: unknown
}

/**
 * `resolveAdapter(slug)` with the recap-point-5 auto-install: on a
 * missing-package failure, run `npm i -g @agentproto/adapter-<slug>`
 * once, then re-resolve. Everything else (import-broken package, catalog
 * miss, failed install) comes back `{ok:false, error}` with the ORIGINAL
 * resolveAdapter error unchanged.
 */
export async function resolveAdapterWithBootstrap(
  slug: string,
  opts: BootstrapOptions = {}
): Promise<ResolveAdapterWithBootstrapResult> {
  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      error: new Error(`agentproto: invalid adapter slug '${slug}'.`),
    }
  }
  const resolver = opts.deps?.resolve ?? resolveAdapter
  let adapter: ResolvedAdapter
  try {
    adapter = await resolver(slug)
    return { ok: true, adapter }
  } catch (err) {
    if (opts.dryRun || !isMissingAdapterPackageError(err, slug)) {
      return { ok: false, error: err }
    }
    const code = await bootstrapAdapterPackage(slug, opts)
    if (code !== 0) return { ok: false, error: err }
    try {
      adapter = await resolver(slug)
      return { ok: true, adapter }
    } catch (retryErr) {
      return { ok: false, error: retryErr }
    }
  }
}
