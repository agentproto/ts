#!/usr/bin/env node
/**
 * start-watchdog — catches a session that never leaves `status:"starting"`.
 *
 * `host-guard` (scripts/host-guard.mjs) closes sessions that already
 * finished a turn and are idle; it explicitly skips `starting` rows ("no
 * turn yet") because a session mid-provisioning (worktree clone, setup
 * hooks, driver spawn) is legitimately silent for a while. The
 * turn-liveness watchdog (`daemon.turnStallAfterMs`, default 5 min) covers
 * the OTHER kind of silence — a `running` + `busy` session whose turn
 * stream went dead. Neither one answers "the session never started in the
 * first place": `agent_spawn`'s background provisioning path
 * (`packages/runtime/src/session-spawn.ts`) has no time-based ceiling — if
 * `git worktree add`, a setup hook, or the driver's own startup hangs
 * (network stall, lock contention, a hung child), the row sits in
 * `starting` forever with nothing to flip it to `running` or `error`.
 *
 * This script is the bootstrap watcher for exactly that gap: it reads
 * `agentproto sessions --json`, flags every `starting` row older than
 * `--threshold` (default 180s / 3 min), and — never both silently —
 * escalates (notifies a session or spawns an agent, same shape as
 * host-guard's escalation) and/or stops the stuck row with `--stop`.
 * Detection-only by default: without `--stop` nothing is killed, only
 * reported/escalated, because a `starting` row has no completed turn to
 * lose, but it MAY be a legitimately slow first-time worktree provision
 * (cold `pnpm install`) rather than a hang — the operator decides whether
 * that's worth auto-killing on this host.
 *
 * Usage:
 *   node scripts/start-watchdog.mjs --dry-run
 *   node scripts/start-watchdog.mjs --notify-session sess_abc
 *   node scripts/start-watchdog.mjs --agent claude-code --stop
 *
 * Env:
 *   START_WATCHDOG_BIN             agentproto binary (default: repo dist if
 *                                  present, else `agentproto` on PATH)
 *   START_WATCHDOG_AGENT           same as --agent
 *   START_WATCHDOG_NOTIFY_SESSION  same as --notify-session
 *
 * Cron (every 1 min — must poll well under the threshold to alert promptly):
 *   * * * * * node /path/to/agentproto/scripts/start-watchdog.mjs --notify-session sess_abc >> ~/.agentproto/start-watchdog.cron.log 2>&1
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "..")
const LOCAL_CLI = join(REPO_ROOT, "packages", "cli", "dist", "cli.mjs")

export const ESCALATION_LABEL_PREFIX = "start-watchdog-"
export const ESCALATION_LABEL = `${ESCALATION_LABEL_PREFIX}escalation`
const DEFAULT_LOG = join(homedir(), ".agentproto", "start-watchdog.log")

const DEFAULTS = {
  thresholdSec: 180,
  maxStop: 5,
}

function usage() {
  return `Usage: node scripts/start-watchdog.mjs [flags]

  --dry-run                decide and log, escalate/stop nothing
  --json                   print the report as JSON
  --threshold <sec>        how long a session may sit in "starting" before
                            it is flagged (${DEFAULTS.thresholdSec})
  --stop                   also stop (kill) flagged sessions, oldest first
  --max-stop <n>           cap on how many to stop in one pass (${DEFAULTS.maxStop})
  --agent <slug>           spawn this adapter to investigate if nothing
                            else is already watching
  --notify-session <id>    prompt this session instead of spawning an agent
  --no-escalate            never notify/spawn, only report (and --stop if set)
  --log <path>             JSONL log (${DEFAULT_LOG})
  --no-log                 no log
  -h, --help

Cron (every 1 min):
  * * * * * node /path/to/agentproto/scripts/start-watchdog.mjs --notify-session sess_abc >> ~/.agentproto/start-watchdog.cron.log 2>&1
`
}

function parseFlags(argv) {
  const out = {
    dryRun: false,
    json: false,
    thresholdSec: DEFAULTS.thresholdSec,
    stop: false,
    maxStop: DEFAULTS.maxStop,
    agent: process.env.START_WATCHDOG_AGENT || undefined,
    notifySession: process.env.START_WATCHDOG_NOTIFY_SESSION || undefined,
    escalate: true,
    log: DEFAULT_LOG,
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${tok} needs a value`)
      return v
    }
    switch (tok) {
      case "--dry-run": out.dryRun = true; break
      case "--json": out.json = true; break
      case "--threshold": {
        const n = Number(next())
        if (!Number.isFinite(n) || n < 0) throw new Error("--threshold expects a number >= 0")
        out.thresholdSec = n
        break
      }
      case "--stop": out.stop = true; break
      case "--max-stop": {
        const n = Number(next())
        if (!Number.isFinite(n) || n < 0) throw new Error("--max-stop expects a number >= 0")
        out.maxStop = n
        break
      }
      case "--agent": out.agent = next(); break
      case "--notify-session": out.notifySession = next(); break
      case "--no-escalate": out.escalate = false; break
      case "--log": out.log = next(); break
      case "--no-log": out.log = null; break
      case "-h":
      case "--help": out.help = true; break
      default: throw new Error(`unknown flag ${tok}`)
    }
  }
  return out
}

function bin() {
  if (process.env.START_WATCHDOG_BIN) return { cmd: process.env.START_WATCHDOG_BIN, prefix: [] }
  if (existsSync(LOCAL_CLI)) return { cmd: process.execPath, prefix: [LOCAL_CLI] }
  return { cmd: "agentproto", prefix: [] }
}

function runAgentproto(args, { json = false } = {}) {
  const { cmd, prefix } = bin()
  const res = spawnSync(cmd, [...prefix, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  })
  if (res.error) throw res.error
  const stdout = res.stdout ?? ""
  const stderr = res.stderr ?? ""
  if (json) {
    try {
      return JSON.parse(stdout)
    } catch {
      throw new Error(`${cmd} ${args.join(" ")} did not return JSON (exit ${res.status}): ${stderr || stdout}`)
    }
  }
  return { status: res.status ?? 1, stdout, stderr }
}

function sessions() {
  const list = runAgentproto(["sessions", "--json"], { json: true })
  if (!Array.isArray(list)) throw new Error("sessions --json did not return an array")
  return list
}

function labelOf(s) {
  return s.label || s.title || s.name || s.id
}

function parseMs(v) {
  if (!v) return undefined
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : undefined
}

function selfSessionIds() {
  return ["AGENTPROTO_SESSION_ID", "AGENTPROTO_PARENT_SESSION_ID"]
    .map(k => process.env[k])
    .filter(Boolean)
}

/**
 * The whole decision, pure over (all, now, thresholdMs, protectedIds): every
 * `starting` row older than the threshold, oldest first. A session is never
 * a candidate when:
 *   - it is this guard's own session (or an ancestor of it);
 *   - its label starts with `start-watchdog-` — the escalation investigator
 *     THIS script spawns is itself a fresh `agent-cli` session that cold-
 *     provisions a worktree, i.e. exactly the "legitimately slow first-time
 *     provision" case; without this exclusion a slow investigator becomes a
 *     candidate on the next sweep and gets killed by the watchdog that spawned
 *     it, which then spawns a replacement — a spawn/kill loop. Mirrors
 *     host-guard's `labelOf(s).startsWith("host-guard-")` guard;
 *   - it is not an `agent-cli` session — a non-agent-cli row (PTY/terminal/
 *     command) has no provisioning path this watchdog understands, same
 *     reasoning as host-guard's `kind !== "agent-cli"` exclusion;
 *   - its `provisioning.state` is `"queued"` — a row throttled behind the
 *     daemon's own concurrency limit is waiting its turn, not hung; stopping
 *     it only makes the queue's backlog worse.
 */
