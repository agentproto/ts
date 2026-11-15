/**
 * `agentproto accounts slots|swap|prefer|health`: account slots
 * (`accountSlots` in config.json, AIP-46 access axis) and the health of the
 * accounts behind them.
 *
 * Thin CLI wrapper over the daemon's `account_slots_list` /
 * `account_slots_swap` / `account_slots_prefer`
 * (`packages/runtime/src/account-slot-tools.ts`) and `account_health_list` /
 * `account_health_clear` (`account-health-tools.ts`) MCP tools, so the CLI and
 * an agent share one implementation.
 */

import { parseArgs } from "node:util"
import { createDaemonMcpClientGetter, resolveDaemonMcpUrl } from "../app-serve.js"

const USAGE = `Usage:
  agentproto accounts slots [--json]
      List the account slots (config.json accountSlots): each slot, the auth
      profile it points at (for a slot, every account in order with its
      health), and the ALIVE sessions on it.

  agentproto accounts swap <family> [--move-alive] [--dry-run] [--json]
      Exchange <family>-primary and <family>-secondary (e.g. "claude": swaps
      claude-primary and claude-secondary). New spawns, restarts and turnRetry
      fallbacks naming slot:<family>-primary then land on the other account.
      --move-alive also restarts, with their context, the ALIVE sessions
      billing the departing primary account (through the slot or by naming the
      profile literally) onto slot:<family>-primary. Dead sessions are never
      restarted. --dry-run prints what would change and writes nothing.

  agentproto accounts prefer <slot> <profile> [--move-alive] [--dry-run] [--json]
      Put <profile> at the head of the account slot <slot> (the others keep
      their order); new spawns on slot:<slot> prefer it while it is not
      exhausted. --move-alive also restarts, with their context, the ALIVE
      sessions on the slot that bill another account.

  agentproto accounts health [--clear <profile>] [--json]
      Which accounts are exhausted and until when (the daemon's circuit
      breaker): state (ok / exhausted / probing), until, where until came from
      (provider / probe / observed / estimated), the reason. An account
      returns by itself once until has passed; --clear <profile> reopens one
      now (a recharge before until).
`

interface SlotAccountRow {
  profileRef: string
  problem?: "missing" | "disabled"
  health?: { state: string; until: string; untilBasis: string; reason: string; strikes: number }
}

interface SlotRow {
  slot: string
  profileRef: string
  problem?: "missing" | "disabled"
  health?: SlotAccountRow["health"]
  accounts?: SlotAccountRow[]
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
    if (row.accounts) {
      process.stdout.write(`${row.slot} (several accounts, spawns land on ${row.profileRef}): ${row.aliveSessions.length} alive session(s)\n`)
      for (const account of row.accounts) {
        const problem = account.problem ? ` (profile ${account.problem})` : ""
        const health = account.health ? ` [${account.health.state} until ${account.health.until}]` : ""
        process.stdout.write(`  - ${account.profileRef}${problem}${health}\n`)
      }
      for (const s of row.aliveSessions) {
        process.stdout.write(`  ${s.id} (${s.label})${s.via === "profile" ? " [names one of its accounts literally]" : ""}\n`)
      }
      continue
    }
    const problem = row.problem ? ` (profile ${row.problem})` : ""
    const health = row.health ? ` [${row.health.state} until ${row.health.until}]` : ""
    process.stdout.write(`${row.slot} -> ${row.profileRef}${problem}${health}: ${row.aliveSessions.length} alive session(s)\n`)
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

interface PreferResult {
  slot: string
  dryRun: boolean
  before: string[]
  after: string[]
  moved: Array<{ from: string; to?: string; label: string; rearmedCrons?: string[] }>
  failed: Array<{ id: string; label: string; error: string }>
}

async function runPrefer(args: readonly string[]): Promise<number> {
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
  const [slot, profile] = positionals
  if (!slot || !profile || positionals.length > 2) {
    process.stderr.write(`agentproto accounts prefer: a <slot> and a <profile> are required.\n\n${USAGE}`)
    return 2
  }
  const { code, value } = await callTool("prefer", "account_slots_prefer", {
    slot,
    profile,
    ...(values["move-alive"] ? { moveAlive: true } : {}),
    ...(values["dry-run"] ? { dryRun: true } : {}),
  })
  if (code !== 0) return code
  const result = value as PreferResult
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return result.failed.length > 0 ? 1 : 0
  }
  process.stdout.write(
    `agentproto accounts prefer: ${result.dryRun ? "would order" : "ordered"} ${slot}: ` +
      `${result.before.join(", ")} -> ${result.after.join(", ")}\n`,
  )
  for (const row of result.moved) {
    process.stdout.write(
      result.dryRun
        ? `  would restart ${row.from} (${row.label}) onto slot:${slot}\n`
        : `  restarted ${row.from} (${row.label}) -> ${row.to}\n`,
    )
  }
  for (const row of result.failed) process.stderr.write(`  ${row.id} (${row.label}) failed: ${row.error}\n`)
  return result.failed.length > 0 ? 1 : 0
}

interface HealthRow {
  profileRef: string
  state: "ok" | "exhausted" | "probing"
  until?: string
  untilBasis?: string
  reason?: string
  strikes?: number
  slots?: string[]
  quota?: { fetchedAt: string; windows: Record<string, { remaining: number; resetsAt: string }> }
}

async function runHealth(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { clear: { type: "string" }, json: { type: "boolean" } },
  })
  if (values.clear !== undefined) {
    const { code, value } = await callTool("health", "account_health_clear", { profileRef: values.clear })
    if (code !== 0) return code
    const result = value as { profileRef: string; cleared: boolean }
    if (values.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    else {
      process.stdout.write(
        result.cleared
          ? `agentproto accounts health: ${result.profileRef} reopened\n`
          : `agentproto accounts health: ${result.profileRef} had no health entry (already open)\n`,
      )
    }
    return 0
  }
  const { code, value } = await callTool("health", "account_health_list", {})
  if (code !== 0) return code
  const rows = ((value as { accounts?: HealthRow[] } | undefined)?.accounts ?? []) as HealthRow[]
  if (values.json) {
    process.stdout.write(JSON.stringify({ accounts: rows }, null, 2) + "\n")
    return 0
  }
  if (rows.length === 0) {
    process.stdout.write("no account is known yet (no health entry, no account slot)\n")
    return 0
  }
  for (const row of rows) {
    const slots = row.slots?.length ? ` [slot ${row.slots.join(", ")}]` : ""
    if (row.state === "ok") {
      process.stdout.write(`${row.profileRef}: ok${slots}\n`)
    } else {
      process.stdout.write(
        `${row.profileRef}: ${row.state} until ${row.until} (${row.untilBasis}, strike ${row.strikes})${slots}: ${row.reason}\n`,
      )
    }
    for (const [window, q] of Object.entries(row.quota?.windows ?? {})) {
      process.stdout.write(`  quota ${window}: ${q.remaining} remaining, resets ${q.resetsAt} (read ${row.quota!.fetchedAt})\n`)
    }
  }
  return 0
}

export async function runAccounts(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(USAGE)
    return args.length === 0 ? 2 : 0
  }
  const sub = args[0]
  if (sub === "slots") return runSlots(args.slice(1))
  if (sub === "swap") return runSwap(args.slice(1))
  if (sub === "prefer") return runPrefer(args.slice(1))
  if (sub === "health") return runHealth(args.slice(1))
  process.stderr.write(`agentproto accounts: unknown subcommand "${sub}"\n\n${USAGE}`)
  return 2
}
