#!/usr/bin/env node
/**
 * host-guard — the immediately usable bootstrap of `agentproto host guard`.
 *
 * Runs from cron every 20 min (the exact crontab line is in `usage()`).
 *
 * It reads `agentproto host health --json` + `agentproto sessions --json`,
 * and deterministically closes ONLY already-idle sessions when the host is
 * WARN/CRIT. On CRIT it also writes `~/.agentproto/host-guard/state.json`,
 * the marker the integrated CLI (`agentproto workflow start|run-file`) uses
 * to refuse heavyweight launches; once the cleanup is done and the host is
 * still CRIT it escalates to a brain session or a fresh agent.
 *
 * Safety rules (never relaxed by flags):
 *   - never busy / awaiting input / awaiting permission
 *   - never keepAlive / pinned
 *   - never with background tasks, queued prompts, busy children or watchers
 *   - never a `starting` session (no completed turn yet)
 *   - never an ancestor of a live session, this guard's own session, or a
 *     `host-guard-*` labelled session
 *   - never newer than --min-idle (WARN) / --crit-min-idle (CRIT)
 *   - never spawn before cleanup; no spawn at all on dry-run
 *
 * Usage:
 *   node scripts/host-guard.mjs --dry-run
 *   node scripts/host-guard.mjs --agent claude-code
 *   node scripts/host-guard.mjs --notify-session sess_abc --dry-run
 *
 * Env:
 *   HOST_GUARD_BIN       agentproto binary (default: repo dist if present,
 *                        else `agentproto` on PATH)
 *   HOST_GUARD_AGENT     same as --agent
 *   HOST_GUARD_NOTIFY_SESSION  same as --notify-session
 *
 * This is the bootstrap deliverable; the canonical implementation lives in
 * `packages/cli/src/commands/host-guard.ts` (`agentproto host guard`), with
 * the same policy and tests.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "..")
const LOCAL_CLI = join(REPO_ROOT, "packages", "cli", "dist", "cli.mjs")

const ESCALATION_LABEL = "host-guard-escalation"
const DEFAULT_LOG = join(homedir(), ".agentproto", "host-guard.log")
const DEFAULT_STATE = join(homedir(), ".agentproto", "host-guard", "state.json")
const STATE_TTL_MS = 25 * 60_000

const DEFAULTS = {
  warnMaxClose: 3,
  critMaxClose: 10,
  warnMinIdleSec: 300,
  critMinIdleSec: 60,
  settleMs: 3000,
}

function usage() {
  return `Usage: node scripts/host-guard.mjs [flags]

  --dry-run                decide and log, close nothing, write no marker
  --json                   print the report as JSON
  --agent <slug>           spawn this adapter if still CRIT after cleanup
  --notify-session <id>    prompt this session instead of spawning an agent
  --no-escalate            never notify/spawn
  --warn-close <n>         max closures on WARN when sessions aren't the cause (${DEFAULTS.warnMaxClose})
  --crit-close <n>         max closures on CRIT (${DEFAULTS.critMaxClose})
  --min-idle <sec>         WARN idle window (${DEFAULTS.warnMinIdleSec})
  --crit-min-idle <sec>    CRIT idle window (${DEFAULTS.critMinIdleSec})
  --settle <ms>            wait before the post-cleanup re-check (${DEFAULTS.settleMs})
  --log <path>             JSONL log (${DEFAULT_LOG})
  --no-log                 no log
  --state <path>           CRIT marker (${DEFAULT_STATE})
  --no-state               no marker
  --budget <ms>            host health sample budget
  -h, --help

Cron (every 20 min):
  */20 * * * * node /path/to/agentproto/scripts/host-guard.mjs --agent claude-code >> ~/.agentproto/host-guard.cron.log 2>&1