export function select(all, now, thresholdMs, protectedSessionIds) {
  const protectedIds = new Set(protectedSessionIds)
  const candidates = []
  let startingCount = 0
  for (const s of all) {
    if (s.status !== "starting") continue
    startingCount++
    if (protectedIds.has(s.id)) continue
    if (labelOf(s).startsWith(ESCALATION_LABEL_PREFIX)) continue
    if (s.kind !== undefined && s.kind !== "agent-cli") continue
    if (s.provisioning?.state === "queued") continue
    const startedMs = parseMs(s.startedAt)
    if (startedMs === undefined) continue
    const stuckMs = now - startedMs
    if (stuckMs <= thresholdMs) continue
    candidates.push({
      id: s.id,
      label: labelOf(s),
      startedAt: s.startedAt ?? null,
      stuckSec: Math.floor(stuckMs / 1000),
      phase: s.provisioning?.phase ?? null,
    })
  }
  candidates.sort((a, b) => b.stuckSec - a.stuckSec)
  return { starting: startingCount, flagged: candidates }
}

function escalationPrompt({ flagged, stopped, failed }) {
  const rows = flagged.map(
    c => `- ${c.id} ${c.label} — stuck in "starting" for ${Math.round(c.stuckSec / 60)} min (phase: ${c.phase ?? "unknown"})`,
  )
  return [
    "START WATCHDOG — one or more sessions never left \"starting\".",
    "",
    `Flagged this pass (${flagged.length}):`,
    ...(rows.length > 0 ? rows : ["- (none)"]),
    ...(stopped.length > 0 ? ["", `Stopped (${stopped.length}):`, ...stopped.map(c => `- ${c.id} ${c.label}`)] : []),
    ...(failed.length > 0 ? ["", "Failed to stop:", ...failed.map(f => `- ${f.id}: ${f.error}`)] : []),
    "",
    "Instructions:",
    "1. Check why each session never started: `agentproto sessions export <id>` or the daemon log around its spawn time.",
    "2. Common causes: a hung `git worktree add`/setup hook, a dead driver process, a stuck network call during auth.",
    "3. If it is a cold, legitimately slow worktree provision (first `pnpm install`), let it run or re-spawn with a prebuilt cache.",
    "4. If it is genuinely dead, stop it (`agentproto sessions stop <id>`) and re-spawn.",
    "5. Report back to the supervisor with the cause, not just the symptom.",
  ].join("\n")
}

