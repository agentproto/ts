/**
 * `agentproto app build <appDir> [--json]`
 *
 * Build an agentproto app's UI **source** project (`<appDir>/ui/`, a Vite +
 * TypeScript project) into the static `.agentproto/ui/` the daemon /
 * `app serve` / the MCP-Apps panel actually serve.
 *
 * Two shapes an app dir can be in, both valid:
 *
 *   1. Hand-written vanilla UI: `.agentproto/ui/` exists directly, no
 *      `ui/` source project (or a `ui/` with no `package.json` build
 *      script). Nothing to compile — `app build` is a documented no-op
 *      success so scripts and CI can call it unconditionally.
 *
 *   2. Generated UI: `ui/` holds a buildable project (`package.json` with a
 *      `scripts.build`). We shell out to the project's own package-manager
 *      build script (`<pm> run build`, cwd `ui/`) rather than reimplementing
 *      a bundler — the project's `vite.config.ts` already points its
 *      `outDir` at `../.agentproto/ui` (the frozen layout convention), so a
 *      successful build lands exactly where `app serve` / `app pack` expect
 *      it. We only verify that landing, not how the build produced it.
 *
 * Package manager detection is lockfile-based (pnpm-lock.yaml / package-lock.json
 * / yarn.lock), checked in the app root first and then `ui/`, defaulting to
 * pnpm — the same convention `create-agentproto-app` scaffolds with.
 */

import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { pathExists, spawnInherit } from "./commands/skill-install/shared.js"
import { expandHome } from "./commands/skill-install/pack-resolve.js"

const USAGE = `agentproto app build — build an app's ui/ source project into .agentproto/ui/

Usage:
  agentproto app build <appDir> [--json]

appDir:
  Directory holding a valid .agentproto/APP.md. Required.

No ui/ project, or a ui/ with no "scripts.build" in its package.json, is a
no-op success — the app is a hand-written static UI with nothing to compile.
Otherwise runs "<pm> run build" with cwd <appDir>/ui (pm detected from a
lockfile in <appDir> then <appDir>/ui, defaulting to pnpm) and verifies the
build landed at <appDir>/.agentproto/ui/index.html.

--json:
  Print a machine-readable result instead of a human summary.`

export type PackageManager = "pnpm" | "npm" | "yarn"

const LOCKFILE_BY_PM: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
]

/**
 * Detect the package manager to build a `ui/` project with: the first
 * recognized lockfile found in `appDir`, else the first found in `uiDir`,
 * else `pnpm`.
 */
export async function detectPackageManager(
  appDir: string,
  uiDir: string,
): Promise<PackageManager> {
  for (const dir of [appDir, uiDir]) {
    for (const [lockfile, pm] of LOCKFILE_BY_PM) {
      if (await pathExists(join(dir, lockfile))) return pm
    }
  }
  return "pnpm"
}

/** Result of a no-op build (no ui/ project to compile). */
export type NoUiReason = "no-ui-project" | "no-build-script"

/**
 * Whether `<appDir>/ui` has a buildable project: a `package.json` with a
 * non-empty `scripts.build`. Returns the no-op reason when it doesn't, so
 * the caller can report *why* it no-op'd.
 */
async function checkUiBuildable(
  uiDir: string,
): Promise<{ buildable: true } | { buildable: false; reason: NoUiReason }> {
  const pkgPath = join(uiDir, "package.json")
  if (!(await pathExists(pkgPath))) {
    return { buildable: false, reason: "no-ui-project" }
  }
  let pkg: unknown
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"))
  } catch {
    return { buildable: false, reason: "no-build-script" }
  }
  if (typeof pkg !== "object" || pkg === null) {
    return { buildable: false, reason: "no-build-script" }
  }
  const scripts = (pkg as Record<string, unknown>).scripts
  const build =
    scripts && typeof scripts === "object"
      ? (scripts as Record<string, unknown>).build
      : undefined
  if (typeof build !== "string" || build.length === 0) {
    return { buildable: false, reason: "no-build-script" }
  }
  return { buildable: true }
}

/** `agentproto app build <appDir> [--json]`. */
export async function runAppBuild(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const appDirArg = positionals[0]
  if (!appDirArg) {
    process.stderr.write(
      `agentproto app build: <appDir> is required.\n${USAGE}\n`,
    )
    return 2
  }
  const appDir = resolve(process.cwd(), expandHome(appDirArg))
  const runJson = values.json === true

  // 1. Require a valid .agentproto/APP.md
  const appMdPath = join(appDir, ".agentproto", "APP.md")
  if (!(await pathExists(appMdPath))) {
    process.stderr.write(
      `agentproto app build: ${appDir} is not an agentproto app ` +
        `(missing ${appMdPath}).\n`,
    )
    return 2
  }

  // 2. No ui/ project, or one with no build script -> no-op success.
  const uiDir = join(appDir, "ui")
  const buildable = await checkUiBuildable(uiDir)
  if (!buildable.buildable) {
    if (runJson) {
      process.stdout.write(
        JSON.stringify({ built: false, reason: buildable.reason }) + "\n",
      )
    } else {
      process.stdout.write("no ui build step — static UI passthrough\n")
    }
    return 0
  }

  // 3. Run the ui project's own build script.
  const pm = await detectPackageManager(appDir, uiDir)
  const code = await spawnInherit(pm, ["run", "build"], { cwd: uiDir })
  if (code !== 0) {
    process.stderr.write(
      `agentproto app build: '${pm} run build' failed with exit code ${code}.\n`,
    )
    return 1
  }

  // 4. Verify the build landed where app serve / app pack expect it.
  const uiOutDir = join(appDir, ".agentproto", "ui")
  const indexPath = join(uiOutDir, "index.html")
  if (!(await pathExists(indexPath))) {
    process.stderr.write(
      `agentproto app build: build succeeded but ${indexPath} is missing. ` +
        `The ui/ project must emit its build output to ../.agentproto/ui ` +
        `(Vite: outDir: "../.agentproto/ui").\n`,
    )
    return 1
  }

  if (runJson) {
    process.stdout.write(JSON.stringify({ built: true, uiDir: uiOutDir }) + "\n")
  } else {
    process.stdout.write(`agentproto: built ui -> ${uiOutDir}\n`)
  }
  return 0
}
