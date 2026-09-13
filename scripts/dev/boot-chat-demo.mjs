#!/usr/bin/env node
/**
 * boot-chat-demo.mjs — throwaway local demo for the `/sessions/:id/chat`
 * (AI-SDK v6 UI message stream) HTTP route.
 *
 * Boots a REAL in-process runtime (`createGateway`, the same factory an
 * `agentproto serve` child runs) on an EXPLICIT ALTERNATIVE port (never the
 * production daemon's 18790), with an ISOLATED workspace under os.tmpdir()
 * (never ~/.agentproto). It then spawns a live session via the runtime's
 * internal spawn mechanism (`gateway.sessions.spawnAgent`) and prints:
 *
 *   - the base URL
 *   - the spawned session id
 *   - the exact curl that streams `POST /sessions/:id/chat`
 *
 * Run it in the foreground, poke it with curl, then Ctrl+C to shut it down
 * cleanly (SIGINT/SIGTERM stop the gateway and remove the temp workspace).
 *
 * Usage:
 *   node scripts/dev/boot-chat-demo.mjs [--port 18799]
 *
 * NOTE on real adapters: the demo session is a SCRIPTED, zero-cost
 * AgentSessionLike (deterministic text-delta → tool-call → tool-result →
 * turn-end) so it needs no LLM, no creds, and streams a fixed chunk sequence
 * on the first curl. To point it at a REAL cheap harness (hermes/opencode with
 * a flash model) instead, boot the runtime with a `resolveAgentAdapter` wired
 * (as `agentproto serve` does) and spawn via HTTP:
 *
 *   curl -s -X POST http://127.0.0.1:<port>/sessions/agent \
 *     -H 'content-type: application/json' \
 *     -d '{"adapter":"opencode","model":"<flash model>","cwd":"<cwd>"}'
 *
 * then hit the returned session id's /chat route below.
 */

import { createGateway } from "../../packages/runtime/dist/index.mjs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PORT_DEFAULT = 18799

function parsePort(argv) {
  const i = argv.indexOf("--port")
  if (i === -1) return PORT_DEFAULT
  const raw = argv[i + 1]
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`invalid --port value: ${raw}`)
    process.exit(2)
  }
  if (n === 18790) {
    console.error("refusing --port 18790: that is the PRODUCTION daemon port, never touch it")
    process.exit(2)
  }
  return n
}

/** A scripted, zero-cost agent session — deterministic, no LLM, no creds. */
function scriptedAgentSession() {
  return {
    sessionId: "scripted-chat-demo",
    async *send(_message) {
      yield { kind: "text-delta", text: "Hello from the local demo runtime.\n" }
      yield {
        kind: "tool-call",
        toolCallId: "call_demo_01",
        toolName: "bash",
        arguments: { command: "git status --short" },
      }
      yield {
        kind: "tool-result",
        toolCallId: "call_demo_01",
        result: { stdout: " M README.md\n", stderr: "", exitCode: 0 },
        isError: false,
      }
      yield { kind: "turn-end", reason: "turn-complete" }
    },
    async cancel() {},
    async close() {},
  }
}

async function main() {
  const port = parsePort(process.argv.slice(2))
  const workspace = await mkdtemp(join(tmpdir(), "wp-s1-chat-demo-"))

  console.log(`[boot-chat-demo] isolated workspace: ${workspace}`)
  console.log(`[boot-chat-demo] booting createGateway on 127.0.0.1:${port} ...`)

  const gateway = await createGateway({
    workspace,
    specs: [],
    port,
    bind: "127.0.0.1",
    // Loopback-only demo — no bearer (matches the integration test's
    // `auth: { mode: "none" }`), so the printed curl just works.
    auth: { mode: "none" },
    boot: false,
    persist: false,
    persistPath: join(workspace, "sessions.json"),
    name: "chat-demo",
    version: "0",
    // A demo gateway must never sweep/restart anything.
    idleReapAfterMs: 0,
    crashDetectIntervalMs: 0,
    restartSweepIntervalMs: 0,
  })

  const baseUrl = `http://127.0.0.1:${port}`
  // The mutating /sessions/* routes are gated by the daemon's own session
  // token (checkSessionsToken) regardless of `auth.mode` — even on loopback.
  const token = gateway.token
  const desc = gateway.sessions.spawnAgent({
    workspaceSlug: "default",
    cwd: workspace,
    agentSession: scriptedAgentSession(),
    adapterSlug: "scripted",
    label: "chat-demo (scripted)",
    commandPreview: "scripted (zero-cost demo session)",
  })
  const sessionId = desc.id

  console.log()
  console.log("╔══════════════════════════════════════════════════════════════╗")
  console.log("║  chat demo runtime is LIVE                                   ║")
  console.log("╚══════════════════════════════════════════════════════════════╝")
  console.log()
  console.log(`  base URL     : ${baseUrl}`)
  console.log(`  workspace    : ${workspace}`)
  console.log(`  session id   : ${sessionId}`)
  console.log()
  console.log("  Stream the UI message stream for that session (a fixed chunk")
  console.log("  sequence — text-start → text-delta → text-end →")
  console.log("  tool-input-available → tool-output-available → finish):")
  console.log()
  console.log(`  curl -N -X POST ${baseUrl}/sessions/${sessionId}/chat \\`)
  console.log(`       -H 'content-type: application/json' \\`)
  console.log(`       -H 'Authorization: Bearer ${token}' \\`)
  console.log(`       -d '{"prompt":"check the repo"}'`)
  console.log()
  console.log("  Real-adapter note: to use a real cheap harness instead of the")
  console.log("  scripted session, boot with resolveAgentAdapter wired (as")
  console.log("  `agentproto serve` does) and spawn via:")
  console.log(`  curl -X POST ${baseUrl}/sessions/agent \\`)
  console.log(`       -H 'content-type: application/json' \\`)
  console.log(`       -H 'Authorization: Bearer ${token}' \\`)
  console.log(`       -d '{"adapter":"opencode","cwd":"<cwd>"}'`)
  console.log()
  console.log("  Press Ctrl+C to stop (closes the gateway + removes the workspace).")

  await new Promise(resolve => {
    const shutdown = async () => {
      process.off("SIGINT", shutdown)
      process.off("SIGTERM", shutdown)
      console.log()
      console.log("[boot-chat-demo] shutting down ...")
      try {
        await gateway.stop()
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
      console.log("[boot-chat-demo] stopped.")
      resolve()
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  })
}

main().catch(err => {
  console.error("[boot-chat-demo] fatal:", err)
  process.exit(1)
})
