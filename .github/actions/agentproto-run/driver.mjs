#!/usr/bin/env node
/**
 * Driver for the `agentproto-run` composite action.
 *
 * Boots `agentproto serve` in this workspace, waits for it to become
 * healthy, connects to its MCP endpoint (bearer token read from the
 * per-boot `.agentproto/runtime.json` this daemon itself writes), loads a
 * WORKFLOW.md via `workflow_run_file`, and polls `workflow_status` until
 * the run reaches a terminal status or `TIMEOUT_MINUTES` elapses.
 *
 * `agentproto run` (the one-shot CLI verb) is capped at one adapter session
 * dispatching one turn and has no notion of a WORKFLOW.md — real multi-step
 * orchestration (workflow_run_file, workflow_status, workflow_cancel) is
 * only exposed over the daemon's MCP transport, which is why this drives
 * `agentproto serve` over MCP instead of shelling out to `agentproto run`.
 *
 * Configuration is read entirely from environment variables (set by
 * action.yml via `env:`, never interpolated into a shell command string):
 *
 *   ADAPTER           adapter slug (e.g. "claude-code")           required
 *   WORKFLOW_PATH     path to WORKFLOW.md, relative to RUN_CWD    required
 *   WORKFLOW_INPUT    JSON string bound to `$input`                default '{}'
 *   RUN_CWD           workspace root for the daemon + sessions     default cwd
 *   TIMEOUT_MINUTES   hard ceiling on the poll loop                default '360'
 *   PORT              daemon HTTP port                             default '18790'
 *   ACTION_PATH       dir holding this script's own node_modules
 *                     (where `agentproto` was npm-installed)        default this dir
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const HERE = dirname(fileURLToPath(import.meta.url))

function requireEnv(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`driver: missing required env ${name}`)
    process.exit(1)
  }
  return v
}

const actionPath = process.env.ACTION_PATH ?? HERE
const adapter = requireEnv("ADAPTER")
const workflowPathInput = requireEnv("WORKFLOW_PATH")
const cwd = resolve(process.env.RUN_CWD || process.cwd())
const timeoutMinutes = Number(process.env.TIMEOUT_MINUTES ?? "360")
const port = Number(process.env.PORT ?? "18790")

let workflowInput
try {
  workflowInput = JSON.parse(process.env.WORKFLOW_INPUT ?? "{}")
} catch (err) {
  console.error(`driver: WORKFLOW_INPUT is not valid JSON: ${err.message}`)
  process.exit(1)
}

const workflowPath = isAbsolute(workflowPathInput)
  ? workflowPathInput
  : join(cwd, workflowPathInput)
if (!existsSync(workflowPath)) {
  console.error(`driver: workflow-path not found: ${workflowPath}`)
  process.exit(1)
}

const cliSource = process.env.CLI_SOURCE ?? "npm"

let agentprotoBin
if (cliSource === "workspace") {
  agentprotoBin = join(cwd, "packages", "cli", "dist", "cli.mjs")
  if (!existsSync(agentprotoBin)) {
    console.error(
      `driver: workspace CLI not found at ${agentprotoBin} — run pnpm build --filter @agentproto/cli first`,
    )
    process.exit(1)
  }
} else {
  agentprotoBin = join(actionPath, "node_modules", ".bin", "agentproto")
  if (!existsSync(agentprotoBin)) {
    console.error(
      `driver: agentproto bin not found at ${agentprotoBin} — did the npm install step run?`,
    )
    process.exit(1)
  }
}

const runtimeMetaPath = join(cwd, ".agentproto", "runtime.json")

// `agentproto serve --workspace <dir>` exits fast (code 2) if the dir
// doesn't already exist — ensure it does before spawning.
await mkdir(cwd, { recursive: true })

// Optional gateway/provider key injected onto the DAEMON's own process env
// under an arbitrary name (PROVIDER_KEY_ENV). This is how an Anthropic-
// compatible gateway spawn receives its bearer: the daemon spawns the adapter
// subprocess with `filterStringEnv(process.env)` (see
// packages/driver/agent-cli/src/define-agent-cli.ts), so any string env var on
// the daemon inherits to the child. For a gateway spawn (a `base_url` option is
// set, so the runtime skips native billing-auth resolution — session-spawn.ts's
// `hasGatewayBaseUrlOption`), no auth scrub runs, so e.g. ANTHROPIC_AUTH_TOKEN
// set here survives to the child and the SDK sends it as `Authorization:
// Bearer`. Empty ⇒ no-op (backward compatible: existing callers pass neither).
const providerKeyEnv = (process.env.PROVIDER_KEY_ENV ?? "").trim()
const providerKey = process.env.PROVIDER_KEY ?? ""
const daemonEnv = { ...process.env }
if (providerKeyEnv && providerKey) {
  daemonEnv[providerKeyEnv] = providerKey
  console.log(`driver: injected provider key env ${providerKeyEnv} into the daemon process env`)
}

// Timestamp fence for the agent_sessions_list fallback below — persisted
// sessions from BEFORE this boot are someone else's.
const driverStartedAt = Date.now()

console.log(
  `driver: booting agentproto serve --workspace ${cwd} --port ${port} (adapter=${adapter}, source=${cliSource})`,
)
const daemon = spawn(agentprotoBin, ["serve", "--workspace", cwd, "--port", String(port)], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: daemonEnv,
})
let daemonExited = false
daemon.on("exit", (code, signal) => {
  daemonExited = true
  console.log(`driver: daemon process exited (code=${code} signal=${signal})`)
})
daemon.stdout.on("data", (d) => process.stdout.write(`[daemon] ${d}`))
daemon.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`))

function killDaemon() {
  if (daemonExited) return
  try {
    daemon.kill("SIGTERM")
  } catch {
    // already gone
  }
}
process.on("SIGINT", () => {
  killDaemon()
  process.exit(130)
})
process.on("SIGTERM", () => {
  killDaemon()
  process.exit(143)
})

async function waitForDaemonHealthy(deadlineMs) {
  const healthUrl = `http://127.0.0.1:${port}/health`
  while (Date.now() < deadlineMs) {
    if (daemonExited) {
      throw new Error("daemon process exited before becoming healthy")
    }
    try {
      const res = await fetch(healthUrl)
      if (res.ok && existsSync(runtimeMetaPath)) return
    } catch {
      // not up yet — keep polling
    }
    await sleep(500)
  }
  throw new Error("timed out waiting for daemon /health + .agentproto/runtime.json")
}

async function readRuntimeToken() {
  const raw = await readFile(runtimeMetaPath, "utf8")
  const meta = JSON.parse(raw)
  if (!meta.token) throw new Error("runtime.json has no bearer token")
  return meta.token
}

function parseToolResult(result) {
  const text = result?.content?.[0]?.text
  if (typeof text !== "string") {
    throw new Error(`unexpected MCP tool result shape: ${JSON.stringify(result)}`)
  }
  return JSON.parse(text)
}

async function writeGithubOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  await appendFile(file, `${name}=${value}\n`, "utf8")
}

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"])

async function main() {
  await waitForDaemonHealthy(Date.now() + 120_000)
  const token = await readRuntimeToken()
  console.log("driver: daemon healthy, connecting MCP client")

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  )
  const client = new Client(
    { name: "agentproto-run-driver", version: "0.1.0" },
    { capabilities: {} },
  )
  await client.connect(transport)

  const startResult = await client.callTool({
    name: "workflow_run_file",
    arguments: { path: workflowPath, input: workflowInput, cwd },
  })
  const started = parseToolResult(startResult)
  if (started.error) throw new Error(`workflow_run_file failed: ${started.error}`)
  const { runId } = started
  console.log(`driver: started workflow run ${runId}`)

  const pollDeadline = Date.now() + timeoutMinutes * 60_000
  let run
  for (;;) {
    if (Date.now() > pollDeadline) {
      console.error(
        `driver: timed out after ${timeoutMinutes}m waiting for run ${runId} — cancelling`,
      )
      try {
        await client.callTool({ name: "workflow_cancel", arguments: { runId } })
      } catch (err) {
        console.error(`driver: workflow_cancel failed: ${err.message}`)
      }
      throw new Error(`workflow run ${runId} did not reach a terminal status within ${timeoutMinutes}m`)
    }
    const statusResult = await client.callTool({
      name: "workflow_status",
      arguments: { runId },
    })
    run = parseToolResult(statusResult)
    // `run.error` is ALSO a legitimate field on a normal, found WorkflowRun
    // (the failure reason once status reaches "failed") — only a MISSING
    // `status` means the tool call itself errored (e.g. "run not found").
    if (!run.status) throw new Error(`workflow_status failed: ${run.error ?? "unknown error"}`)
    if (TERMINAL_STATUSES.has(run.status)) break
    await sleep(3000)
  }

  console.log(`driver: run ${runId} reached terminal status=${run.status}`)

  // A failed run must explain itself: surface run.error and every step error
  // (the workflow-runner puts the failure reason there — e.g. an empty-turn or
  // adapter/auth failure) so CI logs show WHY, not just that it failed.
  if (run.status !== "done") {
    if (run.error) console.error(`driver: run error: ${run.error}`)
    for (const stage of Array.isArray(run.stages) ? run.stages : []) {
      for (const step of Array.isArray(stage?.steps) ? stage.steps : []) {
        if (step?.error) console.error(`driver: step '${step.label ?? step.id ?? "?"}' error: ${step.error}`)
      }
    }
  }

  // A workflow can report status="done" even when its agent step spawned a
  // session that exited clean with ZERO work — a SILENT NO-OP that otherwise
  // reads as success and lets the calling gate pass a PR nobody reviewed. Read
  // the real session output, log it (the only place the agent's own stderr
  // surfaces in CI), and treat an empty "done" as a failure so the caller's
  // fallback reviewer takes over.
  //
  // Session-id harvest, most- to least-structured:
  //   1. run.result.sessionIds + per-step sessionId (the runner now fills
  //      these on the FAILURE path too),
  //   2. `sess_…` ids embedded in run/step error strings (e.g. "session
  //      sess_ab12cd34 ended with status 'error'"),
  //   3. LAST RESORT, only when 1+2 found nothing: `agent_sessions_list`,
  //      filtered to sessions started after this driver booted the daemon —
  //      a daemon can carry persisted session state from previous runs
  //      (observed locally: an unfiltered list dumped megabytes of
  //      unrelated transcripts), so the list is diagnostic-only, never
  //      merged when structured ids exist, and never counts toward the
  //      silent-no-op gate below.
  // Without 2+3, a failed run whose state plumbing missed the id left CI
  // logs with a bare "status 'error'" and NOTHING else — undiagnosable.
  const sessionIds = new Set(Array.isArray(run?.result?.sessionIds) ? run.result.sessionIds : [])
  const stepErrors = []
  for (const stage of Array.isArray(run.stages) ? run.stages : []) {
    for (const step of Array.isArray(stage?.steps) ? stage.steps : []) {
      if (typeof step?.sessionId === "string" && step.sessionId) sessionIds.add(step.sessionId)
      if (typeof step?.error === "string" && step.error) stepErrors.push(step.error)
    }
  }
  const SESSION_ID_RE = /sess_[A-Za-z0-9-]+/g
  for (const text of [run.error, ...stepErrors]) {
    for (const match of String(text ?? "").matchAll(SESSION_ID_RE)) sessionIds.add(match[0])
  }
  const structuredIdCount = sessionIds.size
  let listedSessions = []
  try {
    const listed = parseToolResult(
      await client.callTool({ name: "agent_sessions_list", arguments: {} }),
    )
    listedSessions = Array.isArray(listed) ? listed : Array.isArray(listed?.sessions) ? listed.sessions : []
  } catch (err) {
    console.error(
      `driver: agent_sessions_list failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (structuredIdCount === 0) {
    for (const s of listedSessions) {
      if (typeof s?.id !== "string" || !s.id) continue
      const startedAt = Date.parse(String(s?.startedAt ?? ""))
      if (Number.isFinite(startedAt) && startedAt < driverStartedAt) continue
      sessionIds.add(s.id)
    }
  }
  console.log(
    `driver: run produced sessionIds=${JSON.stringify([...sessionIds])}` +
      (structuredIdCount === 0 && sessionIds.size > 0 ? " (recovered via agent_sessions_list)" : ""),
  )
  const failed = run.status !== "done"
  let sawAgentOutput = false
  // Provenance record per session — session_usage (cost/tokens) + descriptor
  // (adapter, sandbox, parentSessionId=supervisor). Emitted as the `provenance`
  // output so a delivery-specific step (e.g. the review-footer stamp) can sign
  // the artifact deterministically, without the model having to know its own id
  // or cost. Verb-agnostic: /pr and /fix can reuse it for a PR-body stamp.
  const provenance = []
  // Cap the dump fan-out — a pathological run should not flood the job log.
  for (const sid of [...sessionIds].slice(0, 8)) {
    const desc = listedSessions.find((s) => s?.id === sid)
    if (desc) {
      console.log(
        `driver: session ${sid} descriptor: status=${desc.status} adapter=${desc.adapterSlug ?? "?"} ` +
          `label=${desc.label ?? ""} remote=${desc.remote === true} sandboxId=${desc.sandboxId ?? ""}`,
      )
      let usage = {}
      try {
        usage = parseToolResult(
          await client.callTool({ name: "session_usage", arguments: { idOrName: sid } }),
        ) || {}
      } catch (err) {
        console.error(
          `driver: session_usage ${sid} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      provenance.push({
        sessionId: sid,
        label: desc.label ?? "",
        adapter: desc.adapterSlug ?? "",
        remote: desc.remote === true,
        sandboxId: desc.sandboxId ?? "",
        parentSessionId: desc.parentSessionId ?? "",
        model: usage.model ?? "",
        costUsd: typeof usage.costUsd === "number" ? usage.costUsd : undefined,
        tokensIn: typeof usage.tokensIn === "number" ? usage.tokensIn : undefined,
        tokensOut: typeof usage.tokensOut === "number" ? usage.tokensOut : undefined,
        source: usage.source ?? "none",
      })
    }
    let text = ""
    try {
      // On failure, dump the RAW ring buffer (clean:true strips [thought]/
      // [tool]/framing lines — exactly the adapter stderr and stack traces a
      // post-mortem needs). Keep clean output for the success path.
      const outRes = await client.callTool({
        name: "agent_output",
        arguments: { sessionId: sid, lastN: 400, clean: !failed },
      })
      const rawText = typeof outRes?.content?.[0]?.text === "string" ? outRes.content[0].text : ""
      // The tool returns JSON ({sessionId, status, lines: [...]}) — join the
      // actual lines so the emptiness check below sees the AGENT's output,
      // not the (always non-empty) JSON envelope.
      try {
        const parsed = JSON.parse(rawText)
        text = Array.isArray(parsed?.lines) ? parsed.lines.join("\n") : rawText
      } catch {
        text = rawText
      }
      console.log(`driver: ---- agent_output ${sid} ----\n${text}\n---- end agent_output ${sid} ----`)
      if (text.trim().length > 0) sawAgentOutput = true
    } catch (err) {
      console.error(
        `driver: agent_output ${sid} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // Empty buffer on a failed run: fall back to the daemon-captured
    // transcript (`agent_export` reads events.jsonl, which survives even
    // when the ring buffer never got a line — e.g. a spawn that died before
    // producing output).
    if (failed && text.trim().length === 0) {
      try {
        const expRes = await client.callTool({
          name: "agent_export",
          arguments: { sessionId: sid, format: "markdown" },
        })
        const transcript =
          typeof expRes?.content?.[0]?.text === "string" ? expRes.content[0].text : ""
        // Tail-cap the transcript — a long session's export can run to
        // megabytes, and the post-mortem needs the END of the conversation.
        const lines = transcript.split("\n")
        const tail = lines.slice(-200).join("\n")
        console.log(
          `driver: ---- agent_export ${sid} (last ${Math.min(lines.length, 200)}/${lines.length} lines) ----\n` +
            `${tail}\n---- end agent_export ${sid} ----`,
        )
      } catch (err) {
        console.error(
          `driver: agent_export ${sid} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  const silentNoop = run.status === "done" && (sessionIds.size === 0 || !sawAgentOutput)
  if (silentNoop) {
    console.error(
      "driver: run reached status=done but produced NO agent session output — treating " +
        "as FAILURE (silent no-op). The reviewer did not actually run; the calling job's " +
        "fallback reviewer should take over.",
    )
  }
  const finalStatus = silentNoop ? "failed" : run.status
  await writeGithubOutput("run-id", runId)
  await writeGithubOutput("status", finalStatus)
  // Single-line JSON (no newline) — safe for the `name=value` GITHUB_OUTPUT form.
  await writeGithubOutput("provenance", JSON.stringify(provenance))
  console.log(`driver: provenance=${JSON.stringify(provenance)}`)
  return finalStatus === "done" ? 0 : 1
}

let exitCode = 1
try {
  exitCode = await main()
} catch (err) {
  console.error(`driver: ${err instanceof Error ? err.message : String(err)}`)
  exitCode = 1
} finally {
  killDaemon()
}
process.exit(exitCode)
