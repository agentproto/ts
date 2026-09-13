/**
 * `agentproto workflow <start | run-file | status | list | cancel | resolve>`
 *
 * A thin CLI surface over the workflow_* MCP domain — the same
 * WorkflowRunner the MCP `workflow_start` / `workflow_run_file` /
 * `workflow_status` / `workflow_list` / `workflow_cancel` /
 * `workflow_escalation_resolve` tools drive. Zero daemon change: no route,
 * no schema, no behaviour the engine didn't already have.
 *
 * Transport per subcommand — each rides the route that already exists:
 *   - `status` / `list` / `cancel` use the REST twins
 *     (`GET /workflows`, `GET /workflows/:id`, `POST /workflows/:id/cancel`,
 *     http-server.ts `handleWorkflows`) — same WorkflowRunner instance.
 *   - `start`, `run-file` and `resolve` go through the daemon's stateless
 *     per-POST `/mcp` endpoint as bare JSON-RPC `tools/call` requests (no
 *     initialize handshake needed — each POST gets its own transport/server
 *     pair, http-server.ts `handleMcp`). Why not REST there:
 *       * there is NO REST route for `run-file` at all;
 *       * REST `POST /workflows` accepts only workflowId/stages/
 *         workspaceSlug/cwd/notifyUrl — the MCP schema's `cacheKey`,
 *         `appId`, `appRunId` and `item` have no REST surface;
 *       * REST `/workflows/:id/escalation/resolve` only understands the
 *         legacy escalate form (stageIndex/stepIndex/response) — the
 *         approval and suspend forms exist only on the MCP tool.
 *     Calling the MCP tool verbatim keeps full schema parity without
 *     inventing new REST semantics (which would be daemon change).
 *
 * `resolve` is the CLI name for `workflow_escalation_resolve` (the MCP
 * name doesn't fit `agentproto workflow <sub>` grammar). It carries all
 * three of the tool's forms:
 *   escalate  — --stage-index/--step-index/--response (answer a session
 *               that escalated via policy=escalate)
 *   approval  — [--approval-id] (--approve|--reject) [--who] [--note]
 *               (a parked `kind:"approval"` step)
 *   suspend   — --payload-json (resume a parked `kind:"suspend"` step)
 */

import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  discoverDaemon,
  printNoDaemonError,
  httpGetJson,
  httpPostJson,
} from "./_daemon-helpers.js"
import type { DaemonEndpoint } from "./_daemon-helpers.js"

const USAGE = `agentproto workflow — start, inspect and cancel workflow runs

Usage:
  agentproto workflow start --workflow-id <id> --stages-json <json|@file>
                            [--cwd <dir>] [--workspace-slug <slug>]
                            [--notify-url <url>] [--cache-key <key>]
                            [--app-id <appId>] [--app-run-id <appRunId>]
                            [--item <item>] [--json]
  agentproto workflow run-file <path>
                            [--input-json <json|@file>] [--cwd <dir>]
                            [--workspace-slug <slug>] [--cache-key <key>] [--json]
  agentproto workflow status <runId> [--json]
  agentproto workflow list [--json]
  agentproto workflow cancel <runId> [--json]
  agentproto workflow resolve <runId> (--approve | --reject)
                            [--approval-id <id>] [--who <name>] [--note <text>]
                            [--json]
  agentproto workflow resolve <runId> --stage-index <n> --step-index <n>
                            --response <text> [--json]
  agentproto workflow resolve <runId> --payload-json <json|@file> [--json]
  agentproto workflow --help

  <json|@file>: a JSON literal, or \`@<path>\` to read the value from a file
  (the sessions --options-json convention).

start:
  Ordered stages, each stage's steps run CONCURRENTLY; a barrier gates each
  next stage. Returns a runId immediately — the run executes in the
  background; poll with \`status\`. \`--stages-json\` must be an array of
  stages, each \`{ label?, steps: [...] }\`, steps of the shape the
  \`workflow_start\` MCP tool documents (agent / tool / command / approval /
  suspend / script kinds).
  Rides the daemon's /mcp gateway as the \`workflow_start\` tool (REST
  /workflows cannot carry cacheKey/appId/appRunId/item).

run-file:
  Load an AIP-15 WORKFLOW.md (+ optional entry.mjs) and run it through the
  same runner as \`start\`. Poll with \`status\`.
  Rides /mcp as the \`workflow_run_file\` tool (no REST twin exists).

cancel:
  Requires the explicit <runId>. In-flight steps finish; no NEW stages start.

resolve:
  Three mutually exclusive forms of the \`workflow_escalation_resolve\`
  MCP tool (ride /mcp — the REST resolve twin only covers the legacy
  escalate form):
    approval  \`--approve\`/\`--reject\` (+ optional \`--approval-id\` from
              \`status\`'s awaitingApproval, \`--who\` (default "human"),
              \`--note\`) — resumes the run on the approve/reject branch.
    suspend   \`--payload-json\` — resumes a run parked at a
              \`kind:"suspend"\` step.
    escalate  \`--stage-index <n> --step-index <n> --response <text>\` —
              injects an answer into a session that escalated
              (policy=escalate).

Examples:
  agentproto workflow start --workflow-id review-then-fix \\
    --stages-json @stages.json --cwd ~/code/my-app
  agentproto workflow run-file WORKFLOW.md --input-json '{"pr": 42}'
  agentproto workflow status wf_a1b2c3
  agentproto workflow list
  agentproto workflow cancel wf_a1b2c3
  agentproto workflow resolve wf_a1b2c3 --approve --who jeremy
`

