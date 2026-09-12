/**
 * `agentproto task <create | list | claim | update>`
 *
 * A pure REST client over the daemon's `/tasks` routes
 * (http-server.ts `handleTasks`) — thin adapters over the same TaskLedger
 * the MCP `task_create` / `task_list` / `task_claim` / `task_update` tools
 * drive (`task-tools.ts`). Zero daemon change.
 *
 * Caller identity: every CLI process that holds the daemon's bearer token
 * (or rides the loopback bypass) arrives at `/tasks` in **operator
 * context** — the same identity the root `/mcp` endpoint's unscoped caller
 * gets. That settles the default-board question for a shell invocation:
 * there is no session lineage to resolve `tree:<root>` from, so
 *
 *   a shell-invoked `task create` lands on the operator's workspace board
 *   `ws:<active-workspace-slug>` (falling back to `ws:default` when no
 *   workspace is active) — the SAME board an operator's root-MCP
 *   `task_create` uses. Pass `--board-id` to land anywhere else.
 *
 * This is not a CLI invention: it is exactly what `TaskLedger.resolveBoardId`
 * does for a `{kind:"operator"}` caller, and the daemon echoes the resolved
 * board back (the list route returns `boardId`; the created record carries
 * `boardId`), so every verb shows you where a task actually landed.
 *
 * Claim over REST: there is no separate claim route — the route's
 * documented convention is `PATCH {rev, owner, status:"in_progress"}` in
 * operator context. The CLI sets `owner:"operator"`. Note this is broader
 * than the MCP `task_claim` (which refuses an already-owned task): an
 * operator PATCH may assign anyone. `update` keeps the ledger's rev-CAS as
 * the mutation guard — `--rev` is required, a mismatch answers 409 with the
 * current record.
 */
import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import http from "node:http"
import https from "node:https"
import {
  discoverDaemon,
  printNoDaemonError,
  httpGetJson,
  httpPostJson,
} from "./_daemon-helpers.js"

const TASK_STATUSES = ["pending", "in_progress", "done", "failed", "cancelled"] as const

const USAGE = `agentproto task — create, list, claim and update tasks on the daemon's Task ledger

Usage:
  agentproto task create <title> [--description <text>] [--board-id <id>]
                         [--owner <sessionId|human|operator>]
                         [--blocked-by <taskId>]... [--meta-json <json|@file>]
                         [--verify-json <json|@file>] [--json]
  agentproto task list   [--board-id <id>]
                         [--status <pending|in_progress|done|failed|cancelled>]
                         [--include-closed] [--json]
  agentproto task claim  <taskId> --rev <n> [--json]
  agentproto task update <taskId> --rev <n> [--status <s>] [--title <text>]
                         [--description <text>] [--blocked-by <taskId>]...
                         [--owner <sessionId|human|operator>] [--release]
                         [--note <text>] [--evidence-policy <policyId>] [--json]
  agentproto task --help

  <json|@file>: a JSON value, or \`@<path>\` to read it from a file
  (the sessions --options-json convention).

Boards (default-board rule):
  A CLI invocation has NO session lineage, so unlike a daemon session (whose
  default board is its lineage \`tree:<root>\`) tasks created from the shell
  land on the OPERATOR's workspace board: \`ws:<active-workspace-slug>\`
  (\`ws:default\` when no workspace is active) — the same default an
  unscoped root-MCP caller gets. \`--board-id\` overrides on every verb.
  Every result echoes the board it actually landed on.

verify (done-gate):
  \`--verify-json\` takes the same gate shape as \`policy attach --gate-json\`:
  \`{"command": <cmd>, "args": [...], "cwd": ..., "timeoutMs": ...}\` or
  \`{"judge": {"adapter": <slug>, "prompt": <text>}}\`. With a verify gate
  declared, \`update --status done\` does NOT close the task immediately —
  the gate runs after the reporting turn; the reply says \`verifying:true\`.

claim:
  \`--rev\` is required (the rev you last read — \`task list\` shows it).
  Over REST a claim is \`PATCH {rev, owner:"operator", status:"in_progress"}\`
  in operator context; unlike the MCP task_claim it may reassign an already
  owned task (the operator is a manager). A lost race answers 409 with the
  current record and this verb prints it for rebasing.

update:
  \`--rev\` is required — the ledger's rev-CAS is the mutation guard; a
  mismatch answers 409 and this verb prints the current record so you can
  rebase. \`--release\` sets owner:null (mutually exclusive with --owner;
  the ledger refuses combining it with a status change). \`--evidence-policy\`
  closes a verify-gated task off an already-PASSED completion policy
  without re-running it.

Examples:
  agentproto task create "Fix login redirect" --board-id ws:my-project
  agentproto task list --status pending --board-id ws:my-project
  agentproto task claim task_7 --rev 0
  agentproto task update task_7 --rev 2 --status done --note "tests green"
  agentproto task update task_7 --rev 3 --release
`

