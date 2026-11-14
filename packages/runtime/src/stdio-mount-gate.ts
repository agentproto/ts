/**
 * AIP-46 stdio mount gate, observe first.
 *
 * A spawn may mount MCP servers (`agent_start.mcpServers`). A `stdio`
 * entry names an arbitrary command the agent CLI launches, so it is
 * command execution outside `.agentproto/allowed-commands.json` unless
 * something evaluates it. This module owns the pure decision, the mode
 * type, and the process-wide observer that counts what the gate would
 * refuse before an operator turns enforcement on.
 *
 * Only the entries the REQUEST names are evaluated: presets, AGENT.md,
 * bundles, config and the daemon's own injected mounts are operator or
 * author configuration, not a request. A spawn with no trusted caller
 * (root spawn, continue-fresh, restart, migrate, cron, retries) is
 * authorised by the host itself and never gated. A sandboxed spawn runs
 * the `stdio` server inside the box, so the host allowlist does not apply.
 *
 * The observer is a module-level singleton on purpose: `spawnAgentSession`
 * is reached from agent-tools, http-server, session-tools and cron, which
 * share no object. Counters live in memory (a restart resets them); the
 * `console.warn` line for a would-deny command is the durable record.
 * Args, env and the full `ref` path never reach the log or the report.
 */

import { basename } from "node:path"

import type { AcpMcpServer } from "@agentproto/acp"

import {
  isCommandAllowed,
  type AllowlistEntry,
} from "./command-allowlist.js"

export type StdioMountGateMode = "off" | "observe" | "enforce"

export const DEFAULT_STDIO_MOUNT_GATE_MODE: StdioMountGateMode = "observe"

/** One `stdio` mount the request names. `command` is the BASENAME of the
 *  entry's `ref`, exactly as `command_execute` derives its `baseName`. */
export interface StdioMountRequest {
  name: string
  command: string
  args: readonly string[]
}

/** What the gate concluded for one spawn. */
export type StdioMountVerdict =
  | "allowed" // every requested stdio mount is admitted by the allowlist
  | "would_deny" // at least one requested stdio mount is not admitted
  | "none" // the request mounts no stdio server
  | "no_caller" // no trusted caller: authorised by the host's own auth, not gated
  | "caller_unknown" // a trusted caller id the registry does not hold (not gated, counted)
  | "external" // a client the daemon did not spawn (AIP-46 rule 7), not gated
  | "sandboxed" // launched inside a sandbox box, so the host allowlist does not apply

/** The `stdio` entries the request names, in order. An `http` or `sse`
 *  entry is never a stdio mount. */
export function stdioMountRequests(
  mcpServers: readonly AcpMcpServer[] | undefined,
): StdioMountRequest[] {
  const out: StdioMountRequest[] = []
  for (const entry of mcpServers ?? []) {
    if (entry.transport !== "stdio") continue
    out.push({
      name: entry.name,
      command: basename(entry.ref ?? ""),
      args: entry.args ?? [],
    })
  }
  return out
}

export interface StdioMountDecisionInput {
  /** Trusted caller session id (callerScope.ownerSessionId, else the
   *  daemon-derived autoParentSessionId). NEVER the caller-supplied
   *  parentSessionId hint. */
  callerSessionId: string | undefined
  /** Whether the registry holds that caller id. */
  callerKnown: boolean
  /** The caller is a `kind: "external"` row: a label the host did not
   *  spawn (AIP-46 rule 7), evaluated as anonymous, so never gated. */
  callerExternal?: boolean
  /** The spawn runs in a sandbox box (`input.sandbox !== undefined`). */
  sandboxed?: boolean
  /** The stdio mounts the REQUEST names. */
  requested: readonly StdioMountRequest[]
  /** The workspace command allowlist (`loadAllowlistEntries`). */
  allowlist: readonly AllowlistEntry[]
}

/** The pure decision. No I/O, no configuration read. */
export function decideStdioMount(input: StdioMountDecisionInput): {
  verdict: StdioMountVerdict
  denied: StdioMountRequest[]
} {
  if (input.callerSessionId === undefined) return { verdict: "no_caller", denied: [] }
  if (!input.callerKnown) return { verdict: "caller_unknown", denied: [] }
  if (input.callerExternal === true) return { verdict: "external", denied: [] }
  if (input.requested.length === 0) return { verdict: "none", denied: [] }
  if (input.sandboxed === true) return { verdict: "sandboxed", denied: [] }
  const denied = input.requested.filter(
    request => !isCommandAllowed(input.allowlist, request.command, request.args),
  )
  return denied.length > 0
    ? { verdict: "would_deny", denied }
    : { verdict: "allowed", denied: [] }
}

export interface StdioMountReport {
  mode: StdioMountGateMode
  /** ISO time this process started counting (resets on a restart: counters are in memory). */
  since: string
  counts: Record<StdioMountVerdict, number>
  /** would_deny commands, most frequent first, at most 50. Basename only. */
  wouldDeny: Array<{ command: string; count: number; lastAt: string }>
}

const MAX_TRACKED = 200
const MAX_REPORT_ROWS = 50

interface CommandObservation {
  count: number
  lastAt: string
}

let since = new Date().toISOString()
let counts: Record<StdioMountVerdict, number> = emptyCounts()
let commands = new Map<string, CommandObservation>()

function emptyCounts(): Record<StdioMountVerdict, number> {
  return {
    allowed: 0,
    would_deny: 0,
    none: 0,
    no_caller: 0,
    caller_unknown: 0,
    external: 0,
    sandboxed: 0,
  }
}

export function recordStdioMount(
  verdict: StdioMountVerdict,
  ctx: {
    mode: StdioMountGateMode
    denied: readonly StdioMountRequest[]
    surface: "scoped" | "mcp"
  },
): void {
  counts[verdict] += 1
  if (verdict !== "would_deny") return
  const at = new Date().toISOString()
  for (const request of ctx.denied) {
    // The basename is the key: `args`, `env` and the full `ref` path can
    // carry tokens and home directories, so they never reach the report.
    const command = request.command
    const existing = commands.get(command)
    if (existing) {
      existing.count += 1
      existing.lastAt = at
    } else if (commands.size < MAX_TRACKED) {
      commands.set(command, { count: 1, lastAt: at })
      // One warning the FIRST time a command is seen; the count carries the rest.
      console.warn(
        `[stdio-mount-gate] ${ctx.mode}: a session mounted stdio server command "${command}" outside the command allowlist (surface ${ctx.surface})`,
      )
    }
    // Past the cap a new command is not tracked, but the verdict still counts.
  }
}

export function stdioMountReport(mode: StdioMountGateMode): StdioMountReport {
  const wouldDeny = [...commands.entries()]
    .map(([command, observation]) => ({ command, ...observation }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_REPORT_ROWS)
  return {
    mode,
    since,
    counts: { ...counts },
    wouldDeny,
  }
}

/** Tests only: forget every observation and restart the `since` clock. */
export function resetStdioMountObservations(): void {
  since = new Date().toISOString()
  counts = emptyCounts()
  commands = new Map()
}
