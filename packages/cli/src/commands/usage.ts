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
 *   agentproto usage plan <usage> [--cwd <dir>] [--adapter <slug>] [--json]
 */
import { parseArgs } from "node:util"
import type { UsageBucket, UsageRollup } from "@agentproto/runtime"
import {
  resolveUsagePlan,
  listUsageSlugs,
  UnknownUsageError,
  SensitivityRefusalError,
} from "@agentproto/usage-presets"
import {
  discoverDaemon,
  httpGetJson,
  printNoDaemonError,
} from "./_daemon-helpers.js"

const USAGE = `agentproto usage — local spend estimate + usage-named spawn plans

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

Usage-named spawn plans (the caller names the WORK, never the model or
the execution place — @agentproto/usage-presets declares them):

  agentproto usage plan <usage> [--cwd <dir>] [--adapter <slug>] [--json]

  <usage>         one of: pr-fix, explore, implement, review, deploy
                  (pr-fix + review run on the OVH sandbox; explore +
                  implement run locally on a free model until the
                  2-free-agents-local IP limit redirects to the sandbox;
                  deploy is sensitive and refuses any free model)

Examples:
  agentproto usage plan pr-fix --json
  agentproto usage plan implement --cwd ~/ssd/Code/products/agentik/agentik-studio
`

/** A slim row of GET /sessions?onlyAlive=true — only what the limiter reads. */
interface SessionRow {
  id: string
  alive?: boolean
  remote?: boolean
  model?: string
}

/**
 * Count the LIVE sessions already running a FREE model as a LOCAL
 * subprocess (the daemon's session list proves it: alive + `remote`
 * absent + model ending `-free`).
 */
export function countFreeLocalSessions(rows: readonly SessionRow[]): number {
  return rows.filter(
    r =>
      r.alive === true &&
      r.remote !== true &&
      typeof r.model === "string" &&
      r.model.endsWith("-free"),
  ).length
}

export async function runUsage(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = argv[0]
  if (sub === "rollup") return runRollup(argv.slice(1))
  if (sub === "plan") return runPlan(argv.slice(1))

  if (!sub) {
    process.stderr.write("agentproto usage: missing subcommand\n\n" + USAGE)
    return 2
  }
  process.stderr.write(
    `agentproto usage: unknown subcommand "${sub}"\n  Known: rollup, plan\n`,
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

  section("by profile", rollup.byProfile, r =>
    r.credits ? `${r.profileRef} · credits ${usd(r.credits.balanceUsd)}` : r.profileRef,
  )
  section("by model", rollup.byModel, r => r.model)
  section("by harness", rollup.byHarness, r => r.harness)

  process.stdout.write(lines.join("\n") + "\n")
}

// ── plan ───────────────────────────────────────────────────────────────

async function runPlan(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      cwd: { type: "string" },
      adapter: { type: "string" },
    },
  })

  const usageSlug = argv[0] && !argv[0]!.startsWith("-") ? argv[0]! : undefined
  if (!usageSlug) {
    process.stderr.write(
      `agentproto usage plan: missing required <usage> — one of: ${listUsageSlugs().join(", ")}\n\n` + USAGE,
    )
    return 2
  }

  // Count the live free-local sessions BEFORE resolving: the resolver
  // redirects the overflowing free agent to the sandbox (usage plan is
  // read-only here, so nothing changes while we count).
  let freeLocalInUse = 0
  let daemonFound = false
  const report = await discoverDaemon()
  if (report.found) {
    daemonFound = true
    try {
      const rows = await httpGetJson<SessionRow[]>(`${report.found.url}/sessions?onlyAlive=true`)
      freeLocalInUse = countFreeLocalSessions(rows)
    } catch {
      freeLocalInUse = 0
    }
  }

  let plan
  try {
    plan = resolveUsagePlan(usageSlug, {
      freeLocalInUse,
      ...(values.adapter ? { adapter: values.adapter } : {}),
    })
  } catch (err) {
    if (err instanceof SensitivityRefusalError) {
      process.stderr.write(`agentproto usage plan: REFUS — ${err.message}\n`)
      return 3
    }
    if (err instanceof UnknownUsageError) {
      process.stderr.write(`agentproto usage plan: ${err.message}\n`)
      return 2
    }
    throw err
  }

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          usage: plan.usage,
          daemon: daemonFound,
          freeLocalInUse,
          plan,
        },
        null,
        2,
      ) + "\n",
    )
    return 0
  }

  const lines: string[] = []
  lines.push(`usage "${plan.usage}"`)
  lines.push(`place    : ${plan.place}${plan.sandbox ? ` (${plan.sandbox.provider})` : ""}`)
  lines.push(`model    : ${plan.resolvedModel}`)
  lines.push(`profile  : ${plan.profileRef}`)
  lines.push(`posture  : ${plan.posture}`)
  if (values.cwd) lines.push(`cwd      : ${values.cwd}`)
  lines.push("")
  lines.push("agent_start input (the complete configuration; nothing else to remember):")
  lines.push(JSON.stringify(
    { ...(plan.spawn as Record<string, unknown>), ...(values.cwd ? { cwd: values.cwd } : {}) },
    null,
    2,
  ))
  lines.push("")
  lines.push(`ready-to-paste: agentproto sessions start "${plan.usage}"-spawn ... or the agent_start tool with the input above`)
  if (plan.warning) lines.push("", `⚠ ${plan.warning}`)
  if (!plan.warning) lines.push("", "(règles appliquées : jamais de modèle gratuit pour un usage sensible ; au plus 2 agents gratuits en local, repli sandbox au-delà)")
  process.stdout.write(lines.join("\n") + "\n")
  return 0
}