`
}

function parseFlags(argv) {
  const out = {
    dryRun: false,
    json: false,
    agent: process.env.HOST_GUARD_AGENT || undefined,
    notifySession: process.env.HOST_GUARD_NOTIFY_SESSION || undefined,
    escalate: true,
    log: DEFAULT_LOG,
    state: DEFAULT_STATE,
    budgetMs: undefined,
    ...DEFAULTS,
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${tok} needs a value`)
      return v
    }
    const num = (min) => {
      const n = Number(next())
      if (!Number.isFinite(n) || n < min) throw new Error(`${tok} expects a number >= ${min}`)
      return n
    }
    switch (tok) {
      case "--dry-run": out.dryRun = true; break
      case "--json": out.json = true; break
      case "--agent": out.agent = next(); break
      case "--notify-session": out.notifySession = next(); break
      case "--no-escalate": out.escalate = false; break
      case "--warn-close": out.warnMaxClose = num(0); break
      case "--crit-close": out.critMaxClose = num(0); break
      case "--min-idle": out.warnMinIdleSec = num(0); break
      case "--crit-min-idle": out.critMinIdleSec = num(0); break
      case "--settle": out.settleMs = num(0); break
      case "--budget": out.budgetMs = num(300); break
      case "--log": out.log = next(); break
      case "--no-log": out.log = null; break
      case "--state": out.state = next(); break
      case "--no-state": out.state = null; break
      case "-h":
      case "--help": out.help = true; break
      default: throw new Error(`unknown flag ${tok}`)
    }
  }
  return out
}

function bin() {
  if (process.env.HOST_GUARD_BIN) return { cmd: process.env.HOST_GUARD_BIN, prefix: [] }
  // Prefer this checkout's build, so the script works without a global install.
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

function health() {
  const report = runAgentproto(
    ["host", "health", "--json", ...(stateBudget() ? ["--budget", String(stateBudget())] : [])],
    { json: true },
  )
  if (!report || typeof report.verdict !== "string") throw new Error("host health returned no verdict")
  return report
}

let BUDGET
function stateBudget() { return BUDGET }

function sessions() {
  const list = runAgentproto(["sessions", "--json"], { json: true })
  if (!Array.isArray(list)) throw new Error("sessions --json did not return an array")
  return list
}

function isAlive(s) {
  return s.alive ?? (s.status === "running" || s.status === "starting")
}

function parseMs(v) {
  if (!v) return undefined
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : undefined
}

function idleMs(s, now) {
  const at = parseMs(s.lastActivityAt) ?? parseMs(s.startedAt)
  return at === undefined ? Number.POSITIVE_INFINITY : Math.max(0, now - at)
}

function labelOf(s) {
  return s.label || s.title || s.name || s.id
}

function protectedAncestors(all, explicit) {
  const byId = new Map(all.map(s => [s.id, s]))
  const out = new Set()
  const seeds = new Set(explicit)
  for (const s of all) if (isAlive(s)) seeds.add(s.id)
  for (const id of seeds) {
    let parent = byId.get(id)?.parentSessionId
    const seen = new Set()
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      out.add(parent)
      parent = byId.get(parent)?.parentSessionId
    }
  }
  return out
}

function ineligible(s, { now, minIdleMs, ancestors, protectedIds }) {
  if (!isAlive(s)) return "not-alive"
  if (s.status === "starting") return "starting"
  if (s.kind !== undefined && s.kind !== "agent-cli") return "not-agent"
  if (s.busy === true) return "busy"
  if (s.awaitingInput === true) return "awaiting-input"
  if (s.awaitingPermission === true) return "awaiting-permission"
  if ((s.pendingBgTasks ?? 0) > 0 || (s.backgroundTasks?.length ?? 0) > 0) return "background-tasks"
  if ((s.queuedPrompts ?? 0) > 0) return "queued-prompts"
  if ((s.childrenBusy ?? 0) > 0) return "children-busy"
  if ((s.watchers ?? 0) > 0) return "watched"
  if (s.keepAlive === true) return "keep-alive"
  if (s.pinned === true) return "pinned"
  if (protectedIds.has(s.id)) return "self-or-ancestor"
  if (ancestors.has(s.id)) return "ancestor-of-live"
  if (labelOf(s).startsWith("host-guard-")) return "self-or-ancestor"
  if (idleMs(s, now) < minIdleMs) return "too-recent"
  return null
}

