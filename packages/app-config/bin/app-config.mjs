#!/usr/bin/env node
// app-config CLI — thin wrapper over runCli (packages/app-config/src/cli.ts).
// The config module is TypeScript, so run through node --experimental-strip-types
// (Node >= 22.6), tsx, or a loader that can import TS.
//   node --experimental-strip-types bin/app-config.mjs check app.config.ts

const argv = process.argv.slice(2)
const configIdx = argv.findIndex((a) => !a.startsWith("-"))

if (configIdx < 0 || argv[configIdx + 1] === undefined) {
  console.error(
    "usage: app-config <check|schema|contracts|verify> [--root <dir>] [--check] [--contracts-dir <dir>] <app.config.ts>",
  )
  process.exit(2)
}

const { runCli } = await import("../dist/cli.mjs")

process.exit(await runCli({ argv }))
