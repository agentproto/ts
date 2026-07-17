/**
 * `agentproto permissions <subcommand>`
 *
 * The human side of the cross-session permission inbox. Sessions started in
 * permission-hold mode (`agentproto sessions start --hold-permissions`, MCP
 * `agent_start { permissionHold: true }`, or `POST /sessions/agent
 * { permissionHold: true }`) PARK each tool-permission request instead of
 * auto-answering it; this verb lists them across every session and
 * approves/denies one, unblocking the agent.
 *
 *   ls        [--json]                list pending permissions (id, session, tool, age)
 *   approve   <id> [--always]         grant — allow-once, or allow-always with --always
 *   deny      <id>                    reject the request
 *   watch     --allow-tool <pat> ...  poll the inbox, auto-resolve requests matching
 *                                     explicit rules, leave everything else parked
 *
 * Thin HTTP client over the daemon's `GET /permissions` / `POST
 * /permissions/:id` routes (same inbox the MCP tools drive). `watch` is a
 * client-side poll loop by necessity: the daemon has no push/SSE/long-poll
 * for permission events over HTTP (the `session:permission-request` bus
 * event is in-process / MCP `session_events_poll` only), so the snapshot
 * route re-read on an interval is the honest mechanism. Rule matching lives
 * in `_permission-rules.ts`, pure and unit-tested.
 */
import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  discoverDaemon,
  printNoDaemonError,
  httpGetJson,
  httpPostJson,
  humaniseDelta,
} from "./_daemon-helpers.js"
import { parseDuration, formatDuration } from "../util/duration.js"
import {
  compileRulesFromFlags,
  parseRulesJson,
  matchEntry,
  describeRule,
  type CompiledRule,
} from "./_permission-rules.js"

const USAGE = `agentproto permissions — approve/deny held tool-permission requests

Usage:
  agentproto permissions ls        [--json]
  agentproto permissions approve   <id> [--always]
  agentproto permissions deny      <id>
  agentproto permissions watch     [--allow-tool <pat>]... [--deny-tool <pat>]...
                                   [--session <id>] [--rules-json <json|@file>]
                                   [--always] [--interval <dur>] [--timeout <dur>]
                                   [--once] [--dry-run] [--json]
  agentproto permissions --help

  ls        List permission requests HELD across all permission-hold sessions
            (spawned with --hold-permissions). Columns: id, session, tool, age.
  approve   Grant the request. --always picks the allow-always option when the
            request offers one (otherwise allow-once).
  deny      Reject the request (or cancel it when no reject option is offered).
  watch     Poll the inbox and auto-resolve requests matching your rules;
            everything else stays parked for \`permissions ls\`. Requires at
            least one rule — there is no implicit "resolve everything".

watch:
  --allow-tool/--deny-tool take an exact tool name or a \`*\` glob
  (\`mcp__*\`). Patterns match the TOOL column \`permissions ls\` shows —
  adapters surface the request's human-readable title there, which is not
  always the internal tool identifier (claude-code's plan-mode exit
  arrives as "Ready to code?", not ExitPlanMode). Check \`ls\` or rehearse
  with --dry-run before trusting a pattern. Deny rules are checked BEFORE
  allow rules; use --rules-json for explicit ordering. A request with no
  tool name never matches a tool pattern (even \`*\`) — only a session-only
  --rules-json rule can catch it.
  --session scopes every flag rule to one session (id or label, exact).
  --always makes approvals pick the allow-always option when offered.
  --rules-json <json|@file> takes a full rule array and is mutually
  exclusive with --allow-tool/--deny-tool/--session/--always:
    [{ "match": { "toolName": "ExitPlanMode", "sessionId": "s-abc" },
       "decision": "approve", "optionId": "...", "scope": "once" }]
  Polls every --interval (default 2s) until --timeout (default 1h), --once
  (single pass), or Ctrl-C. --dry-run prints what would be resolved without
  resolving. --json emits one compact JSON object per line (NDJSON).
  <dur>: bare integer = milliseconds, or an explicit unit — 500ms, 30s, 5m, 2h.

Start a session that parks its permissions with:
  agentproto sessions start <adapter> --hold-permissions
`