export function select(healthReport, all, now, policy, protectedSessionIds) {
  const verdict = healthReport.verdict
  const ancestors = protectedAncestors(all, protectedSessionIds)
  const protectedIds = new Set(protectedSessionIds)
  const minIdleSec = verdict === "CRIT" ? policy.critMinIdleSec : policy.warnMinIdleSec
  const counts = { total: all.length, alive: 0, busy: 0, keepAlive: 0, pinned: 0, protectedAncestors: ancestors.size, eligible: 0 }
  const skipped = {}
  const candidates = []
  for (const s of all) {
    const alive = isAlive(s)
    if (alive) {
      counts.alive++
      if (s.busy === true) counts.busy++
      if (s.keepAlive === true) counts.keepAlive++
      if (s.pinned === true) counts.pinned++
    }
    const reason = ineligible(s, { now, minIdleMs: minIdleSec * 1000, ancestors, protectedIds })
    if (reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1
      continue
    }
    candidates.push({
      id: s.id,
      label: labelOf(s),
      startedAt: s.startedAt ?? null,
      lastActivityAt: s.lastActivityAt ?? null,
      idleSec: Math.min(Math.floor(idleMs(s, now) / 1000), 365 * 24 * 3600),
    })
  }
  counts.eligible = candidates.length
  candidates.sort((a, b) => {
    const aa = parseMs(a.lastActivityAt) ?? parseMs(a.startedAt) ?? 0
    const bb = parseMs(b.lastActivityAt) ?? parseMs(b.startedAt) ?? 0
    return aa - bb || a.id.localeCompare(b.id)
  })

  if (verdict === "OK") {
    return { verdict, action: "none", idleReason: "host is OK — nothing to close", candidates, close: [], projectedAlive: counts.alive, targetAlive: null, budget: 0, counts, skipped, policy }
  }

  const sessionsCheck = (healthReport.checks ?? []).find(c => c.id === "sessions")
  const threshold = healthReport.thresholds?.warnSessions ?? 30
  let targetAlive = null
  let needed = 0
  if (sessionsCheck && sessionsCheck.status !== "OK" && typeof sessionsCheck.value === "number") {
    targetAlive = Math.max(0, threshold - 1)
    needed = Math.max(0, sessionsCheck.value - targetAlive)
  }
  let budget = verdict === "CRIT" ? policy.critMaxClose : policy.warnMaxClose
  if (needed > 0) budget = verdict === "WARN" ? Math.max(1, needed) : Math.max(budget, needed)
  budget = Math.min(Math.max(0, budget), candidates.length)
  const close = candidates.slice(0, budget)
  const idleReason =
    close.length > 0
      ? null
      : counts.alive === 0
        ? "no live sessions"
        : counts.eligible === 0
          ? "no eligible idle sessions (all live sessions are busy, protected, recently active, or waiting)"
          : "policy allows no further closures"
  return {
    verdict,
    action: close.length > 0 ? "close" : "none",
    idleReason,
    candidates,
    close,
    projectedAlive: counts.alive - close.length,
    targetAlive,
    budget,
    counts,
    skipped,
    policy,
  }
}

/** Re-validate one candidate against a FRESH session list right before its
 *  kill (the kill route does not check `busy`). Returns the skip reason or
 *  null when still safe to close. */
export function recheck(id, fresh, verdict, now, policy, protectedSessionIds) {
  const s = fresh.find(x => x.id === id)
  if (!s) return "not-alive"
  const minIdleSec = verdict === "CRIT" ? policy.critMinIdleSec : policy.warnMinIdleSec
  return ineligible(s, {
    now,
    minIdleMs: minIdleSec * 1000,
    ancestors: protectedAncestors(fresh, protectedSessionIds),
    protectedIds: new Set(protectedSessionIds),
  })
}

