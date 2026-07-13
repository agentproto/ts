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
 *
 * Thin HTTP client over the daemon's `GET /permissions` / `POST
 * /permissions/:id` routes (same inbox the MCP tools drive).
 */
import { parseArgs } from "node:util"
import {
  discoverDaemon,
  printNoDaemonError,
  httpGetJson,
  httpPostJson,
  humaniseDelta,
} from "./_daemon-helpers.js"

const USAGE = `agentproto permissions — approve/deny held tool-permission requests

Usage:
  agentproto permissions ls        [--json]
  agentproto permissions approve   <id> [--always]
  agentproto permissions deny      <id>
  agentproto permissions --help

  ls        List permission requests HELD across all permission-hold sessions
            (spawned with --hold-permissions). Columns: id, session, tool, age.
  approve   Grant the request. --always picks the allow-always option when the
            request offers one (otherwise allow-once).
  deny      Reject the request (or cancel it when no reject option is offered).

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

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto permissions: unknown subcommand "${sub}"\n  Known: ls | approve | deny\n`,
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
