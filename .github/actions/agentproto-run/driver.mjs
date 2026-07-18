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

const agentprotoBin = join(actionPath, "node_modules", ".bin", "agentproto")
if (!existsSync(agentprotoBin)) {
  console.error(
    `driver: agentproto bin not found at ${agentprotoBin} — did the npm install step run?`,
  )
  process.exit(1)
}

const runtimeMetaPath = join(cwd, ".agentproto", "runtime.json")

// `agentproto serve --workspace <dir>` exits fast (code 2) if the dir
// doesn't already exist — ensure it does before spawning.
await mkdir(cwd, { recursive: true })

console.log(
  `driver: booting agentproto serve --workspace ${cwd} --port ${port} (adapter=${adapter})`,
)
const daemon = spawn(agentprotoBin, ["serve", "--workspace", cwd, "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
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
  // Unconditional diagnostics — a "done" run that silently no-op'd (e.g. the
  // agent's turn ended without acting) is otherwise a total CI black box:
  // the only thing ever logged was the top-level status. Per-step state
  // (sessionId, timestamps, error) and each session's output tail cost one
  // cheap extra round trip each and let a red/suspicious run be diagnosed
  // straight from the Action log instead of needing a live daemon to inspect.
  console.log(`driver: run stages:\n${JSON.stringify(run.stages ?? [], null, 2)}`)
  const sessionIds = new Set()
  for (const stage of run.stages ?? []) {
    for (const step of stage.steps ?? []) {
      if (step.sessionId) sessionIds.add(step.sessionId)
    }
  }
  for (const sessionId of sessionIds) {
    try {
      const outputResult = await client.callTool({
        name: "agent_output",
        arguments: { sessionId, lastN: 200, clean: true },
      })
      const output = parseToolResult(outputResult)
      console.log(
        `driver: session ${sessionId} output tail:\n${(output.lines ?? []).join("\n")}`,
      )
    } catch (err) {
      console.error(
        `driver: failed to fetch output for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  await writeGithubOutput("run-id", runId)
  await writeGithubOutput("status", run.status)
  return run.status === "done" ? 0 : 1
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