export async function runWorkflow(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "start":
      return runStart(rest)
    case "run-file":
      return runRunFile(rest)
    case "status":
      return runStatus(rest)
    case "list":
    case "ls":
      return runList(rest)
    case "cancel":
      return runCancel(rest)
    case "resolve":
      return runResolve(rest)
    case undefined:
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto workflow: unknown subcommand "${sub}"\n` +
          `  Known: start | run-file | status | list | cancel | resolve\n`,
      )
      return 2
  }
}

/** Read a `--flag <json>` / `--flag @<file>` value (the sessions
 *  `--options-json` convention). */
async function readJsonArg(
  raw: string,
  flagLabel: string,
): Promise<unknown> {
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

// ── MCP-over-HTTP helper ─────────────────────────────────────────────

/**
 * Call a daemon MCP tool over the stateless per-POST `/mcp` endpoint as a
 * bare JSON-RPC `tools/call` (no initialize handshake needed — the daemon
 * rebuilds the transport/server pair per request). Unwraps the standard
 * `{ content: [{ type:"text", text }] }` reply into a parsed JSON payload
 * when the text is JSON, else the raw string. `isError` results reject.
 */
async function mcpToolCall(
  endpoint: DaemonEndpoint,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  }
  const res = await fetch(`${endpoint.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const ct = res.headers.get("content-type") ?? ""
  const raw = await res.text()
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 2000)}`)
  }
  let rpc: { result?: Record<string, unknown>; error?: unknown }
  if (ct.includes("text/event-stream")) {
    const dataLine = raw
      .split("\n")
      .find(l => l.startsWith("data:"))
    if (!dataLine) throw new Error(`/mcp returned an empty event stream`)
    rpc = JSON.parse(dataLine.slice(5).trim())
  } else {
    rpc = JSON.parse(raw)
  }
  if (rpc.error !== undefined) {
    throw new Error(`daemon replied with a JSON-RPC error: ${JSON.stringify(rpc.error)}`)
  }
  const result = rpc.result ?? {}
  if (result["isError"] === true) {
    throw new Error(textOf(result))
  }
  const text = textOf(result)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function textOf(result: Record<string, unknown>): string {
  const content = result["content"]
  if (Array.isArray(content)) {
    const first = content[0] as { type?: string; text?: string } | undefined
    if (first?.type === "text") return first.text ?? ""
  }
  return JSON.stringify(result)
}

async function withDaemon(
  verb: string,
): Promise<{ ok: true; endpoint: DaemonEndpoint } | { ok: false; code: number }> {
  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, verb)
    return { ok: false, code: 3 }
  }
  return { ok: true, endpoint: report.found }
}

// ── start ────────────────────────────────────────────────────────────

async function runStart(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      "workflow-id": { type: "string" },
      "stages-json": { type: "string" },
      cwd: { type: "string" },
      "workspace-slug": { type: "string" },
      "notify-url": { type: "string" },
      "cache-key": { type: "string" },
      "app-id": { type: "string" },
      "app-run-id": { type: "string" },
      item: { type: "string" },
      json: { type: "boolean", default: false },
    },
  })
  const fail = (msg: string): number => {
    process.stderr.write(`agentproto workflow start: ${msg}\n`)
    return 2
  }
  if (!values["workflow-id"]) return fail("missing --workflow-id <id>")
  if (!values["stages-json"]) {
    return fail("missing --stages-json <json|@file> (a non-empty stages array)")
  }
  let stages: unknown
  try {
    stages = await readJsonArg(values["stages-json"], "--stages-json")
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  if (!Array.isArray(stages) || stages.length === 0) {
    return fail("--stages-json must be a non-empty stages array")
  }

  const daemon = await withDaemon("agentproto workflow start")
  if (!daemon.ok) return daemon.code
  let result: Record<string, unknown>
  try {
    result = (await mcpToolCall(daemon.endpoint, "workflow_start", {
      workflowId: values["workflow-id"],
      stages,
      ...(values.cwd ? { cwd: values.cwd } : {}),
      ...(values["workspace-slug"] ? { workspaceSlug: values["workspace-slug"] } : {}),
      ...(values["notify-url"] ? { notifyUrl: values["notify-url"] } : {}),
      ...(values["cache-key"] ? { cacheKey: values["cache-key"] } : {}),
      ...(values["app-id"] ? { appId: values["app-id"] } : {}),
      ...(values["app-run-id"] ? { appRunId: values["app-run-id"] } : {}),
      ...(values.item ? { item: values.item } : {}),
    })) as Record<string, unknown>
  } catch (err) {
    process.stderr.write(
      `agentproto workflow start: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }
  process.stdout.write(
    `\u2713 Started workflow ${String(result["workflowId"] ?? values["workflow-id"])}` +
      ` — run ${String(result["runId"])} (${String(result["status"])}).\n` +
      `  Poll: agentproto workflow status ${String(result["runId"])}\n`,
  )
  return 0
}

