/**
 * `agentproto provider-preset list [--json]`
 *
 * List built-in provider gateway presets (moonshot, openrouter, …) with their
 * live status in the daemon's environment. Presets are static data — no install
 * or setup; "ready" means the provider's API-key env var is set where the daemon
 * runs (i.e. where agents spawn), "available" means it isn't (set it to use).
 *
 * Discovers the daemon via ~/.agentproto/runtime.json (same pattern as
 * `agentproto tunnel list`) and hits GET /presets. The daemon answers from its
 * own process.env, so the status reflects what a spawned agent would actually
 * see — not the CLI caller's shell.
 */
import { parseArgs } from "node:util"
import type { AdapterEntry } from "@agentproto/provider-kit"
import type { PresetInfo } from "@agentproto/runtime"
import {
  discoverDaemon,
  printNoDaemonError,
  httpGetJson,
} from "./_daemon-helpers.js"

const USAGE = `agentproto provider-preset — list built-in provider gateway presets

Usage:
  agentproto provider-preset list [--json]

Lists the Anthropic-compatible gateway presets shipped in
@agentproto/provider-presets (moonshot, openrouter, …). Each preset is static
data a claude-code / claude-sdk agent can front via a mode or the base_url
option. Status reflects the DAEMON's environment (where agents spawn):

  ready      the preset's API-key env var is set (e.g. MOONSHOT_API_KEY)
  available  env var not set — set it to make the preset ready

No install or setup step exists for presets; there is no creds store. To use a
preset that shows "available", export its key env var in the daemon's
environment (or pass an auth_token at spawn).

Examples:
  agentproto provider-preset list
  agentproto provider-preset list --json
`

export async function runProviderPresets(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const sub = args[0]
  if (sub === "list") return runList(args.slice(1))

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto provider-preset: unknown subcommand "${sub}"\n` +
      `  Known: list\n`,
  )
  return 2
}

// ── list ──────────────────────────────────────────────────────────────

async function runList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      json: { type: "boolean" },
    },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto provider-preset list")
    return 2
  }
  const endpoint = report.found

  let result: { presets: AdapterEntry<PresetInfo>[] }
  try {
    result = await httpGetJson<{ presets: AdapterEntry<PresetInfo>[] }>(
      `${endpoint.url}/presets`,
    )
  } catch (err) {
    process.stderr.write(
      `agentproto provider-preset list: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const presets = result.presets ?? []
  if (values.json) {
    process.stdout.write(JSON.stringify(presets, null, 2) + "\n")
    return 0
  }

  if (presets.length === 0) {
    process.stdout.write("No presets.\n")
    return 0
  }

  process.stdout.write(
    `${"ID".padEnd(12)}  ${"STATUS".padEnd(10)}  ${"SCHEMA".padEnd(10)}  ${"KEY ENV".padEnd(22)}  ${"DEFAULT MODEL".padEnd(18)}  BASE URL\n`,
  )
  for (const p of presets) {
    const info = p.info
    process.stdout.write(
      `${p.slug.padEnd(12)}  ${p.status.padEnd(10)}  ` +
        `${(info?.schemaFlavor ?? "").padEnd(10)}  ` +
        `${(info?.keyEnv ?? "").padEnd(22)}  ` +
        `${(info?.defaultModel ?? "—").padEnd(18)}  ` +
        `${info?.baseUrl ?? ""}\n`,
    )
  }
  return 0
}

/** @deprecated Use {@link runProviderPresets}. Kept for the legacy plural CLI alias. */
export const runPresets = runProviderPresets
