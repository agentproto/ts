/**
 * LIVE e2e: prove pi actually invokes a BRIDGED MCP tool.
 *
 * Stands up the local `echo` stdio MCP server, spawns pi through the BUILT
 * adapter (`../dist/index.mjs` — the extension path resolves next to it), injects
 * the echo server as `mcpServers`, and sends a prompt forcing the echo tool.
 * Asserts the event stream shows a `tool-call` for `mcp__echo__echo`, a
 * `tool-result` carrying `bridged-ok`, and a completed `turn-end`.
 *
 * Requires `ANTHROPIC_API_KEY` in the env and a global `pi` (v0.80.x).
 * Run: `node adapters/pi/e2e/run-e2e.mjs`
 */
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { piRuntime } from "../dist/index.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const echoServerPath = resolve(here, "echo-mcp-server.mjs")

const MODEL = process.env.PI_E2E_MODEL ?? "anthropic/claude-sonnet-4-5"
const PROMPT =
  "Call the echo tool with the text 'bridged-ok' and then report exactly what it returned. " +
  "You must use the tool; do not answer from memory."

function line(evt) {
  return JSON.stringify(evt)
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set — cannot run the live e2e.")
  }

  const server = { name: "echo", transport: "stdio", ref: echoServerPath }

  const session = await piRuntime().start({
    mcpServers: [server],
    config: { options: { model: MODEL } },
    turnIdleTimeoutMs: 120_000,
  })
  console.log(`[e2e] pi session ${session.sessionId} (pid ${session.pid ?? "?"}) started`)

  let sawToolCall = false
  let sawToolResult = false
  let sawTurnEnd = false
  let turnEndReason = ""
  const printed = []

  try {
    for await (const evt of session.send({ role: "user", content: PROMPT })) {
      if (evt.kind === "tool-call") {
        printed.push(line(evt))
        if (evt.toolName === "mcp__echo__echo") sawToolCall = true
      } else if (evt.kind === "tool-result") {
        printed.push(line(evt))
        if (line(evt).includes("bridged-ok")) sawToolResult = true
      } else if (evt.kind === "turn-end") {
        printed.push(line(evt))
        sawTurnEnd = true
        turnEndReason = evt.reason
      } else if (evt.kind === "error") {
        printed.push(line(evt))
      }
    }
  } finally {
    await session.close()
  }

  console.log("\n[e2e] relevant stream events:")
  for (const l of printed) console.log("  " + l)

  const ok = sawToolCall && sawToolResult && sawTurnEnd
  console.log("\n[e2e] assertions:")
  console.log(`  tool-call mcp__echo__echo : ${sawToolCall}`)
  console.log(`  tool-result has bridged-ok: ${sawToolResult}`)
  console.log(`  turn-end (${turnEndReason})       : ${sawTurnEnd}`)
  if (!ok) {
    console.error("\n[e2e] FAILED — bridged tool was not observably invoked.")
    process.exit(1)
  }
  console.log("\n[e2e] PASSED — pi invoked the bridged MCP tool end-to-end.")
}

main().catch(err => {
  console.error("[e2e] ERROR:", err instanceof Error ? err.stack : err)
  process.exit(1)
})
