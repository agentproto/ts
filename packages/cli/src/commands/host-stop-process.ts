/**
 * `agentproto host stop-process <pid> --reason <text>` — ask the daemon to
 * stop ONE process that belongs to a daemon session.
 *
 * The CLI only carries the request: the daemon decides (POST
 * /host/processes/:pid/stop, `@agentproto/runtime`'s host-stop-process.ts).
 * It refuses the daemon, its ancestors, a session's own adapter process,
 * another user's process, and anything outside every live session; it
 * SIGTERMs, SIGKILLs after the grace delay only if the pid still runs the
 * same command, logs who asked and why, and tells the owning session.
 *
 * This is the one command the host-guard escalation session is allowed to
 * run without a prompt (`defaults.permissionGrants`), so it stays narrow on
 * purpose: one pid per call, a mandatory reason, no signal choice.
 *
 * Exit status: 0 stopped (or signalled), 3 refused, 2 daemon unavailable,
 * 64 bad usage.
 */
import { parseArgs } from "node:util"
import { discoverDaemon, httpPostJson, printNoDaemonError } from "./_daemon-helpers.js"

export const STOP_PROCESS_USAGE = `Usage:
  agentproto host stop-process <pid> --reason <text> [--grace <ms>] [--json]

Stop ONE process that descends from a live daemon session (a whole-disk scan,
a runaway build). The daemon refuses the daemon itself, its ancestors, a
session's own adapter process (stop the session instead), another user's
process, and anything outside every session.

SIGTERM first, SIGKILL after --grace (default 5000 ms, max 60000) if the pid
still runs the same command. Every attempt is logged with the caller and the
reason (~/.agentproto/host-stop-process.log), and the owning session is told.

  --reason <text>   why (required, at most 500 characters)
  --grace <ms>      delay before SIGKILL (default 5000)
  --json            print the daemon's answer as JSON

Exit: 0 stopped, 3 refused, 2 daemon unavailable, 64 bad usage.
`

const EXIT_REFUSED = 3
const EXIT_USAGE = 64

interface StopAnswer {
  ok: boolean
  pid: number
  code?: string
  message: string
  owner?: { sessionId: string; label?: string }
  signal?: string
  exited?: boolean
  notified?: boolean
}

/** Pull the daemon's JSON body out of an `HTTP <status>: <body>` error. */
export function answerFromHttpError(err: unknown): StopAnswer | undefined {
  const msg = err instanceof Error ? err.message : String(err)
  const m = /^HTTP (\d{3}): ([\s\S]*)$/.exec(msg)
  if (!m) return undefined
  try {
    const body = JSON.parse(m[2]!) as Partial<StopAnswer>
    if (typeof body.message === "string" && typeof body.ok === "boolean") return body as StopAnswer
  } catch {
    // not the route's JSON
  }
  return undefined
}

export async function runHostStopProcess(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(STOP_PROCESS_USAGE)
    return 0
  }
  let values: Record<string, string | boolean | undefined>
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: { reason: { type: "string" }, grace: { type: "string" }, json: { type: "boolean" } },
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    process.stderr.write(`agentproto host stop-process: ${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT_USAGE
  }
  const usage = (msg: string): number => {
    process.stderr.write(`agentproto host stop-process: ${msg}\n\n${STOP_PROCESS_USAGE}`)
    return EXIT_USAGE
  }
  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0]!)) return usage("expects exactly one numeric <pid>")
  const pid = Number(positionals[0])
  const reason = typeof values.reason === "string" ? values.reason.trim() : ""
  if (!reason) return usage("--reason is required")
  let graceMs: number | undefined
  if (values.grace !== undefined) {
    graceMs = Number(values.grace)
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 60_000) return usage("--grace expects 0 to 60000 ms")
  }

  const found = (await discoverDaemon()).found
  if (!found) {
    printNoDaemonError({ found: null, stale: [] }, "agentproto host stop-process")
    return 2
  }
  // The caller's session, when run from inside one: the daemon logs it as
  // the requester (a declared identity, trusted on loopback like every
  // other `callerSessionId` claim).
  const caller = process.env.AGENTPROTO_SESSION_ID
  const url =
    `${found.url}/host/processes/${pid}/stop` + (caller ? `?callerSessionId=${encodeURIComponent(caller)}` : "")
  let answer: StopAnswer
  try {
    answer = await httpPostJson<StopAnswer>(url, { reason, ...(graceMs !== undefined ? { graceMs } : {}) }, found.token)
  } catch (err) {
    const refused = answerFromHttpError(err)
    if (!refused) {
      process.stderr.write(`agentproto host stop-process: ${err instanceof Error ? err.message : String(err)}\n`)
      return 2
    }
    answer = refused
  }
  if (values.json === true) {
    process.stdout.write(JSON.stringify(answer, null, 2) + "\n")
  } else if (answer.ok) {
    const owner = answer.owner ? ` (session ${answer.owner.sessionId}${answer.owner.label ? ` ${answer.owner.label}` : ""})` : ""
    process.stdout.write(
      `${answer.message}${owner}; ${answer.notified ? "session notified" : "session NOT notified"}\n`,
    )
  } else {
    process.stderr.write(`refused (${answer.code ?? "error"}): ${answer.message}\n`)
  }
  return answer.ok ? 0 : answer.code === "invalid-reason" || answer.code === "invalid-pid" ? EXIT_USAGE : EXIT_REFUSED
}
