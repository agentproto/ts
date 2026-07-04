#!/usr/bin/env node
/**
 * Real, runnable smoke test against a LIVE agentproto daemon's REST API —
 * not unit tests, not a synthetic in-process daemon. Exercises 5 features
 * merged to main on 2026-07-01 that have never been checked against an
 * actual running daemon:
 *
 *   1. cron scheduler                              (#140)
 *   2. session liveness (pid / lastActivityAt)      (#144)
 *   3. orchestrator daemon-mcp default-mount        (#138 / #142)
 *   4. claude-code plan mode                        (#143)
 *   5. hermes turn-idle watchdog (manifest wiring)  (#145)
 *
 * Usage:
 *   node scripts/smoke-local-daemon.mjs [--skip-live-llm] [--base-url=http://127.0.0.1:18790]
 *
 * --skip-live-llm  Skip sub-checks that require a real LLM turn (the
 *                  claude-code plan-mode check, and the "lastActivityAt
 *                  advances on activity" sub-check of session liveness).
 *                  Everything else still runs. Default: OFF (i.e. those
 *                  checks run — they're cheap, single-turn prompts).
 *
 * Exit code 0 when every non-skipped check passes; 1 if any fails.
 *
 * ── Before running this against a rebuilt daemon ──────────────────────
 * `~/.agentproto/start-daemon-local.sh --cli workspace` always execs
 * `node <MAIN-TREE>/packages/cli/dist/cli.mjs` — a path hardcoded to the
 * main checkout at products/agentik/agentik-studio/projects/agentproto/ts,
 * NOT whatever worktree this script happens to live in. Verified
 * empirically: a git worktree only shares `.git`; `node_modules/` and
 * `dist/` are per-checkout, so a worktree has neither until you run
 * `pnpm install && pnpm -r build` inside IT specifically. Restarting the
 * daemon after editing code in a worktree silently keeps running the
 * main tree's stale dist — `pnpm -r build` MUST run in the main tree
 * checkout, not here, or the restart is a no-op as far as the daemon's
 * behavior is concerned.
 *
 * This script itself has no such constraint — it only speaks HTTP to
 * whatever daemon is listening at --base-url, plus one static source
 * read (check 5) resolved relative to ITS OWN checkout (portable: the
 * source it reads is identical across checkouts at the same commit).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "..")

const argv = process.argv.slice(2)
const SKIP_LIVE_LLM = argv.includes("--skip-live-llm")
const baseUrlArg = argv.find(a => a.startsWith("--base-url="))
const BASE_URL = (baseUrlArg ? baseUrlArg.slice("--base-url=".length) : "http://127.0.0.1:18790").replace(/\/+$/, "")

// ── tiny utils ─────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function fetchWithTimeout(url, init, timeoutMs) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

async function httpJson(method, path, body, opts = {}) {
  const headers = { "content-type": "application/json" }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const res = await fetchWithTimeout(
    `${BASE_URL}${path}`,
    { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
    opts.timeoutMs ?? 30_000,
  )
  const text = await res.text()
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      // non-JSON body — leave json null, caller inspects `text`
    }
  }
  return { status: res.status, json, text }
}

// The MCP Streamable HTTP transport (stateless mode — see http-server.ts's
// `serveMcp`) answers a single tools/call POST with either a plain JSON
// body or an SSE-framed `event: message\ndata: {...}` line depending on
// negotiation. Handle both.
function parseJsonRpcResponse(text) {
  try {
    return JSON.parse(text)
  } catch {
    // fall through to SSE framing
  }
  const line = text.split("\n").find(l => l.startsWith("data: "))
  if (!line) throw new Error(`unparseable MCP response body: ${text.slice(0, 300)}`)
  return JSON.parse(line.slice("data: ".length))
}

let mcpIdCounter = 0
async function mcpToolCall(name, args) {
  const id = ++mcpIdCounter
  const res = await fetchWithTimeout(
    `${BASE_URL}/mcp`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    },
    60_000,
  )
  const text = await res.text()
  const payload = parseJsonRpcResponse(text)
  if (payload.error) throw new Error(`mcp ${name}: protocol error ${JSON.stringify(payload.error)}`)
  const result = payload.result
  const textOut = result?.content?.[0]?.text
  if (result?.isError) throw new Error(`mcp ${name}: tool error — ${textOut ?? JSON.stringify(result)}`)
  if (!textOut) throw new Error(`mcp ${name}: no content[0].text in response: ${JSON.stringify(result)}`)
  try {
    return JSON.parse(textOut)
  } catch {
    throw new Error(`mcp ${name}: content text was not JSON: ${textOut}`)
  }
}

async function pollUntil(checkFn, { timeoutMs, intervalMs = 5000, label = "condition" }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await checkFn()
    if (result.done) return result.value
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    }
    await sleep(intervalMs)
  }
}

function mkScratchDir(label) {
  return mkdtempSync(join(tmpdir(), `agentproto-smoke-${label}-`))
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function loadSessionsToken(workspace) {
  const runtimeJsonPath = join(workspace, ".agentproto", "runtime.json")
  // writeRuntimeMeta() runs during createGateway boot — give it a few
  // seconds to land after /health starts answering.
  for (let i = 0; i < 10; i++) {
    if (existsSync(runtimeJsonPath)) {
      try {
        const meta = JSON.parse(readFileSync(runtimeJsonPath, "utf8"))
        if (typeof meta.token === "string" && meta.token) return meta.token
      } catch {
        // fall through to retry
      }
    }
    await sleep(1000)
  }
  return null
}

// ── check 1: cron scheduler (#140) ──────────────────────────────────────

async function checkCronScheduler(ctx) {
  const allowlistPath = join(ctx.workspace, ".agentproto", "allowed-commands.json")
  assert(existsSync(allowlistPath), `allowlist file not found at ${allowlistPath}`)
  const allowlist = new Set(JSON.parse(readFileSync(allowlistPath, "utf8")).commands ?? [])
  const disallowedCandidates = ["curl", "wget", "sudo", "rm", "python3"]
  const disallowed = disallowedCandidates.find(c => !allowlist.has(c)) ?? "definitely-not-a-real-command-xyz"

  const notes = []

  // (a) negative allowlist test — forced via manual /run, no waiting needed.
  const negCreate = await httpJson("POST", "/cron", {
    label: `smoke-negative-${Date.now()}`,
    schedule: "0 0 1 1 *", // once a year — never fires on its own during this run
    recurring: false,
    action: { kind: "command", command: disallowed, args: [] },
  })
  assert(negCreate.status === 201, `failed to create negative-test cron job: HTTP ${negCreate.status} ${JSON.stringify(negCreate.json)}`)
  const negId = negCreate.json.id
  ctx.cleanupCronJobs.push(negId)
  const negRun = await httpJson("POST", `/cron/${negId}/run`)
  assert(negRun.status === 200, `manual run of negative-test job failed unexpectedly: HTTP ${negRun.status} ${JSON.stringify(negRun.json)}`)
  const negResult = negRun.json.result
  assert(negResult?.ok === false, `expected disallowed command '${disallowed}' to be rejected, got ${JSON.stringify(negResult)}`)
  assert(/allowlist/i.test(negResult.summary ?? ""), `expected an allowlist rejection message, got: ${negResult?.summary}`)
  notes.push(`non-allowlisted command '${disallowed}' correctly rejected`)

  // (b) one-shot job — must fire via the REAL tick loop (not manual /run).
  const sentinel = `smoke-test-cron-oneshot-${Date.now()}`
  const oneShotCreate = await httpJson("POST", "/cron", {
    label: `smoke-oneshot-${Date.now()}`,
    schedule: "* * * * *",
    recurring: false,
    action: { kind: "command", command: "echo", args: [sentinel] },
  })
  assert(oneShotCreate.status === 201, `failed to create one-shot cron job: HTTP ${oneShotCreate.status} ${JSON.stringify(oneShotCreate.json)}`)
  const oneShotId = oneShotCreate.json.id
  ctx.cleanupCronJobs.push(oneShotId)

  // (c) pre-existing recurring job — proves cron persistence survives a
  // cold daemon restart (this job was created before the restart, against
  // a daemon build that predates the cron feature entirely).
  const listRes = await httpJson("GET", "/cron")
  assert(listRes.status === 200, `GET /cron failed: HTTP ${listRes.status}`)
  const recurringJob = (listRes.json?.jobs ?? []).find(j => j.label === "test-recurring")

  const POLL_TIMEOUT_MS = 90_000
  const POLL_INTERVAL_MS = 5_000

  const waitOneShot = pollUntil(
    async () => {
      const r = await httpJson("GET", `/cron/${oneShotId}`)
      if (r.status === 200 && r.json.active === false) return { done: true, value: r.json }
      return { done: false }
    },
    { timeoutMs: POLL_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS, label: "one-shot cron job to fire and deactivate" },
  )

  const waitRecurring = recurringJob
    ? (recurringJob.lastRunAt && new Date(recurringJob.lastRunAt).getTime() > ctx.daemonStartedAt
        ? Promise.resolve(recurringJob) // already fired post cold-restart by the time we first checked
        : pollUntil(
            async () => {
              const r = await httpJson("GET", `/cron/${recurringJob.id}`)
              if (r.status === 200 && r.json.lastRunAt && new Date(r.json.lastRunAt).getTime() > ctx.daemonStartedAt) {
                return { done: true, value: r.json }
              }
              return { done: false }
            },
            { timeoutMs: POLL_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS, label: "pre-existing recurring job to fire post-restart" },
          ))
    : Promise.resolve(null)

  const [oneShotFinal, recurringFinal] = await Promise.all([waitOneShot, waitRecurring])

  assert(oneShotFinal.lastResult?.ok === true, `one-shot job fired but lastResult.ok !== true: ${JSON.stringify(oneShotFinal.lastResult)}`)
  assert((oneShotFinal.lastResult.summary ?? "").includes(sentinel), `one-shot job's output did not include the sentinel: ${oneShotFinal.lastResult.summary}`)
  notes.push("one-shot job fired via the real tick loop and deactivated")

  if (!recurringJob) {
    notes.push("pre-existing 'test-recurring' job not found in ~/.agentproto/cron-jobs.json — persistence sub-check skipped")
  } else {
    notes.push(`pre-existing recurring job survived cold restart (lastRunAt=${recurringFinal.lastRunAt})`)
  }

  return { message: notes.join("; ") }
}

// ── check 2: session liveness (#144) ────────────────────────────────────

async function checkSessionLiveness(ctx) {
  const scratch = mkScratchDir("liveness")
  ctx.cleanupDirs.push(scratch)

  const spawnRes = await httpJson(
    "POST",
    "/sessions/agent",
    { adapter: "claude-code", cwd: scratch, label: "smoke-liveness" },
    { token: ctx.sessionsToken, timeoutMs: 60_000 },
  )
  assert(spawnRes.status === 201, `POST /sessions/agent failed: HTTP ${spawnRes.status} ${JSON.stringify(spawnRes.json)}`)
  const desc = spawnRes.json
  ctx.cleanupSessions.push(desc.id)

  assert(typeof desc.pid === "number" && desc.pid > 0, `expected a real subprocess pid on spawn, got ${JSON.stringify(desc.pid)}`)

  const getRes = await httpJson("GET", `/sessions/${desc.id}`)
  assert(getRes.status === 200, `GET /sessions/:id failed: HTTP ${getRes.status}`)
  assert(getRes.json.pid === desc.pid, `pid changed between spawn response and GET: ${desc.pid} -> ${getRes.json.pid}`)
  assert(getRes.json.processAlive === true, `expected processAlive === true for a just-spawned session, got ${JSON.stringify(getRes.json.processAlive)}`)

  let activityNote
  if (SKIP_LIVE_LLM) {
    activityNote = "lastActivityAt-advances sub-check skipped (--skip-live-llm)"
  } else {
    // lastActivityAt is only pulsed by real ACP traffic (session/new's own
    // handshake races the id-assignment window and is dropped — see
    // agent-tools.ts's `liveSessionId` box comment) — a real turn is the
    // only reliable way to observe it get stamped.
    const promptRes = await httpJson(
      "POST",
      `/sessions/${desc.id}/prompt`,
      { prompt: "Reply with exactly the word OK and nothing else. Do not call any tools." },
      { token: ctx.sessionsToken, timeoutMs: 60_000 },
    )
    assert(promptRes.status === 200, `POST /sessions/:id/prompt failed: HTTP ${promptRes.status} ${JSON.stringify(promptRes.json)}`)
    const afterRes = await httpJson("GET", `/sessions/${desc.id}`)
    assert(typeof afterRes.json.lastActivityAt === "string", `expected lastActivityAt to be stamped after a real turn, got ${JSON.stringify(afterRes.json.lastActivityAt)}`)
    activityNote = `lastActivityAt=${afterRes.json.lastActivityAt}`
  }

  return { message: `pid=${desc.pid}, processAlive=true, ${activityNote}` }
}

// ── check 3: orchestrator daemon-mcp default-mount (#138 / #142) ───────

async function checkOrchestratorMount(ctx) {
  const scratch = mkScratchDir("orchestrator")
  ctx.cleanupDirs.push(scratch)

  // `orchestrator: true` is only recognized by the `agent_start` MCP tool
  // (agent-tools.ts) — the raw REST POST /sessions/agent route does not
  // parse it at all, so this MUST go through /mcp, not the REST endpoint.
  const desc = await mcpToolCall("agent_start", {
    adapter: "claude-code",
    cwd: scratch,
    orchestrator: true,
    label: "smoke-orchestrator-mount",
  })
  ctx.cleanupSessions.push(desc.id)

  const entries = Array.isArray(desc.mcpServers) ? desc.mcpServers : []
  const scopeRefPattern = new RegExp(`^${escapeRegExp(BASE_URL)}/mcp/orchestrator\\?scope=`)
  const match = entries.find(e => typeof e?.ref === "string" && scopeRefPattern.test(e.ref))
  assert(match, `expected an mcpServers entry with ref matching ${scopeRefPattern}; got ${JSON.stringify(entries)}`)

  return { message: `auto-mounted ${match.ref}` }
}

// ── check 4: claude-code plan mode (#143) ───────────────────────────────

async function checkClaudeCodePlanMode(ctx) {
  if (SKIP_LIVE_LLM) {
    return { skipped: true, message: "skipped via --skip-live-llm (requires a real LLM turn)" }
  }

  const scratch = mkScratchDir("plan-mode")
  ctx.cleanupDirs.push(scratch)
  try {
    execFileSync("git", ["init", "-q"], { cwd: scratch })
  } catch {
    // best-effort — claude-code should tolerate a non-git scratch dir too
  }

  const spawnRes = await httpJson(
    "POST",
    "/sessions/agent",
    { adapter: "claude-code", mode: "plan", cwd: scratch, label: "smoke-plan-mode" },
    { token: ctx.sessionsToken, timeoutMs: 60_000 },
  )
  assert(spawnRes.status === 201, `POST /sessions/agent (mode=plan) failed: HTTP ${spawnRes.status} ${JSON.stringify(spawnRes.json)}`)
  const desc = spawnRes.json
  ctx.cleanupSessions.push(desc.id)

  const canaryPath = join(scratch, "canary.txt")
  const promptRes = await httpJson(
    "POST",
    `/sessions/${desc.id}/prompt?wait=false`,
    { prompt: "Create a file named canary.txt in the current directory containing the text HELLO. Do this now." },
    { token: ctx.sessionsToken, timeoutMs: 15_000 },
  )
  assert(promptRes.status === 202, `expected 202 (queued) from fire-and-forget prompt, got HTTP ${promptRes.status} ${JSON.stringify(promptRes.json)}`)

  // Plan mode proposes a plan and awaits approval rather than cleanly
  // finishing a turn, so `event=any` (turn-end OR awaiting-input OR
  // exited) is the right target — we don't assume which one it lands on.
  const waitRes = await httpJson("GET", `/sessions/${desc.id}/wait?event=any&timeoutMs=45000`, undefined, { timeoutMs: 50_000 })
  const waitNote = waitRes.json?.event
    ? `turn reached '${waitRes.json.event}'`
    : "no lifecycle event observed within 45s (informational only — the pass/fail signal is the file check below)"

  const exists = existsSync(canaryPath)
  assert(!exists, `plan mode did NOT block the write — ${canaryPath} was created`)

  return { message: `${waitNote}; canary.txt correctly absent from ${scratch}` }
}

// ── check 5: hermes turn-idle watchdog manifest (#145) ──────────────────

async function checkHermesWatchdogManifest() {
  // A live hang reproduction requires hermes to actually hit its
  // max-tool-iterations ceiling, which the PR author flagged as not
  // reliably reproducible on demand — see unit tests in PR #145
  // (packages/acp/src/__tests__/client-turn-idle-watchdog.test.ts) for
  // the actual hang/recovery coverage. This check only confirms the
  // manifest field the watchdog reads is actually declared and wired.
  const filePath = join(REPO_ROOT, "adapters/hermes/src/index.ts")
  assert(existsSync(filePath), `adapter source not found at ${filePath}`)
  const src = readFileSync(filePath, "utf8")
  const match = src.match(/turn_idle_timeout_ms:\s*([\d_]+)/)
  assert(match, `turn_idle_timeout_ms not declared in ${filePath}`)
  const ms = Number(match[1].replace(/_/g, ""))
  assert(Number.isFinite(ms) && ms > 0, `turn_idle_timeout_ms parsed to a non-positive value: ${match[1]}`)

  return {
    message:
      `static check only (live hang not reproduced — see PR #145's client-turn-idle-watchdog.test.ts): ` +
      `hermes manifest declares turn_idle_timeout_ms=${ms}`,
  }
}

// ── runner ───────────────────────────────────────────────────────────────

async function runCheck(results, name, fn) {
  const start = Date.now()
  process.stdout.write(`\n[${name}]\n`)
  try {
    const outcome = await fn()
    const ms = Date.now() - start
    if (outcome?.skipped) {
      console.log(`  SKIP (${ms}ms) - ${outcome.message}`)
      results.push({ name, status: "skip", message: outcome.message })
    } else {
      console.log(`  PASS (${ms}ms) - ${outcome?.message ?? ""}`)
      results.push({ name, status: "pass", message: outcome?.message ?? "" })
    }
  } catch (err) {
    const ms = Date.now() - start
    console.log(`  FAIL (${ms}ms) - ${err.message}`)
    results.push({ name, status: "fail", message: err.message })
  }
}

async function cleanup(ctx) {
  for (const id of ctx.cleanupSessions) {
    try {
      await mcpToolCall("agent_kill", { sessionId: id })
    } catch (err) {
      console.warn(`cleanup: failed to kill session ${id}: ${err.message}`)
    }
  }
  for (const id of ctx.cleanupCronJobs) {
    try {
      await httpJson("DELETE", `/cron/${id}`)
    } catch (err) {
      console.warn(`cleanup: failed to delete cron job ${id}: ${err.message}`)
    }
  }
  for (const dir of ctx.cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}

function printSummary(results) {
  console.log("\n==== Summary ====")
  for (const r of results) {
    console.log(`${r.status.toUpperCase().padEnd(4)} ${r.name}`)
  }
  const total = results.length
  const passed = results.filter(r => r.status === "pass").length
  const failed = results.filter(r => r.status === "fail").length
  const skipped = results.filter(r => r.status === "skip").length
  console.log(`\n${passed}/${total} passed, ${failed} failed, ${skipped} skipped`)
}

async function main() {
  console.log(`Smoke test target: ${BASE_URL}`)
  const health = await httpJson("GET", "/health")
  if (health.status !== 200) {
    console.error(`FATAL: GET /health returned HTTP ${health.status} — is the daemon running at ${BASE_URL}?`)
    process.exit(1)
  }
  console.log(`daemon workspace=${health.json.workspace} uptimeMs=${health.json.uptimeMs}`)
  const daemonStartedAt = Date.now() - health.json.uptimeMs
  const workspace = health.json.workspace

  const sessionsToken = await loadSessionsToken(workspace)
  if (!sessionsToken) {
    console.warn(
      `WARNING: no per-boot bearer token found at ${join(workspace, ".agentproto", "runtime.json")} — ` +
        `mutating /sessions/* calls will 401 and their checks will fail with that error.`,
    )
  }

  const ctx = {
    workspace,
    daemonStartedAt,
    sessionsToken,
    cleanupSessions: [],
    cleanupCronJobs: [],
    cleanupDirs: [],
  }

  const results = []
  await runCheck(results, "1. cron scheduler (#140)", () => checkCronScheduler(ctx))
  await runCheck(results, "2. session liveness (#144)", () => checkSessionLiveness(ctx))
  await runCheck(results, "3. orchestrator daemon-mcp default-mount (#138/#142)", () => checkOrchestratorMount(ctx))
  await runCheck(results, "4. claude-code plan mode (#143)", () => checkClaudeCodePlanMode(ctx))
  await runCheck(results, "5. hermes turn-idle watchdog manifest (#145)", () => checkHermesWatchdogManifest())

  await cleanup(ctx)
  printSummary(results)
  process.exit(results.some(r => r.status === "fail") ? 1 : 0)
}

main().catch(err => {
  console.error("FATAL:", err)
  process.exit(1)
})