// ── run-file ─────────────────────────────────────────────────────────

async function runRunFile(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "input-json": { type: "string" },
      cwd: { type: "string" },
      "workspace-slug": { type: "string" },
      "cache-key": { type: "string" },
      json: { type: "boolean", default: false },
    },
  })
  const path = positionals[0]
  if (!path) {
    process.stderr.write(
      "agentproto workflow run-file: missing <path> to a WORKFLOW.md\n",
    )
    return 2
  }
  let input: unknown
  if (values["input-json"]) {
    try {
      input = await readJsonArg(values["input-json"], "--input-json")
    } catch (err) {
      process.stderr.write(
        `agentproto workflow run-file: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return 2
    }
  }

  const daemon = await withDaemon("agentproto workflow run-file")
  if (!daemon.ok) return daemon.code
  let result: Record<string, unknown>
  try {
    result = (await mcpToolCall(daemon.endpoint, "workflow_run_file", {
      path,
      ...(input !== undefined ? { input } : {}),
      ...(values.cwd ? { cwd: values.cwd } : {}),
      ...(values["workspace-slug"] ? { workspaceSlug: values["workspace-slug"] } : {}),
      ...(values["cache-key"] ? { cacheKey: values["cache-key"] } : {}),
    })) as Record<string, unknown>
  } catch (err) {
    process.stderr.write(
      `agentproto workflow run-file: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  if (result["error"] !== undefined) {
    process.stderr.write(
      `agentproto workflow run-file: ${String(result["error"])}\n`,
    )
    return 1
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }
  process.stdout.write(
    `\u2713 Started workflow from ${path} — run ${String(result["runId"])} (${String(result["status"])}).\n` +
      `  Poll: agentproto workflow status ${String(result["runId"])}\n`,
  )
  return 0
}

// ── status ───────────────────────────────────────────────────────────

async function runStatus(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean", default: false } },
  })
  const runId = positionals[0]
  if (!runId) {
    process.stderr.write(
      "agentproto workflow status: missing <runId>.\n  Try: agentproto workflow list\n",
    )
    return 2
  }
  const daemon = await withDaemon("agentproto workflow status")
  if (!daemon.ok) return daemon.code
  let run: WorkflowRunShape
  try {
    run = await httpGetJson<WorkflowRunShape>(
      `${daemon.endpoint.url}/workflows/${encodeURIComponent(runId)}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(`agentproto workflow status: no run "${runId}".\n  Try: agentproto workflow list\n`)
      return 3
    }
    process.stderr.write(`agentproto workflow status: ${msg}\n`)
    return 1
  }
  return printRun(run, Boolean(values.json))
}

// ── list ─────────────────────────────────────────────────────────────

async function runList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean", default: false } },
  })
  const daemon = await withDaemon("agentproto workflow list")
  if (!daemon.ok) return daemon.code
  let body: { runs?: WorkflowRunShape[] }
  try {
    body = await httpGetJson<{ runs?: WorkflowRunShape[] }>(`${daemon.endpoint.url}/workflows`)
  } catch (err) {
    process.stderr.write(
      `agentproto workflow list: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  const runs = body.runs ?? []
  if (values.json) {
    process.stdout.write(JSON.stringify(body.runs ?? [], null, 2) + "\n")
    return 0
  }
  if (runs.length === 0) {
    process.stdout.write("No workflow runs.\n")
    return 0
  }
  process.stdout.write(`${runs.length} workflow run(s):\n\n`)
  for (const run of runs) {
    process.stdout.write(
      `  ${run.runId}\n` +
        `    Workflow: ${run.workflowId}\n` +
        `    Status:   ${run.status}${run.error ? ` (${run.error})` : ""}\n` +
        `    Started:  ${run.startedAt}\n` +
        (run.endedAt ? `    Ended:    ${run.endedAt}\n` : "") +
        (run.awaitingApproval
          ? `    Awaiting approval: ${run.awaitingApproval.approvalId} — ${run.awaitingApproval.prompt}\n`
          : "") +
        (run.awaitingSuspend
          ? `    Awaiting suspend resume (step ${run.awaitingSuspend.stepId}, on: ${JSON.stringify(run.awaitingSuspend.on)})\n`
          : "") +
        "\n",
    )
  }
  return 0
}

// ── cancel ───────────────────────────────────────────────────────────

async function runCancel(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean", default: false } },
  })
  const runId = positionals[0]
  if (!runId) {
    process.stderr.write(
      "agentproto workflow cancel: missing <runId>.\n  Try: agentproto workflow list\n",
    )
    return 2
  }
  const daemon = await withDaemon("agentproto workflow cancel")
  if (!daemon.ok) return daemon.code
  let result: { runId: string; status: string }
  try {
    result = await httpPostJson<{ runId: string; status: string }>(
      `${daemon.endpoint.url}/workflows/${encodeURIComponent(runId)}/cancel`,
      {},
      daemon.endpoint.token,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(`agentproto workflow cancel: no run "${runId}".\n  Try: agentproto workflow list\n`)
      return 3
    }
    process.stderr.write(`agentproto workflow cancel: ${msg}\n`)
    return 1
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }
  process.stdout.write(
    `\u2713 Cancelled ${result.runId} → ${result.status} (in-flight steps finish; no new stages start)\n`,
  )
  return 0
}