async function main() {
  let flags
  try {
    flags = parseFlags(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`start-watchdog: ${err.message}\n\n${usage()}`)
    return 64
  }
  if (flags.help) {
    process.stdout.write(usage())
    return 0
  }

  const now = Date.now()
  const startedAt = new Date(now).toISOString()
  const all = sessions()
  const selection = select(all, now, flags.thresholdSec * 1000, selfSessionIds())

  const stopped = []
  const failed = []
  if (!flags.dryRun && flags.stop) {
    for (const c of selection.flagged.slice(0, flags.maxStop)) {
      const reason = `start-watchdog: stuck in "starting" for ${Math.round(c.stuckSec / 60)} min, never produced a running session`
      const res = runAgentproto(["sessions", "stop", c.id, "--reason", reason, "--json"], { json: false })
      if (res.status === 0) stopped.push(c)
      else failed.push({ id: c.id, error: (res.stderr || res.stdout || `exit ${res.status}`).trim() })
    }
  }

  let escalation = "none"
  if (!flags.dryRun && selection.flagged.length > 0 && flags.escalate) {
    const prompt = escalationPrompt({ flagged: selection.flagged, stopped, failed })
    // `all` is the pre-stop snapshot: a row just killed above would still
    // resolve here as a live "existing" escalation target, sending the
    // prompt to a session that no longer exists and spawning a duplicate
    // next pass. Exclude anything this very run just stopped.
    const stoppedIds = new Set(stopped.map(c => c.id))
    const existing = all.find(
      s => s.label === ESCALATION_LABEL && (s.status === "running" || s.status === "starting") && !stoppedIds.has(s.id),
    )
    const target = flags.notifySession ?? existing?.id
    if (target) {
      const res = runAgentproto(["sessions", "prompt", target, "--prompt", prompt, "--json"], { json: false })
      escalation = res.status === 0 ? `notified ${target}` : `FAILED: ${(res.stderr || res.stdout).trim()}`
    } else if (flags.agent) {
      const res = runAgentproto(
        ["sessions", "start", flags.agent, "--prompt", prompt, "--label", ESCALATION_LABEL, "--json"],
        { json: false },
      )
      escalation = res.status === 0 ? `spawned ${flags.agent}` : `FAILED: ${(res.stderr || res.stdout).trim()}`
    } else {
      escalation = "skipped (no --agent or --notify-session configured)"
    }
  }

  const report = {
    at: startedAt,
    dryRun: flags.dryRun,
    thresholdSec: flags.thresholdSec,
    starting: selection.starting,
    flagged: selection.flagged,
    stopped,
    failed,
    escalation,
  }
  if (flags.log) {
    try {
      await mkdir(dirname(flags.log), { recursive: true })
      await appendFile(flags.log, JSON.stringify(report) + "\n", "utf8")
    } catch (err) {
      process.stderr.write(`start-watchdog: could not write log: ${err.message}\n`)
    }
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  } else {
    const lines = [
      `start watchdog: ${selection.starting} starting / ${selection.flagged.length} stuck past ${flags.thresholdSec}s${flags.dryRun ? " (dry run)" : ""}`,
    ]
    if (selection.flagged.length === 0) lines.push("  nothing stuck")
    else {
      lines.push(`  ${flags.stop && !flags.dryRun ? "stopping" : "flagging"} ${selection.flagged.length}:`)
      for (const c of selection.flagged) lines.push(`    ${c.id} ${c.label} — stuck ${Math.round(c.stuckSec / 60)} min (phase: ${c.phase ?? "unknown"})`)
    }
    for (const f of failed) lines.push(`    FAILED to stop ${f.id}: ${f.error}`)
    if (escalation !== "none") lines.push(`  escalation: ${escalation}`)
    if (flags.log) lines.push(`  log: ${flags.log}`)
    process.stdout.write(lines.join("\n") + "\n")
  }
  return 0
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().then(code => { process.exitCode = code }).catch(err => {
    process.stderr.write(`start-watchdog: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
