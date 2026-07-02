/**
 * `agentproto cron add  --schedule <cron> [--command <cmd> --args <arg>...
 *                         | --adapter <slug> --prompt <text>]
 *                        [--label <text>] [--once]`
 * `agentproto cron list [--json]`
 * `agentproto cron remove <id>`
 * `agentproto cron run   <id>`
 *
 * Manage durable cron jobs on the daemon. Jobs persist to
 * ~/.agentproto/cron-jobs.json and survive daemon restarts.
 *
 * Skipped fires during downtime are NOT backfilled — recurring
 * jobs resume from "now" after a restart.
 */

import { parseArgs } from "node:util"
import {
  discoverDaemon,
  printNoDaemonError,
  httpPostJson,
  httpGetJson,
  httpDelete,
} from "./_daemon-helpers.js"

const USAGE = `agentproto cron — manage durable cron jobs on the daemon

Usage:
  agentproto cron add --schedule <cron-expr>
                      (--command <cmd> [--args <arg>...] [--cwd <dir>] [--timeout-ms <ms>]
                       | --adapter <slug> --prompt <text> [--cwd <dir>] [--model <id>]
                       | --target-session <id> --prompt <text>)
                      [--label <text>] [--once] [--json]
  agentproto cron list [--json]
  agentproto cron remove <id>
  agentproto cron run    <id> [--json]

Schedule is a 5-field cron expression in local time:
  minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-7,0=Sun)

By default jobs recur indefinitely. Pass --once to fire once then deactivate.

Command jobs must be allowlisted in <workspace>/.agentproto/allowed-commands.json.

Three action kinds:
  --command <cmd>         Run an allowlisted shell command.
  --adapter <slug>        Spawn a brand-new agent session and prompt it.
  --target-session <id>   Re-prompt an existing, already-running session in
                          place — no new session is spawned. Use for a
                          durable session a cron job periodically checks in on.

Examples:
  agentproto cron add --schedule "* * * * *" --command echo --args hello --once
  agentproto cron add --schedule "0 9 * * 1-5" --adapter claude-code --prompt "daily standup"
  agentproto cron add --schedule "*/15 * * * *" --target-session sess_abc123 --prompt "status?"
  agentproto cron list --json
  agentproto cron remove <id>
  agentproto cron run    <id>
`

export async function runCron(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const sub = args[0]
  const rest = args.slice(1)

  switch (sub) {
    case "add":
      return runCronAdd(rest)
    case "list":
      return runCronList(rest)
    case "remove":
    case "delete":
    case "rm":
      return runCronRemove(rest)
    case "run":
      return runCronRun(rest)
    default:
      process.stderr.write(
        sub
          ? `agentproto cron: unknown sub-command '${sub}'\n\n${USAGE}`
          : USAGE,
      )
      return sub ? 2 : 0
  }
}

// ── cron add ────────────────────────────────────────────────────────

