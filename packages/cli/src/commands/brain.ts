/**
 * `agentproto brain query` — fuzzy (BM25) search over ingested session
 * transcripts, read from the daemon's `GET /brain/query` route (the same
 * engine the `workspace_brain_query` MCP tool queries).
 *
 * The daemon splits its transcript corpus across MULTIPLE per-workspace
 * brains (default / agentproto / agentik-studio / ...), so `--workspace`
 * defaults to `all` — the daemon federates every registered brain, tags
 * each hit with the workspace it came from, and returns the merged top-K.
 * Pass a specific slug to scope the search to one brain instead.
 *
 * Usage:
 *   agentproto brain query "<query>" [--workspace <slug|all>] [--topk <n>] [--json]
 */
import {
  discoverDaemon,
  httpGetJson,
  printNoDaemonError,
} from "./_daemon-helpers.js"

export interface BrainQueryHit {
  readonly sourceId: string
  readonly workspace: string
  readonly sessionId?: string
  readonly title?: string
  readonly score: number
  readonly snippet: string
}

export interface BrainQueryResult {
  readonly workspace: string
  readonly hits: readonly BrainQueryHit[]
  readonly workspacesErrored?: readonly string[]
}

const USAGE = `agentproto brain — search session transcripts across every workspace brain

Usage:
  agentproto brain query "<query>" [--workspace <slug|all>] [--topk <n>] [--json]

  <query>            required — natural-language / keyword search string
  --workspace <s>    optional — a workspace slug, or "all" (default).
                     "all" federates every registered workspace brain
                     (plus the implicit "default" bucket); a named slug
                     scopes the search to just that one brain.
  --topk <n>         optional — max hits to return (1..50). Default 10.
  --json             optional — print the raw JSON response

Examples:
  agentproto brain query "brain search design"
  agentproto brain query "worktree gc" --workspace agentik-studio --topk 5
  agentproto brain query "flaky test" --json
`

export async function runBrain(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = argv[0]
  if (sub === "query") return runBrainQuery(argv.slice(1))

  if (!sub) {
    process.stderr.write("agentproto brain: missing subcommand\n\n" + USAGE)
    return 2
  }
  process.stderr.write(
    `agentproto brain: unknown subcommand "${sub}"\n  Known: query\n`,
  )
  return 2
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  if (i === -1) return undefined
  return argv[i + 1]
}

async function runBrainQuery(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json")
  const workspace = flagValue(argv, "--workspace") ?? "all"
  const topk = flagValue(argv, "--topk")
  // The first token that isn't a flag or a flag's value is the query.
  // Simplest robust rule for this small flag set: drop --json, then
  // drop --workspace/--topk and whatever immediately follows each.
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === "--json") continue
    if (tok === "--workspace" || tok === "--topk") {
      i++ // skip its value too
      continue
    }
    if (tok !== undefined) positionals.push(tok)
  }
  const query = positionals[0]

  if (!query) {
    process.stderr.write(
      "agentproto brain query: missing required <query>\n\n" + USAGE,
    )
    return 2
  }

  let topKNum: number | undefined
  if (topk !== undefined) {
    topKNum = Number.parseInt(topk, 10)
    if (!Number.isFinite(topKNum) || topKNum < 1 || topKNum > 50) {
      process.stderr.write(
        `agentproto brain query: --topk must be an integer 1..50, got "${topk}"\n`,
      )
      return 2
    }
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto brain query")
    return 1
  }
  const endpoint = report.found

  let url = `${endpoint.url}/brain/query?q=${encodeURIComponent(query)}&workspace=${encodeURIComponent(workspace)}`
  if (topKNum !== undefined) url += `&topK=${topKNum}`

  let result: BrainQueryResult
  try {
    result = await httpGetJson<BrainQueryResult>(url)
  } catch (err) {
    process.stderr.write(
      `agentproto brain query: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }

  printHuman(result)
  return 0
}

function printHuman(result: BrainQueryResult): void {
  if (result.hits.length === 0) {
    process.stdout.write(`No hits in workspace "${result.workspace}".\n`)
    return
  }
  const lines: string[] = []
  for (const hit of result.hits) {
    const label = hit.title ?? hit.sessionId ?? hit.sourceId
    lines.push(
      `${hit.score.toFixed(2)}  ${hit.workspace}  ${hit.sessionId ?? hit.sourceId}  ${label}`,
    )
    lines.push(`    ${hit.snippet.replace(/\n/g, " ").trim()}`)
  }
  if (result.workspacesErrored && result.workspacesErrored.length > 0) {
    lines.push("", `(workspaces skipped due to an error: ${result.workspacesErrored.join(", ")})`)
  }
  process.stdout.write(lines.join("\n") + "\n")
}
