/**
 * `agentproto quota status [--profile <ref>] [--refresh] [--json]`
 *
 * Thin CLI wrapper over the daemon's `quota_status` MCP tool (AIP-67,
 * `@agentproto/model-intel`) — live provider quota for a named auth profile.
 * `--profile` is required: a plain CLI invocation has no "calling session"
 * for the tool to fall back to (that fallback is for an agent session
 * reading its own access profile). `--refresh` is forwarded as a documented
 * hint only — the tool has no cache, every call already reads live.
 */

import { parseArgs } from "node:util"
import { createDaemonMcpClientGetter, resolveDaemonMcpUrl } from "../app-serve.js"

const USAGE = `Usage:
  agentproto quota status --profile <ref> [--refresh] [--json]

Live provider quota for a named auth profile (an id from
\`agentproto auth profile list\`), read through the daemon's quota_status
MCP tool. --json prints the raw QuotaStatus; without it, a short
human-readable summary (profile, basis, each window, credits if present).
`

interface QuotaWindow {
  id: string
  remainingPct: number
  used?: number
  limit?: number
  remaining?: number
  unit?: string
  resetsAt?: string
}

interface QuotaStatus {
  profileRef: string
  asOf: string
  basis: string
  source?: string
  windows: QuotaWindow[]
  credits?: { balanceUsd?: number; unlimited?: boolean; currency: string }
}

async function closeQuietly(client: { close?: () => Promise<void> }): Promise<void> {
  try {
    await client.close?.()
  } catch {
    // best-effort
  }
}

/** Call the daemon's `quota_status` tool and return its text content (or an
 *  error already printed to stderr, mirroring `callDaemonAppToolRaw` in
 *  app.ts). */
async function callQuotaStatusTool(
  args: Record<string, unknown>,
): Promise<{ code: number; text?: string }> {
  let content: { type: string; text?: string }[] = []
  let isError = false
  try {
    const client = await createDaemonMcpClientGetter(await resolveDaemonMcpUrl(), "agentproto-quota")()
    let res: { isError?: boolean; content?: { type: string; text?: string }[] }
    try {
      res = (await client.callTool({ name: "quota_status", arguments: args })) as typeof res
    } finally {
      await closeQuietly(client)
    }
    isError = res.isError === true
    content = res.content ?? []
  } catch (err) {
    process.stderr.write(
      `agentproto quota status: could not reach the daemon (${err instanceof Error ? err.message : String(err)}). ` +
        `Start it first: agentproto serve.\n`,
    )
    return { code: 1 }
  }
  const text = content.find((c) => c.type === "text" && typeof c.text === "string")?.text
  if (isError) {
    let message = text ?? "daemon returned an error"
    try {
      const parsed = JSON.parse(message) as { error?: unknown; message?: unknown }
      if (typeof parsed.message === "string") message = parsed.message
      else if (typeof parsed.error === "string") message = parsed.error
    } catch {
      // not JSON — print as-is
    }
    process.stderr.write(`agentproto quota status: ${message}\n`)
    return { code: 1 }
  }
  return { code: 0, text }
}

async function runQuotaStatus(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: false,
    options: {
      profile: { type: "string" },
      refresh: { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  if (typeof values.profile !== "string" || values.profile.length === 0) {
    process.stderr.write(`agentproto quota status: --profile <ref> is required.\n\n${USAGE}`)
    return 2
  }

  const { code, text } = await callQuotaStatusTool({
    profileRef: values.profile,
    ...(values.refresh === true ? { refresh: true } : {}),
  })
  if (code !== 0) return code

  const status = JSON.parse(text ?? "{}") as QuotaStatus
  if (values.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n")
    return 0
  }

  process.stdout.write(`profile: ${status.profileRef}\n`)
  process.stdout.write(`basis:   ${status.basis}${status.source ? ` (${status.source})` : ""}\n`)
  for (const w of status.windows) {
    const bits = [
      `${w.remainingPct}% remaining`,
      w.unit ? w.unit : undefined,
      w.resetsAt ? `resets ${w.resetsAt}` : undefined,
    ].filter((b): b is string => b !== undefined)
    process.stdout.write(`  window ${w.id}: ${bits.join(", ")}\n`)
  }
  if (status.credits) {
    const c = status.credits
    process.stdout.write(
      `credits: ${c.unlimited ? "unlimited" : (c.balanceUsd?.toFixed(2) ?? "?")} ${c.currency}\n`,
    )
  }
  return 0
}

export async function runQuota(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return args.length === 0 ? 2 : 0
  }
  const sub = args[0]
  if (sub === "status") return runQuotaStatus(args.slice(1))
  process.stderr.write(`agentproto quota: unknown subcommand "${sub}"\n\n${USAGE}`)
  return 2
}
