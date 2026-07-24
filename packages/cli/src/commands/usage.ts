/**
 * `agentproto usage rollup` — a local-derived, provider-agnostic spend
 * ESTIMATE over a rolling window, read from the daemon's `GET /usage/rollup`
 * route (which aggregates the durable per-session usage_snapshot records).
 *
 * `basis` is always `local-estimate`: this is what agentproto priced locally,
 * NOT the provider's actual bill. Tokens for models with no catalog price show
 * up in a separate `unpriced` column rather than a fabricated $0.
 *
 * Usage:
 *   agentproto usage rollup --window <5h|7d|30m|2w|P7D|PT5H> [--profile <ref>] [--json]
 */
import type { UsageBucket, UsageRollup } from "@agentproto/runtime"
import {
  discoverDaemon,
  httpGetJson,
  printNoDaemonError,
} from "./_daemon-helpers.js"

const USAGE = `agentproto usage — local spend estimate over a rolling window

Usage:
  agentproto usage rollup --window <w> [--profile <ref>] [--json]

  --window <w>    required — rolling window: shorthand <int><s|m|h|d|w>
                  (e.g. 5h, 7d, 30m, 2w) or ISO-8601 (P7D, PT5H, P1DT12H)
  --profile <ref> optional — filter to a single auth profile by profileRef
  --json          optional — print the raw rollup JSON

Aggregated from the daemon's durable per-session usage_snapshot records.
basis is always "local-estimate" — what agentproto priced locally, NOT the
provider's bill. Tokens for un-priced models are surfaced separately as
"unpriced", never as a fabricated $0.

Examples:
  agentproto usage rollup --window 7d
  agentproto usage rollup --window 5h --profile claude-max
  agentproto usage rollup --window P1DT12H --json
`

export async function runUsage(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = argv[0]
  if (sub === "rollup") return runRollup(argv.slice(1))

  if (!sub) {
    process.stderr.write("agentproto usage: missing subcommand\n\n" + USAGE)
    return 2
  }
  process.stderr.write(
    `agentproto usage: unknown subcommand "${sub}"\n  Known: rollup\n`,
  )
  return 2
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  if (i === -1) return undefined
  return argv[i + 1]
}

async function runRollup(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json")
  const window = flagValue(argv, "--window")
  const profile = flagValue(argv, "--profile")

  if (!window || window.startsWith("-")) {
    process.stderr.write(
      "agentproto usage rollup: missing required --window <w>\n\n" + USAGE,
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto usage rollup")
    return 1
  }
  const endpoint = report.found

  let url = `${endpoint.url}/usage/rollup?window=${encodeURIComponent(window)}`
  if (profile) url += `&profileRef=${encodeURIComponent(profile)}`

  let rollup: UsageRollup
  try {
    rollup = await httpGetJson<UsageRollup>(url)
  } catch (err) {
    process.stderr.write(
      `agentproto usage rollup: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (json) {
    process.stdout.write(JSON.stringify(rollup, null, 2) + "\n")
    return 0
  }

  printHuman(rollup)
  return 0
}

/** `$1234.5678` — four decimals, enough to see sub-cent estimates without
 *  drowning the line in noise. */
function usd(n: number): string {
  return `$${n.toFixed(4)}`
}

function bucketLine(b: UsageBucket): string {
  return `${usd(b.spentUsd)} · ${b.tokensIn} in / ${b.tokensOut} out tok · ${b.unpricedTokens} unpriced tok`
}

function printHuman(rollup: UsageRollup): void {
  const lines: string[] = []
  lines.push(
    `${rollup.window} · basis: ${rollup.basis} · sessions: ${rollup.sessionsConsidered}`,
  )
  lines.push(`TOTAL  ${bucketLine(rollup.total)}`)

  const section = <T extends UsageBucket>(
    title: string,
    rows: T[],
    label: (row: T) => string,
  ): void => {
    if (rows.length === 0) return
    lines.push("", title)
    for (const row of rows) {
      lines.push(`  ${label(row)}  ${bucketLine(row)}`)
    }
  }

  section("by profile", rollup.byProfile, r => r.profileRef)
  section("by model", rollup.byModel, r => r.model)
  section("by harness", rollup.byHarness, r => r.harness)

  process.stdout.write(lines.join("\n") + "\n")
}
