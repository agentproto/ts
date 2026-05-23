#!/usr/bin/env node
/**
 * Copy raw sidecar files into `dist/` after tsup finishes.
 *
 * Some files we ship aren't TypeScript entries — they're raw .mjs +
 * .d.mts pairs that downstream packages need to read as TEXT
 * (e.g. runtime-profile-standard inlining the mention parser into a
 * Claude Code hook). tsup's `onSuccess` hook races with the DTS step
 * and unreliably preserves files it didn't generate, so we copy
 * outside the tsup pipeline via a `postbuild` script.
 */

import { copyFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, "..")

const sidecars = [
  ["src/util/mention-parser.mjs", "dist/util/mention-parser.mjs"],
  ["src/util/mention-parser.d.mts", "dist/util/mention-parser.d.mts"],
]

for (const [src, dst] of sidecars) {
  const srcAbs = resolve(pkgRoot, src)
  const dstAbs = resolve(pkgRoot, dst)
  mkdirSync(dirname(dstAbs), { recursive: true })
  copyFileSync(srcAbs, dstAbs)
  process.stderr.write(`copy-sidecars: ${src} → ${dst}\n`)
}