export async function runTask(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "create":
      return runCreate(rest)
    case "list":
    case "ls":
      return runList(rest)
    case "claim":
      return runClaim(rest)
    case "update":
      return runUpdate(rest)
    case undefined:
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto task: unknown subcommand "${sub}"\n` +
          `  Known: create | list | claim | update\n`,
      )
      return 2
  }
}

async function readJsonArg(raw: string, flagLabel: string): Promise<unknown> {
  const text = raw.startsWith("@")
    ? await readFile(resolve(raw.slice(1)), "utf8")
    : raw
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(
      `invalid ${flagLabel}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function withDaemon(
  verb: string,
): Promise<{ ok: true; endpoint: { url: string; token?: string } } | { ok: false; code: number }> {
  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, verb)
    return { ok: false, code: 3 }
  }
  return { ok: true, endpoint: report.found }
}

/** Minimal PATCH that returns status + parsed body without throwing on
 *  non-2xx — a rev-CAS conflict (409) is a FIRST-CLASS reply here
 *  (`{conflict:true, current}`), not an error. */
function rawPatch(
  url: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolveP, rejectP) => {
    const u = new URL(url)
    const payload = Buffer.from(JSON.stringify(body), "utf8")
    const lib = u.protocol === "https:" ? https : http
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": payload.byteLength.toString(),
    }
    if (token) headers.authorization = `Bearer ${token}`
    const req = lib.request(u, { method: "PATCH", headers }, res => {
      let raw = ""
      res.setEncoding("utf8")
      res.on("data", c => (raw += c))
      res.on("end", () => {
        let parsed: unknown = {}
        try {
          parsed = raw ? JSON.parse(raw) : {}
        } catch {
          parsed = { raw }
        }
        resolveP({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on("error", rejectP)
    req.write(payload)
    req.end()
  })
}

type TaskWriteReply = {
  task?: Record<string, unknown>
  verifying?: boolean
  error?: string
}

// ── create ───────────────────────────────────────────────────────────

async function runCreate(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      description: { type: "string" },
      "board-id": { type: "string" },
      owner: { type: "string" },
      "blocked-by": { type: "string", multiple: true },
      "meta-json": { type: "string" },
      "verify-json": { type: "string" },
      json: { type: "boolean", default: false },
    },
  })
  const fail = (msg: string): number => {
    process.stderr.write(`agentproto task create: ${msg}\n\n` + USAGE)
    return 2
  }
  const title = positionals[0]
  if (!title) return fail("missing <title>")
  let meta: unknown
  let verify: unknown
  try {
    if (values["meta-json"]) meta = await readJsonArg(values["meta-json"], "--meta-json")
    if (values["verify-json"]) verify = await readJsonArg(values["verify-json"], "--verify-json")
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  if (meta !== undefined && (typeof meta !== "object" || meta === null || Array.isArray(meta))) {
    return fail("--meta-json must be a JSON object (a string → string map)")
  }

  const daemon = await withDaemon("agentproto task create")
  if (!daemon.ok) return daemon.code
  const ep = daemon.endpoint
  let reply: TaskWriteReply
  try {
    reply = await httpPostJson<TaskWriteReply>(
      `${ep.url}/tasks`,
      {
        title,
        ...(values.description ? { description: values.description } : {}),
        ...(values["board-id"] ? { boardId: values["board-id"] } : {}),
        ...(values.owner ? { owner: values.owner } : {}),
        ...(values["blocked-by"]?.length ? { blockedBy: values["blocked-by"] } : {}),
        ...(meta !== undefined ? { meta } : {}),
        ...(verify !== undefined ? { verify } : {}),
      },
      ep.token,
    )
  } catch (err) {
    process.stderr.write(
      `agentproto task create: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  if (reply.error !== undefined) {
    process.stderr.write(`agentproto task create: ${String(reply.error)}\n`)
    return 1
  }
  return printWrite("create", reply, false)
}

function printWrite(
  verb: string,
  reply: TaskWriteReply,
  json: boolean,
): number {
  if (json) {
    process.stdout.write(JSON.stringify(reply, null, 2) + "\n")
    return 0
  }
  const task = reply.task ?? {}
  process.stdout.write(
    `\u2713 ${verb === "claim" ? "Claimed" : "Created"} ${String(task["taskId"] ?? "")} ` +
      `[${String(task["status"])}] on board ${String(task["boardId"])}` +
      `${task["verify"] !== undefined ? " · verify-gated" : ""}` +
      `${reply.verifying ? " (verify gate running — verifying:true)" : ""}\n` +
      `  rev: ${String(task["rev"])} — pass it on the next claim/update\n`,
  )
  return 0
}

// ── list ─────────────────────────────────────────────────────────────

async function runList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      "board-id": { type: "string" },
      status: { type: "string" },
      "include-closed": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  })
  const fail = (msg: string): number => {
    process.stderr.write(`agentproto task list: ${msg}\n\n` + USAGE)
    return 2
  }
  if (values.status && !(TASK_STATUSES as readonly string[]).includes(values.status)) {
    return fail(
      `invalid --status "${values.status}" (one of: ${TASK_STATUSES.join("|")})`,
    )
  }
  const daemon = await withDaemon("agentproto task list")
  if (!daemon.ok) return daemon.code
  const ep = daemon.endpoint
  const qs = new URLSearchParams()
  if (values["board-id"]) qs.set("boardId", values["board-id"])
  if (values.status) qs.set("status", values.status)
  if (values["include-closed"]) qs.set("includeClosed", "1")
  let body: { boardId?: string; tasks?: Array<Record<string, unknown>> }
  try {
    body = await httpGetJson(`${ep.url}/tasks${qs.toString() ? `?${qs}` : ""}`)
  } catch (err) {
    process.stderr.write(
      `agentproto task list: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  const tasks = body.tasks ?? []
  if (values.json) {
    process.stdout.write(JSON.stringify(body, null, 2) + "\n")
    return 0
  }
  process.stdout.write(
    `Board: ${body.boardId ?? "?"} — ${tasks.length} task(s)\n\n`,
  )
  for (const t of tasks) {
    process.stdout.write(
      `  ${String(t["taskId"])}  rev ${String(t["rev"])}  [${String(t["status"])}]` +
        `${t["owner"] !== undefined && t["owner"] !== null ? ` owner=${String(t["owner"])}` : " (claimable)"}\n` +
        `    ${String(t["title"])}\n` +
        (Array.isArray(t["blockedBy"]) && t["blockedBy"].length > 0
          ? `    blockedBy: ${(t["blockedBy"] as string[]).join(", ")}\n`
          : "") +
        (t["verify"] !== undefined ? `    verify-gated\n` : ""),
    )
  }
  return 0
}

// ── claim ────────────────────────────────────────────────────────────

async function runClaim(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      rev: { type: "string" },
      json: { type: "boolean", default: false },
    },
  })
  const taskId = positionals[0]
  if (!taskId) {
    process.stderr.write(
      "agentproto task claim: missing <taskId>.\n  Try: agentproto task list\n",
    )
    return 2
  }
  const fail = (msg: string): number => {
    process.stderr.write(`agentproto task claim: ${msg}\n\n` + USAGE)
    return 2
  }
  if (!values.rev) return fail("missing --rev <n> (the rev you last read — `task list` shows it)")
  // REST-claim convention (route docblock): PATCH {rev, owner, status:"in_progress"}
  return patch("claim", taskId, values, {
    owner: "operator",
    status: "in_progress",
  })
}