function selfSessionIds() {
  return ["AGENTPROTO_SESSION_ID", "AGENTPROTO_PARENT_SESSION_ID"]
    .map(k => process.env[k])
    .filter(Boolean)
}

function escalationPrompt({ reasons, closed, failed, remaining, all, now }) {
  const alive = all.filter(isAlive).slice(0, 15)
  const rows = alive.map(
    s =>
      `- ${s.id} ${labelOf(s)} status=${s.status ?? "?"} busy=${s.busy === true} keepAlive=${s.keepAlive === true} idle=${Math.round(idleMs(s, now) / 1000)}s`,
  )
  return [
    "HOST GUARD ESCALATION — the host is still CRIT after the automated cleanup pass.",
    "",
    `Health reasons: ${reasons.join("; ") || "none recorded"}`,
    `Remaining: ${remaining.alive} live, ${remaining.busy} busy, ${remaining.keepAlive} keepAlive.`,
    "",
    `Closed this pass (${closed.length}):`,
    ...(closed.length > 0 ? closed.map(c => `- ${c.id} ${c.label} (idle ${Math.round(c.idleSec / 60)} min)`) : ["- (none)"]),
    ...(failed.length > 0 ? ["", "Failed to close:", ...failed.map(f => `- ${f.id}: ${f.error}`)] : []),
    "",
    "Live sessions still on the host:",
    ...(rows.length > 0 ? rows : ["- (none)"]),
    "",
    "Instructions:",
    "1. Do NOT start heavy workflows, big sandboxes, or large builds until `agentproto host health` is OK or WARN.",
    "2. Find what is consuming the host (`agentproto host load --full`); report the top processes and their owning sessions.",
    "3. Only stop sessions that are genuinely idle. Never stop a busy/keepAlive session.",
    "4. Report back to the supervisor with what you freed and what remains.",
  ].join("\n")
}

async function readState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"))
    return parsed?.verdict === "CRIT" && typeof parsed.expiresAt === "string" ? parsed : null
  } catch {
    return null
  }
}

