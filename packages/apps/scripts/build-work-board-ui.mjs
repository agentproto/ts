#!/usr/bin/env node
/**
 * Builds the work-board panel's Vite app (src/work-board/ui/**) into a
 * single-file HTML document (vite-plugin-singlefile) and writes it into the
 * COMMITTED generated module src/work-board/panel.generated.ts, which
 * panel.ts re-exports as `WORK_BOARD_HTML` — see that file's docblock for
 * why the generated file is committed rather than built at install time
 * (packages/apps must still build with plain `pnpm build`, no Vite step in
 * the critical path).
 *
 * `--check` (used by CI, see the root `.github/workflows/ci.yml` "Check
 * work-board UI drift" step) rebuilds into a scratch directory and diffs
 * the result against the committed file instead of overwriting it, so a
 * UI change that forgot to regenerate — or a hand-edit of the generated
 * file — fails the gate instead of shipping stale/drifted html.
 */
import { build } from "vite"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

const here = dirname(fileURLToPath(import.meta.url))
const uiRoot = join(here, "../src/work-board/ui")
const generatedPath = join(here, "../src/work-board/panel.generated.ts")

const checkOnly = process.argv.includes("--check")

// Vite's html plugin always tags the bundled entry `<script type="module"
// crossorigin>` regardless of vite.config.ts's `rollupOptions.output.format:
// "iife"` — that option controls the BUNDLE's own wrapping (confirmed: the
// output is already a self-contained `(function(){"use strict";...})()`
// with no import/export left in it), not the tag Vite writes around it.
// Since the bundle has no module semantics left to lose, the leftover
// `type="module"` is cosmetic but not free: it's what makes hosts that only
// execute classic scripts (jsdom — used by this package's own render smoke
// test — deliberately does not implement `type="module"` execution) skip
// the panel's logic entirely, rendering a dead shell. Rewritten to a plain
// classic script here, once. `defer` would be a no-op either way — per the
// HTML spec it only affects a script with a `src`, never an inline one — so
// main.ts itself guards its DOM access with a `document.readyState` check
// instead of relying on load-order tricks here: vite-plugin-singlefile
// relocates the inlined script into `<head>`, ahead of the `<body>` markup
// it reads (`document.getElementById("columns")` etc.), and a module
// script's own implicit defer no longer applies once this is classic.
const MODULE_SCRIPT_TAG_RE = /<script\s+type="module"\s+crossorigin\s*>/

async function buildSingleFileHtml(outDir) {
  await build({
    root: uiRoot,
    logLevel: "warn",
    build: {
      outDir,
      emptyOutDir: true,
    },
  })
  const html = await readFile(join(outDir, "index.html"), "utf8")
  if (!MODULE_SCRIPT_TAG_RE.test(html)) {
    throw new Error(
      "[build-work-board-ui] expected exactly one `<script type=\"module\" crossorigin>` tag " +
        "to rewrite to a classic script — Vite's html output shape may have changed; " +
        "update MODULE_SCRIPT_TAG_RE in this script.",
    )
  }
  return html.replace(MODULE_SCRIPT_TAG_RE, "<script>")
}

function renderModule(html) {
  return `/**
 * @generated — DO NOT EDIT BY HAND.
 *
 * Built from src/work-board/ui/** (Vite + vite-plugin-singlefile) by
 * scripts/build-work-board-ui.mjs. Edit the Vite sources and regenerate:
 *
 *   pnpm --filter @agentproto/apps run build:ui
 *
 * \`pnpm --filter @agentproto/apps run build:ui:check\` (wired into CI) fails
 * if this file drifts from what the Vite sources actually produce.
 */

export const WORK_BOARD_HTML_GENERATED = ${JSON.stringify(html)}
`
}

const scratchDir = await mkdtemp(join(tmpdir(), "work-board-ui-"))
try {
  const html = await buildSingleFileHtml(scratchDir)
  const rendered = renderModule(html)

  if (checkOnly) {
    const current = await readFile(generatedPath, "utf8").catch(() => "")
    if (current !== rendered) {
      console.error(
        "[build-work-board-ui] src/work-board/panel.generated.ts is stale relative to " +
          "src/work-board/ui/** — run `pnpm --filter @agentproto/apps run build:ui` and commit the result.",
      )
      process.exitCode = 1
    } else {
      console.log("[build-work-board-ui] panel.generated.ts is up to date.")
    }
  } else {
    await writeFile(generatedPath, rendered)
    console.log(`[build-work-board-ui] wrote ${generatedPath}`)
  }
} finally {
  await rm(scratchDir, { recursive: true, force: true })
}
