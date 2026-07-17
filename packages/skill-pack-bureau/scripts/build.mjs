#!/usr/bin/env node
/**
 * Builds this skill pack from src/skills/ into the two shapes it ships as:
 *
 *  1. npm consumer (`agentproto install skill/<slug> --pack <manifest.name>`,
 *     or the bare npm dual-naming resolver once published): `skills/` +
 *     `.claude-plugin/plugin.json` copied flat to the PACKAGE ROOT, because
 *     pack-resolve.ts's npm lookup treats the resolved node_modules dir
 *     itself as the pack dir — no nested version folder.
 *  2. Claude Code / Anthropic consumer: a self-contained, versioned bundle
 *     directory at dist/<manifest.name>-v<version>/ (what `pack skill`
 *     naturally produces) plus its .zip, both attached to the GitHub
 *     release by .github/workflows/release.yml. Not published to npm —
 *     "files" in package.json only lists skills/ + .claude-plugin/.
 *
 * Both come from ONE call to the shared `runPackSkill` (reused from
 * @agentproto/cli, not reimplemented) plus one directory copy and one zip.
 * The version is this package's own package.json version — changesets'
 * source of truth — never hand-declared in manifest.json.
 */

import { readFile, rm, mkdir, cp } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { runPackSkill, zipPackDir } from "@agentproto/cli"

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))

async function main() {
  const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"))
  const manifest = JSON.parse(await readFile(join(packageDir, "manifest.json"), "utf8"))
  const version = pkg.version

  const stagingOut = join(packageDir, "dist", "staging")
  const code = await runPackSkill([
    "--manifest",
    join(packageDir, "manifest.json"),
    "--out",
    stagingOut,
    "--version",
    version,
  ])
  if (code !== 0) {
    process.exitCode = code
    return
  }

  const bundleDir = join(stagingOut, `${manifest.name}-v${version}`)

  // 1. Flatten skills/ + .claude-plugin/ up to the package root for npm
  //    consumption (pack-resolve.ts expects them there, unversioned).
  for (const entry of ["skills", ".claude-plugin"]) {
    const dest = join(packageDir, entry)
    await rm(dest, { recursive: true, force: true })
    await cp(join(bundleDir, entry), dest, { recursive: true })
  }

  // 2. Zip the self-contained versioned bundle for the Claude Code /
  //    Anthropic consumer — same technique claude-plugin.ts uses at
  //    install time, reused rather than reimplemented.
  const zipDest = join(packageDir, "dist", `${manifest.name}-v${version}.zip`)
  await mkdir(dirname(zipDest), { recursive: true })
  const { zipped, zipPath } = await zipPackDir(bundleDir, zipDest)

  process.stdout.write(
    `${pkg.name}: built skills/ + .claude-plugin/ (v${version})\n` +
      (zipped
        ? `  bundle zip: ${zipPath}\n`
        : `  warning: zip unavailable — bundle dir only: ${bundleDir}\n`),
  )
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`)
  process.exitCode = 1
})
