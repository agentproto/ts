import { type ExitCode, type Io, UsageError, err, out } from "./io"
import { runConnectors } from "./commands/connectors"
import { runDoctor } from "./commands/doctor"
import { runExport } from "./commands/export"
import { runInit } from "./commands/init"
import { runRuns, runStatus } from "./commands/inspect"
import { runReparse } from "./commands/reparse"
import { runResume, runRun } from "./commands/run"
import { classify } from "./commands/shared"
import { VERSION } from "./version"

export type { ExitCode }

export function defaultIo(): Io {
  return { stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() }
}

const HELP = `collect: collect public posts and articles with provenance (v${VERSION})

Commands:
  init <store>                 Create a store
  connectors                   List the connectors that are registered or loaded
  doctor [recipe.yaml]         Check connectors: access level, secret (name only), transports
                               [--source id]... (default: every registered connector)
  run [recipe.yaml]            Run a recipe
                               [--source id]... [--query text]... [--subject label] [--max n]
                               [--dry-run] [--store path]
                               Without a recipe, --source (and --query with --subject) makes a trial run.
  resume <runId>               Continue an interrupted run (done tasks are not fetched again)
  runs                         List the runs of a store
  status <runId>               Task states and report of one run
  export                       Items as JSONL (default) or --format csv
                               [--source id] [--out file]
  reparse --into <new store>   Rebuild items, observations, actors and pickups from stored raws.
                               No network; the source store is never modified.

Options on every command:
  --json         machine output on stdout (progress stays on stderr)
  --store path   store to use (default: $COLLECT_STORE or ./collect-store)
  --connector f  load connector modules from a file (repeatable; also "connectors:" in a recipe)
  -q, --quiet    no progress on stderr
  -h, --help     this help

Exit codes: 0 success, 1 partial failure, 2 usage error, 3 store locked or unreadable.
`

const COMMANDS: Record<string, (argv: string[], io: Io) => Promise<ExitCode>> = {
  init: runInit,
  connectors: runConnectors,
  doctor: runDoctor,
  run: runRun,
  resume: runResume,
  runs: runRuns,
  status: runStatus,
  export: runExport,
  reparse: runReparse,
}

/** Run the CLI in-process. Returns the exit code; never calls `process.exit`. */
export async function main(argv: string[], io: Io = defaultIo()): Promise<ExitCode> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    out(io, HELP)
    return cmd ? 0 : 2
  }
  if (cmd === "--version" || cmd === "-v") {
    out(io, VERSION)
    return 0
  }
  const run = COMMANDS[cmd]
  if (!run) {
    err(io, `collect: unknown command "${cmd}". Try --help.`)
    return 2
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    out(io, HELP)
    return 0
  }
  try {
    return await run(rest, io)
  } catch (e) {
    const c = classify(e)
    if (c) {
      err(io, `collect: ${c.message}`)
      return c.code
    }
    err(io, `collect: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

export { UsageError }
