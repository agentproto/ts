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
import { runImportWeb } from "./commands/import-web.js"
import { runDistill } from "./commands/distill.js"
import { runKnowledge } from "./commands/knowledge.js"
import { runSync } from "./commands/sync.js"
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
  import-web [path] --urls-file <f> [--max n --throttle ms --tags t --lang l --force --diarize]
                                         Import URLs as sources (video→Whisper, article→
                                         readability). Resumable: skips already-ingested
                                         URLs, so re-run with --max N to batch through.
                                         --diarize: AssemblyAI speaker labels (interviews).
  distill [path] [--source id --max n --throttle ms --model m]
                                         Distill raw sources → refined entries
                                         (principle/pattern/…) with sources:[id] provenance.
                                         Resumable: skips already-distilled sources.
  knowledge [path] --tags a,b [--kind k --access scope --max n]
                                         Preview what a skill's knowledge: binding resolves to
                                         — refined entries + their provenance (filesystem).
  sync [path] --config <sink.json> [--tags a,b --kind k --throttle ms]
                                         Push refined entries to an external store via a
                                         config-driven MCP sink (host-agnostic).
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
    case "import-web":
      return await runImportWeb(rest)
    case "distill":
      return await runDistill(rest)
    case "knowledge":
      return await runKnowledge(rest)
    case "sync":
      return await runSync(rest)
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