// ── update ───────────────────────────────────────────────────────────

async function runUpdate(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      rev: { type: "string" },
      status: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      "blocked-by": { type: "string", multiple: true },
      owner: { type: "string" },
      release: { type: "boolean", default: false },
      note: { type: "string" },
      "evidence-policy": { type: "string" },
      json: { type: "boolean", default: false },
    },
  })
  const taskId = positionals[0]
  if (!taskId) {
    process.stderr.write(
      "agentproto task update: missing <taskId>.\n  Try: agentproto task list\n",
    )
    return 2
  }
  if (values.release && values.owner) {
    process.stderr.write(
      "agentproto task update: --release and --owner are mutually exclusive\n",
    )
    return 2
  }
  if (values.status && !(TASK_STATUSES as readonly string[]).includes(values.status)) {
    process.stderr.write(
      `agentproto task update: invalid --status "${values.status}" (one of: ${TASK_STATUSES.join("|")})\n`,
    )
    return 2
  }
  const fail = (msg: string): number => {
    process.stderr.write(`agentproto task update: ${msg}\n\n` + USAGE)
    return 2
  }
  if (!values.rev) return fail("missing --rev <n> (the rev you last read — `task list` shows it)")
  const extra: Record<string, unknown> = {
    ...(values.status ? { status: values.status } : {}),
    ...(values.title ? { title: values.title } : {}),
    ...(values.description ? { description: values.description } : {}),
    ...(values["blocked-by"]?.length ? { blockedBy: values["blocked-by"] } : {}),
    ...(values.owner ? { owner: values.owner } : {}),
    ...(values.release ? { owner: null } : {}),
    ...(values.note ? { note: values.note } : {}),
    ...(values["evidence-policy"]
      ? { evidence: { policyId: values["evidence-policy"] } }
      : {}),
  }
  return patch("update", taskId, values, extra)
}