// ── resolve ──────────────────────────────────────────────────────────

async function runResolve(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "stage-index": { type: "string" },
      "step-index": { type: "string" },
      response: { type: "string" },
      "approval-id": { type: "string" },
      approve: { type: "boolean" },
      reject: { type: "boolean" },
      who: { type: "string" },
      note: { type: "string" },
      "payload-json": { type: "string" },
      json: { type: "boolean", default: false },
    },
  })
  const fail = (msg: string): number => {
    process.stderr.write(`agentproto workflow resolve: ${msg}\n\n` + USAGE)
    return 2
  }
  const runId = positionals[0]
  if (!runId) return fail("missing <runId>")

  const approvalForm =
    values.approve !== undefined ||
    values.reject !== undefined ||
    values["approval-id"] !== undefined ||
    values.note !== undefined
  const suspendForm = values["payload-json"] !== undefined
  const escalateForm =
    values["stage-index"] !== undefined ||
    values["step-index"] !== undefined ||
    values.response !== undefined

  const forms = [approvalForm, suspendForm, escalateFormGiven(values)].filter(Boolean).length
  if (forms > 1) {
    return fail(
      "forms are mutually exclusive: (--approve|--reject), --payload-json, --stage-index/--step-index/--response",
    )
  }

  let toolArgs: Record<string, unknown>
  if (suspendForm) {
    let payload: unknown
    try {
      payload = await readJsonArg(values["payload-json"]!, "--payload-json")
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    toolArgs = { runId, payload }
  } else if (escalateFormGiven(values)) {
    if (
      values["stage-index"] === undefined ||
      values["step-index"] === undefined ||
      values.response === undefined
    ) {
      return fail(
        "the escalate form requires --stage-index <n>, --step-index <n> and --response <text>",
      )
    }
    const stageIndex = Number.parseInt(values["stage-index"], 10)
    const stepIndex = Number.parseInt(values["step-index"], 10)
    if (!Number.isInteger(stageIndex) || stageIndex < 0) {
      return fail(`invalid --stage-index "${values["stage-index"]}"`)
    }
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      return fail(`invalid --step-index "${values["step-index"]}"`)
    }
    toolArgs = { runId, stageIndex, stepIndex, response: values.response }
  } else {
    if (values.approve === values.reject) {
      return fail("the approval form requires exactly one of --approve or --reject")
    }
    toolArgs = {
      runId,
      ...(values["approval-id"] !== undefined ? { approvalId: values["approval-id"] } : {}),
      approved: values.approve === true,
      ...(values.who ? { who: values.who } : {}),
      ...(values.note ? { note: values.note } : {}),
    }
  }

  const daemon = await withDaemon("agentproto workflow resolve")
  if (!daemon.ok) return daemon.code
  let result: Record<string, unknown>
  try {
    result = (await mcpToolCall(
      daemon.endpoint,
      "workflow_escalation_resolve",
      toolArgs,
    )) as Record<string, unknown>
  } catch (err) {
    process.stderr.write(
      `agentproto workflow resolve: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  if (result["error"] !== undefined) {
    process.stderr.write(
      `agentproto workflow resolve: ${String(result["error"])}${result["message"] ? ` — ${String(result["message"])}` : ""}\n`,
    )
    return 1
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }
  const status = result["status"] !== undefined ? ` → ${String(result["status"])}` : ""
  process.stdout.write(`\u2713 Resolved ${runId}${status}\n`)
  return 0
}

function escalateFormGiven(
  values: Record<string, string | boolean | string[] | undefined>,
): boolean {
  return (
    values["stage-index"] !== undefined ||
    values["step-index"] !== undefined ||
    values.response !== undefined
  )
}

// shared TS narrow for the REST /workflows run shape (structural only)
interface WorkflowRunShape {
  runId: string
  workflowId: string
  status: string
  startedAt: string
  endedAt?: string
  error?: string
  awaitingApproval?: { approvalId: string; prompt: string; since: string }
  awaitingSuspend?: { stepId: string; on: string[]; since: string }
  stages?: Array<Record<string, unknown>>
}

function printRun(run: WorkflowRunShape, json: boolean): number {
  if (json) {
    process.stdout.write(JSON.stringify(run, null, 2) + "\n")
    return 0
  }
  let out = `Run ${run.runId} — ${run.workflowId}\n` +
    `  Status:  ${run.status}${run.error ? ` (${run.error})` : ""}\n` +
    `  Started: ${run.startedAt}\n`
  if (run.endedAt) out += `  Ended:   ${run.endedAt}\n`
  if (run.awaitingApproval) {
    out += `  Awaiting approval: ${run.awaitingApproval.approvalId} — ${run.awaitingApproval.prompt}\n` +
      `  Resolve: agentproto workflow resolve ${run.runId} (--approve|--reject) --who <name>\n`
  }
  if (run.awaitingSuspend) {
    out += `  Awaiting suspend resume: step ${run.awaitingSuspend.stepId} (on: ${JSON.stringify(run.awaitingSuspend.on)})\n` +
      `  Resume:  agentproto workflow resolve ${run.runId} --payload-json <json|@file>\n`
  }
  for (const stage of run.stages ?? []) {
    const label = stage["label"] !== undefined ? ` (${String(stage["label"])})` : ""
    out += `  Stage ${String(stage["index"])}${label}: ${String(stage["status"])}\n`
    for (const step of (stage["steps"] as Array<Record<string, unknown>>) ?? []) {
      const sid = step["sessionId"] ? ` · session ${String(step["sessionId"])}` : ""
      const err = step["error"] ? ` — ${String(step["error"])}` : ""
      const stepId = step["id"] !== undefined ? String(step["id"]) : String(step["index"] ?? "?")
      out += `    step ${stepId}: ${String(step["status"])}${sid}${err}\n`
    }
  }
  process.stdout.write(out.replace(/\n$/, "") + "\n")
  return 0
}