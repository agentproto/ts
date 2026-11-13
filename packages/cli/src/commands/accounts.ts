/**
 * `agentproto accounts slots|swap` — account slots (`accountSlots` in
 * config.json, AIP-46 access axis).
 *
 * Thin CLI wrapper over the daemon's `account_slots_list` /
 * `account_slots_swap` MCP tools (`packages/runtime/src/account-slot-tools.ts`),
 * so the CLI and an agent share one implementation.
 */

import { parseArgs } from "node:util"
import { createDaemonMcpClientGetter, resolveDaemonMcpUrl } from "../app-serve.js"

const USAGE = `Usage:
  agentproto accounts slots [--json]
      List the account slots (config.json accountSlots): each slot, the auth
      profile it points at, and the ALIVE sessions on it.

  agentproto accounts swap <family> [--move-alive] [--dry-run] [--json]
      Exchange <family>-primary and <family>-secondary (e.g. "claude": swaps
      claude-primary and claude-secondary). New spawns, restarts and turnRetry
      fallbacks naming slot:<family>-primary then land on the other account.
      --move-alive also restarts, with their context, the ALIVE sessions
      billing the departing primary account (through the slot or by naming the
      profile literally) onto slot:<family>-primary. Dead sessions are never
      restarted. --dry-run prints what would change and writes nothing.
`

interface SlotRow {
  slot: string
  profileRef: string
  problem?: "missing" | "disabled"
  aliveSessions: Array<{ id: string; label: string; via: "slot" | "profile" }>
}

interface SwapResult {
  family: string
  dryRun: boolean
  before: { primary: string; secondary: string }
  after: { primary: string; secondary: string }
  moved: Array<{ from: string; to?: string; label: string; rearmedCrons?: string[] }>
  failed: Array<{ id: string; label: string; error: string }>
}

async function callTool(
  verb: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: number; value?: unknown }> {
  let content: { type: string; text?: string }[] = []
  let isError = false
  try {
    const client = await createDaemonMcpClientGetter(await resolveDaemonMcpUrl(), "agentproto-accounts")()
    try {
      const res = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean
        content?: { type: string; text?: string }[]
      }
      isError = res.isError === true
      content = res.content ?? []
    } finally {
      await client.close?.().catch(() => {})
    }
  } catch (err) {
    process.stderr.write(
      `agentproto accounts ${verb}: could not reach the daemon (${err instanceof Error ? err.message : String(err)}). ` +
        "Start it first: agentproto serve.\n",
    )
    return { code: 1 }
  }
  const text = content.find(c => c.type === "text" && typeof c.text === "string")?.text
  let parsed: unknown
  try {
    parsed = text !== undefined ? JSON.parse(text) : undefined
  } catch {
    parsed = text
  }
  const errorMessage =
    parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === false
      ? String((parsed as { message?: unknown; error?: unknown }).message ?? (parsed as { error?: unknown }).error)
      : undefined
  if (isError || errorMessage !== undefined) {
    process.stderr.write(`agentproto accounts ${verb}: ${errorMessage ?? text ?? "daemon returned an error"}\n`)
    return { code: 1 }
  }
  return { code: 0, value: parsed }
}

async function runSlots(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })
  const { code, value } = await callTool("slots", "account_slots_list", {})
  if (code !== 0) return code
  const rows = ((value as { slots?: SlotRow[] } | undefined)?.slots ?? []) as SlotRow[]
  if (values.json) {
    process.stdout.write(JSON.stringify({ slots: rows }, null, 2) + "\n")
    return 0
  }
  if (rows.length === 0) {
    process.stdout.write(
      "no account slot is defined. Set one with: agentproto config set accountSlots.claude-primary <profile-id>\n",
    )
    return 0
  }
  for (const row of rows) {
    const problem = row.problem ? ` (profile ${row.problem})` : ""
    process.stdout.write(`${row.slot} -> ${row.profileRef}${problem}: ${row.aliveSessions.length} alive session(s)\n`)
    for (const s of row.aliveSessions) {
      process.stdout.write(`  ${s.id} (${s.label})${s.via === "profile" ? " [names the profile literally]" : ""}\n`)
    }
  }
  return 0
}

async function runSwap(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "move-alive": { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const family = positionals[0]
  if (!family || positionals.length > 1) {
    process.stderr.write(`agentproto accounts swap: exactly one <family> is required (e.g. claude).\n\n${USAGE}`)
    return 2
  }
  const { code, value } = await callTool("swap", "account_slots_swap", {
    family,
    ...(values["move-alive"] ? { moveAlive: true } : {}),
    ...(values["dry-run"] ? { dryRun: true } : {}),
  })
  if (code !== 0) return code
  const result = value as SwapResult
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return result.failed.length > 0 ? 1 : 0
  }
  const verb = result.dryRun ? "would swap" : "swapped"
  process.stdout.write(
    `agentproto accounts swap: ${verb} ${family}-primary ${result.before.primary} -> ${result.after.primary}, ` +
      `${family}-secondary ${result.before.secondary} -> ${result.after.secondary}\n`,
  )
  if (values["move-alive"]) {
    if (result.moved.length === 0 && result.failed.length === 0) {
      process.stdout.write(`  no alive session on "${result.before.primary}" to move\n`)
    }
    for (const row of result.moved) {
      process.stdout.write(
        result.dryRun
          ? `  would restart ${row.from} (${row.label}) onto slot:${family}-primary\n`
          : `  restarted ${row.from} (${row.label}) -> ${row.to}\n`,
      )
      for (const jobId of row.rearmedCrons ?? []) process.stdout.write(`    re-armed cron job ${jobId}\n`)
    }
    for (const row of result.failed) {
      process.stderr.write(`  ${row.id} (${row.label}) failed: ${row.error}\n`)
    }
  }
  return result.failed.length > 0 ? 1 : 0
}

export async function runAccounts(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(USAGE)
    return args.length === 0 ? 2 : 0
  }
  const sub = args[0]
  if (sub === "slots") return runSlots(args.slice(1))
  if (sub === "swap") return runSwap(args.slice(1))
  process.stderr.write(`agentproto accounts: unknown subcommand "${sub}"\n\n${USAGE}`)
  return 2
}