/** One entry from `GET /permissions` — a PendingPermission enriched with the
 *  owning session's adapter/title and an age. */
interface PermissionEntry {
  id: string
  sessionId: string
  toolCallId: string
  toolName?: string
  text: string
  options: Array<{ optionId: string; name?: string; kind?: string }>
  requestedAt: string
  adapter?: string
  sessionLabel?: string
  sessionTitle?: string
  ageMs?: number
}

export async function runPermissions(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  if (sub === "ls" || sub === "list") return runLs(args.slice(1))
  if (sub === "approve" || sub === "allow") return runRespond(args.slice(1), "approve")
  if (sub === "deny" || sub === "reject") return runRespond(args.slice(1), "deny")
  if (sub === "watch") return runWatch(args.slice(1))

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto permissions: unknown subcommand "${sub}"\n  Known: ls | approve | deny | watch\n`,
  )
  return 2
}

async function runLs(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" }, session: { type: "string" } },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto permissions ls")
    return 2
  }
  const endpoint = report.found

  let body: { permissions: PermissionEntry[] }
  try {
    const q = values.session ? `?sessionId=${encodeURIComponent(values.session)}` : ""
    body = await httpGetJson<{ permissions: PermissionEntry[] }>(`${endpoint.url}/permissions${q}`)
  } catch (err) {
    process.stderr.write(
      `agentproto permissions ls: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  const permissions = body.permissions ?? []

  if (values.json) {
    process.stdout.write(JSON.stringify(permissions, null, 2) + "\n")
    return 0
  }
  if (permissions.length === 0) {
    process.stdout.write("No pending permissions.\n")
    return 0
  }
  process.stdout.write(
    `${"ID".padEnd(10)}  ${"SESSION".padEnd(14)}  ${"TOOL".padEnd(18)}  ${"AGE".padEnd(5)}  QUESTION\n`,
  )
  for (const p of permissions) {
    const age = typeof p.ageMs === "number" ? humaniseDelta(p.ageMs) : "?"
    const tool = (p.toolName ?? "—").slice(0, 18)
    const question = (p.text ?? "").replace(/\s+/g, " ").slice(0, 60)
    process.stdout.write(
      `${p.id.padEnd(10)}  ${p.sessionId.padEnd(14)}  ${tool.padEnd(18)}  ${age.padEnd(5)}  ${question}\n`,
    )
  }
  return 0
}

async function runRespond(
  args: readonly string[],
  decision: "approve" | "deny",
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      always: { type: "boolean" },
      "option-id": { type: "string" },
      json: { type: "boolean" },
    },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      `agentproto permissions ${decision}: missing <id>.\n` +
        `  Try: agentproto permissions ls\n`,
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto permissions ${decision}: unexpected extra positionals: ${positionals
        .slice(1)
        .join(" ")}\n`,
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, `agentproto permissions ${decision}`)
    return 2
  }
  const endpoint = report.found

  const reqBody: Record<string, unknown> = { decision }
  if (values["option-id"]) reqBody.optionId = values["option-id"]
  if (decision === "approve" && values.always) reqBody.scope = "always"

  let result: { ok?: boolean; sessionId?: string; decision?: string; optionId?: string }
  try {
    result = await httpPostJson(
      `${endpoint.url}/permissions/${encodeURIComponent(id)}`,
      reqBody,
      endpoint.token,
    )
  } catch (err) {
    process.stderr.write(
      `agentproto permissions ${decision}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }
  process.stdout.write(
    `agentproto permissions ${decision}: ${id} ${decision === "approve" ? "approved" : "denied"}` +
      `${result.sessionId ? ` (session ${result.sessionId})` : ""}` +
      `${result.optionId ? ` → ${result.optionId}` : ""}\n`,
  )
  return 0
}

