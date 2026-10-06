#!/usr/bin/env node
/**
 * Builds the store panel's Vite app (src/store/ui/**) into a single-file
 * HTML document (vite-plugin-singlefile) and writes it into the COMMITTED
 * generated module src/store/panel.generated.ts, which panel.ts re-exports
 * as `STORE_HTML` — the exact pattern build-work-board-ui.mjs established;
 * see that script's docblock for the why (no Vite step in the critical
 * build path) and the `--check` / MODULE_SCRIPT_TAG_RE contract, both of
 * which this script shares verbatim for the drift gate to stay uniform.
 */
import { build } from "vite"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

const here = dirname(fileURLToPath(import.meta.url))
const uiRoot = join(here, "../src/store/ui")
const generatedPath = join(here, "../src/store/panel.generated.ts")

const checkOnly = process.argv.includes("--check")

// Vite's html plugin always tags the bundled entry `<script type="module"
// crossorigin>` regardless of the config's `output.format: "iife"` — the
// bundle is already a self-contained `(function(){"use strict";...})()` with
// no import/export left in it — so it's cosmetic but not free: it's what
// makes hosts that only execute classic scripts (jsdom, used by this
// package's own render smoke test) skip the panel's logic entirely.
// Rewritten to a plain classic script here, once. Same reason
// build-work-board-ui.mjs does it.
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
      "[build-store-ui] expected exactly one `<script type=\"module\" crossorigin>` tag " +
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
 * Built from src/store/ui/** (Vite + vite-plugin-singlefile) by
 * scripts/build-store-ui.mjs. Edit the Vite sources and regenerate:
 *
 *   pnpm --filter @agentproto/apps run build:ui:store
 *
 * \`pnpm --filter @agentproto/apps run build:ui:store:check\` (wired into CI)
 * fails if this file drifts from what the Vite sources actually produce.
 */

export const STORE_HTML_GENERATED = ${JSON.stringify(html)}
`
}

const scratchDir = await mkdtemp(join(tmpdir(), "store-ui-"))
try {
  const html = await buildSingleFileHtml(scratchDir)
  const rendered = renderModule(html)

  if (checkOnly) {
    const current = await readFile(generatedPath, "utf8").catch(() => "")
    if (current !== rendered) {
      console.error(
        "[build-store-ui] src/store/panel.generated.ts is stale relative to " +
          "src/store/ui/** — run `pnpm --filter @agentproto/apps run build:ui:store` and commit the result.",
      )
      process.exitCode = 1
    } else {
      console.log("[build-store-ui] panel.generated.ts is up to date.")
    }
  } else {
    await writeFile(generatedPath, rendered)
    console.log(`[build-store-ui] wrote ${generatedPath}`)
  }
} finally {
  await rm(scratchDir, { recursive: true, force: true })
}
