#!/usr/bin/env node
/**
 * Builds the review-panel's Vite app (src/review-panel/ui/**) into a
 * single-file HTML document (vite-plugin-singlefile) and writes it into the
 * COMMITTED generated module src/review-panel/panel.generated.ts, which
 * panel.ts re-exports as `REVIEW_PANEL_HTML` — see that file's docblock for
 * why the generated file is committed rather than built at install time
 * (packages/apps must still build with plain `pnpm build`, no Vite step in
 * the critical path). Mirrors scripts/build-work-board-ui.mjs exactly —
 * see that file's comments for the rationale behind each step.
 *
 * `--check` (used by CI) rebuilds into a scratch directory and diffs the
 * result against the committed file instead of overwriting it.
 */
import { build } from "vite"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

const here = dirname(fileURLToPath(import.meta.url))
const uiRoot = join(here, "../src/review-panel/ui")
const generatedPath = join(here, "../src/review-panel/panel.generated.ts")

const checkOnly = process.argv.includes("--check")

// See build-work-board-ui.mjs's matching comment: Vite's html plugin always
// tags the bundled entry `<script type="module" crossorigin>` regardless of
// `rollupOptions.output.format: "iife"` — rewritten to a classic script here
// so jsdom (used elsewhere in this package's test suite) executes it.
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
      "[build-review-panel-ui] expected exactly one `<script type=\"module\" crossorigin>` tag " +
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
 * Built from src/review-panel/ui/** (Vite + vite-plugin-singlefile) by
 * scripts/build-review-panel-ui.mjs. Edit the Vite sources and regenerate:
 *
 *   pnpm --filter @agentproto/apps run build:ui:reviews
 *
 * \`pnpm --filter @agentproto/apps run build:ui:reviews:check\` (wired into
 * CI) fails if this file drifts from what the Vite sources actually produce.
 */

export const REVIEW_PANEL_HTML_GENERATED = ${JSON.stringify(html)}
`
}

const scratchDir = await mkdtemp(join(tmpdir(), "review-panel-ui-"))
try {
  const html = await buildSingleFileHtml(scratchDir)
  const rendered = renderModule(html)

  if (checkOnly) {
    const current = await readFile(generatedPath, "utf8").catch(() => "")
    if (current !== rendered) {
      console.error(
        "[build-review-panel-ui] src/review-panel/panel.generated.ts is stale relative to " +
          "src/review-panel/ui/** — run `pnpm --filter @agentproto/apps run build:ui:reviews` and commit the result.",
      )
      process.exitCode = 1
    } else {
      console.log("[build-review-panel-ui] panel.generated.ts is up to date.")
    }
  } else {
    await writeFile(generatedPath, rendered)
    console.log(`[build-review-panel-ui] wrote ${generatedPath}`)
  }
} finally {
  await rm(scratchDir, { recursive: true, force: true })
}