// ── watch ────────────────────────────────────────────────────────────────

/** Read a `--flag <json>` / `--flag @<file>` value — local copy of
 *  `policy.ts`'s private helper (12 lines aren't worth the cross-import). */
async function readJsonArg(raw: string, flagLabel: string): Promise<unknown> {
  const text = raw.startsWith("@") ? await readFile(resolve(raw.slice(1)), "utf8") : raw
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`invalid ${flagLabel}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** GET-error streak that aborts the loop — transient daemon blips retry,
 *  a daemon that's actually gone stops the watcher instead of spinning. */
const MAX_CONSECUTIVE_GET_ERRORS = 5

async function runWatch(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      "allow-tool": { type: "string", multiple: true },
      "deny-tool": { type: "string", multiple: true },
      session: { type: "string" },
      "rules-json": { type: "string" },
      always: { type: "boolean" },
      interval: { type: "string" },
      timeout: { type: "string" },
      once: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  })

  const fail = (msg: string): number => {
    process.stderr.write(`agentproto permissions watch: ${msg}\n`)
    return 2
  }

  // ── rules ──
  const flagRulesGiven =
    values["allow-tool"] !== undefined ||
    values["deny-tool"] !== undefined ||
    values.session !== undefined ||
    values.always !== undefined
  let rules: CompiledRule[]
  if (values["rules-json"] !== undefined) {
    if (flagRulesGiven) {
      return fail("--rules-json is mutually exclusive with --allow-tool/--deny-tool/--session/--always")
    }
    let parsed: unknown
    try {
      parsed = await readJsonArg(values["rules-json"], "--rules-json")
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    const result = parseRulesJson(parsed)
    if (!result.ok) return fail(result.error)
    rules = result.rules
  } else {
    rules = compileRulesFromFlags({
      allow: values["allow-tool"] ?? [],
      deny: values["deny-tool"] ?? [],
      ...(values.session !== undefined ? { session: values.session } : {}),
      ...(values.always ? { always: true } : {}),
    })
    if (rules.length === 0) {
      return fail(
        "at least one rule is required (--allow-tool/--deny-tool or --rules-json).\n" +
          "  Nothing is auto-resolved without an explicit rule; to approve every named tool,\n" +
          "  say so explicitly: --allow-tool '*'",
      )
    }
  }

  // ── durations ──
  let intervalMs = 2_000
  if (values.interval !== undefined) {
    const parsed = parseDuration(values.interval, "--interval")
    if (!parsed.ok) return fail(parsed.error)
    intervalMs = parsed.ms
  }
  let timeoutMs = 3_600_000
  if (values.timeout !== undefined) {
    const parsed = parseDuration(values.timeout, "--timeout")
    if (!parsed.ok) return fail(parsed.error)
    timeoutMs = parsed.ms
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto permissions watch")
    return 2
  }
  const endpoint = report.found

  const jsonMode = Boolean(values.json)
  const dryRun = Boolean(values["dry-run"])
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  /** Ids this process resolved (or gave up on): the GET snapshot can lag a
   *  just-sent POST, and a 409 (no matching option) can never succeed on
   *  retry — without this set both would re-fire every poll. */
  const handled = new Set<string>()
  const counters = { approved: 0, denied: 0, errors: 0 }

  const warn = (msg: string): void => {
    process.stderr.write(`agentproto permissions watch: ${msg}\n`)
  }
  const emit = (event: Record<string, unknown>, humanLine: string): void => {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n")
    } else {
      process.stdout.write(humanLine + "\n")
    }
  }
  const entryLabel = (p: PermissionEntry): string =>
    `${p.id} (session ${p.sessionId}, tool ${p.toolName ?? "—"})`

  let summarised = false
  const summarise = (reason: "once" | "timeout" | "interrupt" | "errors"): void => {
    if (summarised) return
    summarised = true
    emit(
      { event: "summary", ...counters, reason, ...(dryRun ? { dryRun: true } : {}) },
      `permissions watch: ${counters.approved} approved, ${counters.denied} denied, ` +
        `${counters.errors} errors in ${formatDuration(Math.max(1, Date.now() - startedAt))}` +
        ` (${reason}${dryRun ? ", dry-run" : ""})`,
    )
  }

  if (!jsonMode) {
    process.stderr.write(
      `permissions watch: ${rules.length} rule(s) [${rules.map(describeRule).join("; ")}], ` +
        `polling every ${formatDuration(intervalMs)} for up to ${formatDuration(timeoutMs)}` +
        `${dryRun ? " (dry-run)" : ""}. Non-matching requests stay parked.\n`,
    )
  }

  const onSigint = (): void => {
    summarise("interrupt")
    process.exit(0)
  }
  process.once("SIGINT", onSigint)

  let consecutiveGetErrors = 0
  try {
    for (;;) {
      let inbox: PermissionEntry[] | null = null
      try {
        const body = await httpGetJson<{ permissions: PermissionEntry[] }>(
          `${endpoint.url}/permissions`,
        )
        inbox = body.permissions ?? []
        consecutiveGetErrors = 0
      } catch (err) {
        consecutiveGetErrors++
        warn(
          `GET /permissions failed (${consecutiveGetErrors}/${MAX_CONSECUTIVE_GET_ERRORS}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
        if (values.once || consecutiveGetErrors >= MAX_CONSECUTIVE_GET_ERRORS) {
          summarise("errors")
          return 1
        }
      }

      for (const p of inbox ?? []) {
        if (handled.has(p.id)) continue
        const rule = matchEntry(rules, p)
        if (!rule) continue
        const ruleLabel = describeRule(rule)
        const verb = rule.decision === "approve" ? "approved" : "denied"

        if (dryRun) {
          handled.add(p.id)
          counters[rule.decision === "approve" ? "approved" : "denied"]++
          emit(
            { event: "dry-run", decision: rule.decision, id: p.id, sessionId: p.sessionId, toolName: p.toolName, rule: ruleLabel },
            `permissions watch: would have ${verb} ${entryLabel(p)} [${ruleLabel}]`,
          )
          continue
        }

        const reqBody = {
          decision: rule.decision,
          ...(rule.optionId ? { optionId: rule.optionId } : {}),
          ...(rule.scope ? { scope: rule.scope } : {}),
        }
        try {
          const result = await httpPostJson<{ optionId?: string }>(
            `${endpoint.url}/permissions/${encodeURIComponent(p.id)}`,
            reqBody,
            endpoint.token,
          )
          handled.add(p.id)
          counters[rule.decision === "approve" ? "approved" : "denied"]++
          emit(
            { event: verb, id: p.id, sessionId: p.sessionId, toolName: p.toolName, optionId: result.optionId, rule: ruleLabel },
            `permissions watch: ${verb} ${entryLabel(p)}` +
              `${result.optionId ? ` → ${result.optionId}` : ""} [${ruleLabel}]`,
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (/HTTP 404/.test(msg)) {
            // Raced: resolved elsewhere, or the session died. Fine either way.
            handled.add(p.id)
            warn(`${p.id} already resolved or session gone — skipping (${msg})`)
          } else if (/HTTP 409/.test(msg)) {
            handled.add(p.id)
            counters.errors++
            warn(`${p.id} cannot be auto-resolved — leaving to a human (${msg})`)
          } else {
            counters.errors++
            warn(`POST /permissions/${p.id} failed, will retry next poll: ${msg}`)
          }
        }
      }

      if (values.once) {
        summarise("once")
        return 0
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        summarise("timeout")
        return 0
      }
      await sleep(Math.min(intervalMs, remaining))
    }
  } finally {
    process.removeListener("SIGINT", onSigint)
  }
}