async function main() {
  let flags
  try {
    flags = parseFlags(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`host-guard: ${err.message}\n\n${usage()}`)
    return 64
  }
  if (flags.help) {
    process.stdout.write(usage())
    return 0
  }
  BUDGET = flags.budgetMs
  const now = Date.now()
  const startedAt = new Date(now).toISOString()
  const policy = {
    warnMaxClose: flags.warnMaxClose,
    critMaxClose: flags.critMaxClose,
    warnMinIdleSec: flags.warnMinIdleSec,
    critMinIdleSec: flags.critMinIdleSec,
  }

  const before = health()
  let all = sessions()
  const selection = select(before, all, now, policy, selfSessionIds())

  const closed = []
  const failed = []
  if (!flags.dryRun) {
    for (const c of selection.close) {
      const reason = `host-guard ${before.verdict}: ${(before.reasons ?? []).join("; ") || "idle session cleanup"}; session idle ${Math.round(c.idleSec / 60)} min, last turn finished`
      try {
        const changed = recheck(c.id, sessions(), before.verdict, Date.now(), policy, selfSessionIds())
        if (changed) {
          failed.push({ id: c.id, error: `skipped: session changed before kill (${changed})` })
          continue
        }
      } catch (err) {
        failed.push({ id: c.id, error: `skipped: re-check failed: ${err.message}` })
        continue
      }
      const res = runAgentproto(["sessions", "stop", c.id, "--reason", reason, "--json"], { json: false })
      if (res.status === 0) closed.push(c)
      else failed.push({ id: c.id, error: (res.stderr || res.stdout || `exit ${res.status}`).trim() })
    }
  }

  let after = null
  let remaining = { alive: selection.counts.alive, busy: selection.counts.busy, keepAlive: selection.counts.keepAlive }
  let escalation = "none"
  if (!flags.dryRun && closed.length > 0) {
    // Marker reports post-cleanup numbers, not the pre-cleanup snapshot.
    try {
      all = sessions()
      remaining = {
        alive: all.filter(isAlive).length,
        busy: all.filter(s => isAlive(s) && s.busy === true).length,
        keepAlive: all.filter(s => isAlive(s) && s.keepAlive === true).length,
      }
    } catch {
      remaining = { ...remaining, alive: Math.max(0, remaining.alive - closed.length) }
    }
  }

  if (!flags.dryRun && before.verdict === "CRIT" && flags.state) {
    const state = {
      verdict: "CRIT",
      reasons: before.reasons ?? [],
      at: startedAt,
      expiresAt: new Date(now + STATE_TTL_MS).toISOString(),
      closed,
      remaining,
    }
    try {
      await mkdir(dirname(flags.state), { recursive: true })
      await writeFile(flags.state, JSON.stringify(state, null, 2) + "\n", "utf8")
    } catch (err) {
      process.stderr.write(`host-guard: could not write state marker: ${err.message}\n`)
    }
  }
  if (!flags.dryRun && before.verdict !== "CRIT" && flags.state) {
    await rm(flags.state, { force: true }).catch(() => {})
  }

  if (!flags.dryRun && before.verdict === "CRIT") {
    if (flags.settleMs > 0) await new Promise(r => setTimeout(r, flags.settleMs))
    try {
      const recheck = health()
      all = sessions()
      remaining = {
        alive: all.filter(isAlive).length,
        busy: all.filter(s => isAlive(s) && s.busy === true).length,
        keepAlive: all.filter(s => isAlive(s) && s.keepAlive === true).length,
      }
      after = { verdict: recheck.verdict, reasons: recheck.reasons ?? [] }
      if (recheck.verdict !== "CRIT" && flags.state) await rm(flags.state, { force: true }).catch(() => {})
    } catch (err) {
      after = { verdict: "CRIT", reasons: [`re-check failed: ${err.message}`] }
    }

    if (after.verdict === "CRIT" && flags.escalate) {
      const prompt = escalationPrompt({
        reasons: after.reasons.length > 0 ? after.reasons : before.reasons ?? [],
        closed,
        failed,
        remaining,
        all,
        now: Date.now(),
      })
      const existing = all.find(s => isAlive(s) && s.label === ESCALATION_LABEL && !closed.some(c => c.id === s.id))
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
  }

  const report = {
    at: startedAt,
    verdict: before.verdict,
    dryRun: flags.dryRun,
    action: selection.action,
    reasons: before.reasons ?? [],
    selection,
    closed,
    failed,
    after,
    escalation,
  }
  if (flags.log) {
    try {
      await mkdir(dirname(flags.log), { recursive: true })
      await appendFile(flags.log, JSON.stringify(report) + "\n", "utf8")
    } catch (err) {
      process.stderr.write(`host-guard: could not write log: ${err.message}\n`)
    }
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  } else {
    const lines = [
      `host guard: ${before.verdict}${flags.dryRun ? " (dry run)" : ""} — ${selection.counts.alive} live / ${selection.counts.busy} busy / ${selection.counts.keepAlive} keepAlive / ${selection.counts.eligible} eligible`,
    ]
    if (selection.close.length === 0) lines.push(`  nothing to close: ${selection.idleReason}`)
    else {
      lines.push(`  ${flags.dryRun ? "would close" : "closing"} ${selection.close.length} (target live ${selection.targetAlive ?? "n/a"}):`)
      for (const c of selection.close) lines.push(`    ${c.id} ${c.label} — idle ${Math.round(c.idleSec / 60)} min`)
    }
    for (const f of failed) lines.push(`    FAILED ${f.id}: ${f.error}`)
    if (after) lines.push(`  after cleanup: ${after.verdict}${after.reasons.length ? " — " + after.reasons.join("; ") : ""}`)
    if (escalation !== "none") lines.push(`  escalation: ${escalation}`)
    if (flags.log) lines.push(`  log: ${flags.log}`)
    process.stdout.write(lines.join("\n") + "\n")
  }
  return 0
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().then(code => { process.exitCode = code }).catch(err => {
    process.stderr.write(`host-guard: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