async function runCronAdd(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: args as string[],
    allowPositionals: true,
    options: {
      schedule:         { type: "string" },
      command:          { type: "string" },
      args:             { type: "string", multiple: true },
      adapter:          { type: "string" },
      "target-session": { type: "string" },
      prompt:           { type: "string" },
      cwd:              { type: "string" },
      model:            { type: "string" },
      "timeout-ms":     { type: "string" },
      label:            { type: "string" },
      once:             { type: "boolean", default: false },
      json:             { type: "boolean", default: false },
    },
    strict: false,
  })

  if (positionals.length > 0 || !values.schedule) {
    process.stderr.write("agentproto cron add: --schedule is required\n\n" + USAGE)
    return 2
  }
  const kindsGiven = [values.command, values.adapter, values["target-session"]].filter(Boolean).length
  if (kindsGiven === 0) {
    process.stderr.write(
      "agentproto cron add: one of --command, --adapter, or --target-session is required\n\n" + USAGE,
    )
    return 2
  }
  if (kindsGiven > 1) {
    process.stderr.write(
      "agentproto cron add: --command, --adapter, and --target-session are mutually exclusive\n\n" + USAGE,
    )
    return 2
  }
  if (values.adapter && !values.prompt) {
    process.stderr.write(
      "agentproto cron add: --prompt is required when using --adapter\n\n" + USAGE,
    )
    return 2
  }
  if (values["target-session"] && !values.prompt) {
    process.stderr.write(
      "agentproto cron add: --prompt is required when using --target-session\n\n" + USAGE,
    )
    return 2
  }

  const action = values.command
    ? {
        kind: "command" as const,
        command: values.command,
        ...(values["args"] ? { args: values["args"] as string[] } : {}),
        ...(values.cwd ? { cwd: values.cwd } : {}),
        ...(values["timeout-ms"]
          ? { timeoutMs: Number.parseInt(values["timeout-ms"] as string, 10) }
          : {}),
      }
    : values["target-session"]
      ? {
          kind: "prompt-session" as const,
          sessionId: values["target-session"] as string,
          prompt: values.prompt as string,
        }
      : {
          kind: "agent" as const,
          adapter: values.adapter as string,
          prompt: values.prompt as string,
          ...(values.cwd ? { cwd: values.cwd } : {}),
          ...(values.model ? { model: values.model } : {}),
        }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto cron add")
    return 1
  }
  const ep = report.found

  let result: Record<string, unknown>
  try {
    result = await httpPostJson<Record<string, unknown>>(
      `${ep.url}/cron`,
      {
        schedule: values.schedule,
        recurring: !values.once,
        ...(values.label ? { label: values.label } : {}),
        action,
      },
      ep.token,
    )
  } catch (err) {
    process.stderr.write(
      `agentproto cron add: request failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }

  if (result["error"]) {
    process.stderr.write(
      `agentproto cron add: ${String(result["message"] ?? result["error"])}\n`,
    )
    return 1
  }
  process.stdout.write(
    `\u2713 Created cron job ${String(result["id"])}\n` +
      `  Schedule:  ${String(result["schedule"])}\n` +
      `  Recurring: ${String(result["recurring"])}\n` +
      `  Next run:  ${String(result["nextRunAt"] ?? "(computing)")}\n`,
  )
  return 0
}

// ── cron list ───────────────────────────────────────────────────────

async function runCronList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      json: { type: "boolean", default: false },
    },
    strict: false,
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto cron list")
    return 1
  }
  const ep = report.found

  let result: { jobs?: unknown[] }
  try {
    result = await httpGetJson<{ jobs?: unknown[] }>(`${ep.url}/cron`)
  } catch (err) {
    process.stderr.write(
      `agentproto cron list: request failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }

  const jobs = result.jobs ?? []
  if (jobs.length === 0) {
    process.stdout.write("No cron jobs defined.\n")
    return 0
  }

  process.stdout.write(`${jobs.length} cron job(s):\n\n`)
  for (const job of jobs) {
    const j = job as Record<string, unknown>
    const active   = j["active"]    ? "active"   : "inactive"
    const recurring = j["recurring"] ? "recurring" : "one-shot"
    const lr = j["lastResult"] as Record<string, unknown> | undefined
    process.stdout.write(
      `  ${String(j["id"])}\n` +
        `    Label:    ${String(j["label"] ?? "(none)")}\n` +
        `    Schedule: ${String(j["schedule"])}  (${recurring}, ${active})\n` +
        `    Next run: ${String(j["nextRunAt"] ?? "\u2014")}\n` +
        `    Last run: ${String(j["lastRunAt"] ?? "\u2014")}\n` +
        (lr
          ? `    Last result: ${lr["ok"] ? "\u2713" : "\u2717"} ${String(lr["summary"])}\n`
          : "") +
        "\n",
    )
  }
  return 0
}

// ── cron remove ─────────────────────────────────────────────────────

async function runCronRemove(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: args as string[],
    allowPositionals: true,
    options: {},
    strict: false,
  })

  const id = positionals[0]
  if (!id) {
    process.stderr.write("agentproto cron remove: <id> is required\n")
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto cron remove")
    return 1
  }
  const ep = report.found

  try {
    await httpDelete(`${ep.url}/cron/${encodeURIComponent(id)}`, ep.token)
  } catch (err) {
    process.stderr.write(
      `agentproto cron remove: request failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  process.stdout.write(`\u2713 Removed cron job ${id}\n`)
  return 0
}

// ── cron run ─────────────────────────────────────────────────────────

async function runCronRun(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: args as string[],
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
    },
    strict: false,
  })

  const id = positionals[0]
  if (!id) {
    process.stderr.write("agentproto cron run: <id> is required\n")
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto cron run")
    return 1
  }
  const ep = report.found

  let result: Record<string, unknown>
  try {
    result = await httpPostJson<Record<string, unknown>>(
      `${ep.url}/cron/${encodeURIComponent(id)}/run`,
      {},
      ep.token,
    )
  } catch (err) {
    process.stderr.write(
      `agentproto cron run: request failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }

  if (result["error"]) {
    process.stderr.write(
      `agentproto cron run: ${String(result["message"] ?? result["error"])}\n`,
    )
    return 1
  }
  const lr = result["result"] as Record<string, unknown> | undefined
  const ok      = lr?.["ok"]
  const summary = lr?.["summary"] ?? "(no output)"
  process.stdout.write(
    `${ok ? "\u2713" : "\u2717"} Job ${String(result["jobId"])} fired. Result: ${String(summary)}\n`,
  )
  return 0
}
