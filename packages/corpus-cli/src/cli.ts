#!/usr/bin/env node
/**
 * `corpus` binary entry. Dispatches to subcommands.
 *
 * No commander/yargs to keep dep footprint tight — node:util.parseArgs
 * handles ~90% of what we need, the rest is a 50-line dispatcher.
 *
 * Usage:
 *   corpus init <vertical> [path]
 *   corpus validate [path]
 *   corpus lint [path]
 *   corpus events:emit <kind> --payload <json> [path]
 *   corpus events:tail [path]
 *   corpus --help
 *   corpus --version
 */

import { runInit } from "./commands/init.js"
import { runValidate } from "./commands/validate.js"
import { runLint } from "./commands/lint.js"
import { runEventsEmit, runEventsTail } from "./commands/events.js"
import { VERSION } from "./version.js"

export type ExitCode = 0 | 1 | 2

const HELP = `corpus — AIP-10 corpus workspace operator (v${VERSION})

Commands:
  init <vertical> [path]                 Scaffold a starter workspace
  validate [path]                        JSON Schema check across every AIP file
  lint [path]                            Run lints declared in KNOWLEDGE.md
  events:emit <kind> --payload <json> [path]
                                         Append an event to _log.md
  events:tail [path]                     Print _log.md
  -h, --help                             Show this help
  -v, --version                          Show version

Conventions:
  [path] defaults to the current working directory.
  All commands target the workspace whose root contains KNOWLEDGE.md
  (except 'init' which creates one).
`

async function main(argv: readonly string[]): Promise<ExitCode> {
  const [cmd, ...rest] = argv

  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(HELP)
    return 0
  }
  if (cmd === "-v" || cmd === "--version") {
    process.stdout.write(`corpus v${VERSION}\n`)
    return 0
  }

  switch (cmd) {
    case "init":
      return await runInit(rest)
    case "validate":
      return await runValidate(rest)
    case "lint":
      return await runLint(rest)
    case "events:emit":
      return await runEventsEmit(rest)
    case "events:tail":
      return await runEventsTail(rest)
    default:
      process.stderr.write(`corpus: unknown command "${cmd}". Try --help.\n`)
      return 2
  }
}

const argv = process.argv.slice(2)
main(argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `corpus: unhandled error — ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exit(1)
  })
