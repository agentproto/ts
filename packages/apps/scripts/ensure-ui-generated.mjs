#!/usr/bin/env node
/**
 * Cheap existence gate for the three gitignored `panel.generated.ts` modules
 * (work-board / review-panel / store), run from the package's
 * prebuild/precheck-types/pretest/pretest:watch hooks.
 *
 * Why a check instead of an unconditional `generate:ui`: since #1940 every
 * apps `build` / `check-types` / `test` used to re-run three Vite builds even
 * when no UI source had changed. Under turbo the `generate:ui` task (see
 * ../turbo.json) produces the files ahead of build/check-types/test and is
 * cached on its inputs, so by the time a hook fires the files already exist
 * and this exits without doing anything. Outside turbo — a fresh clone, CI's
 * `pnpm -r … test` shard path, `pnpm --filter @agentproto/apps build` — the
 * files may genuinely be missing, and then (and only then) this falls back to
 * the real `generate:ui`, so a plain package-manager invocation still works
 * with no turbo in the loop.
 *
 * Existence is the right staleness proxy here: the files are gitignored build
 * artifacts, so nothing else can deliver a stale copy into a checkout, and
 * anyone editing the panel UI sources regenerates through `generate:ui` /
 * `dev` rather than through this gate. The `build:ui*:check` scripts remain
 * the opt-in "is what's on disk what the sources produce?" check.
 */
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, "..")

const GENERATED = [
  "src/work-board/panel.generated.ts",
  "src/review-panel/panel.generated.ts",
  "src/store/panel.generated.ts",
]

const missing = GENERATED.filter((rel) => !existsSync(join(pkgRoot, rel)))
if (missing.length === 0) process.exit(0)

console.error(`[ensure-ui-generated] missing ${missing.join(", ")} — running generate:ui`)

const result = spawnSync("pnpm", ["run", "generate:ui"], {
  cwd: pkgRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
})
process.exit(result.status ?? 1)