/** Shared PATCH plumbing for claim + update. `--rev` (validated by each
 *  caller) IS the destructive-verb confirmation — the ledger's rev-CAS —
 *  so no interactive prompt is added (that would break scripting). */
async function patch(
  verb: "claim" | "update",
  taskId: string,
  values: Record<string, string | boolean | string[] | undefined>,
  extraBody: Record<string, unknown>,
): Promise<number> {
  const rev = Number.parseInt(String(values.rev), 10)
  if (!Number.isInteger(rev) || rev < 0) {
    process.stderr.write(
      `agentproto task ${verb}: invalid --rev "${String(values.rev)}"\n`,
    )
    return 2
  }
  const json = values.json === true
  const daemon = await withDaemon(`agentproto task ${verb}`)
  if (!daemon.ok) return daemon.code
  const ep = daemon.endpoint
  const body = { rev, ...extraBody }
  const res = await rawPatch(
    `${ep.url}/tasks/${encodeURIComponent(taskId)}`,
    body,
    ep.token,
  )
  if (res.status === 404) {
    process.stderr.write(`agentproto task ${verb}: no task "${taskId}".\n  Try: agentproto task list\n`)
    return 3
  }
  if (res.status === 409) {
    const cur = ((res.body as Record<string, unknown>) ?? {})["current"]
    if (json) {
      process.stdout.write(JSON.stringify({ conflict: true, current: cur }, null, 2) + "\n")
    } else {
      const t = (cur ?? {}) as Record<string, unknown>
      process.stderr.write(
        `agentproto task ${verb}: conflict — someone moved first.\n` +
          `  Current: rev ${String(t["rev"])} [${String(t["status"])}]` +
          `${t["owner"] !== undefined && t["owner"] !== null ? ` owner=${String(t["owner"])}` : " (unowned)"}\n` +
          `  Rebase: retry with --rev ${String(t["rev"])}\n`,
      )
    }
    return 1
  }
  if (res.status < 200 || res.status >= 300) {
    process.stderr.write(
      `agentproto task ${verb}: HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 2000)}\n`,
    )
    return 1
  }
  const reply = res.body as TaskWriteReply
  if (reply.error !== undefined) {
    process.stderr.write(`agentproto task ${verb}: ${String(reply.error)}\n`)
    return 1
  }
  return printWrite(verb, reply, json)
}