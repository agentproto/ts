/**
 * ACP smoke probe — the post-upgrade gate behind `agentproto harness check`
 * and `agentproto harness upgrade`.
 *
 * Drives a REAL child process over the real stdio JSON-RPC wire, against
 * two throwaway node scripts: one that answers the two-call handshake and
 * one that never answers (the timeout path). No network, no harness CLI.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acpSmokeProbe, SMOKE_PROBE_TIMEOUT_MS } from "../harness-probe.js"

let dir: string
let answeringScript: string
let silentScript: string
let badVersionScript: string

/** Minimal ACP agent over stdio ndjson: answers initialize (id 1) with a
 *  protocolVersion + loadSession capability, and session/new (id 2) with a
 *  sessionId. Everything else is ignored. */
const ANSWERING_SOURCE = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === 1) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "fake-acp", title: "Fake ACP", version: "1.0.0" },
      },
    }) + "\\n")
  } else if (msg.id === 2) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: 2,
      result: { sessionId: "sess-1" },
    }) + "\\n")
  }
})
`

/** An agent that never answers — the probe must time out, not hang. */
const SILENT_SOURCE = `
setInterval(() => {}, 1000)
`

/** Answers initialize with a protocolVersion agentproto cannot speak. */
const BAD_VERSION_SOURCE = ANSWERING_SOURCE.replace("protocolVersion: 1", "protocolVersion: 99")

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentproto-probe-test-"))
  answeringScript = join(dir, "acp-ok.cjs")
  silentScript = join(dir, "acp-silent.cjs")
  badVersionScript = join(dir, "acp-bad-version.cjs")
  await writeFile(answeringScript, ANSWERING_SOURCE, "utf8")
  await writeFile(silentScript, SILENT_SOURCE, "utf8")
  await writeFile(badVersionScript, BAD_VERSION_SOURCE, "utf8")
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe("acpSmokeProbe", () => {
  it("passes against a fake ACP agent that answers initialize + session/new", async () => {
    const result = await acpSmokeProbe({
      bin: process.execPath,
      bin_args: [answeringScript],
    })
    expect(result.ok).toBe(true)
    expect(result.protocolVersion).toBe(1)
    expect(result.loadSession).toBe(true)
  })

  it("times out (never hangs) against an agent that never answers", async () => {
    const result = await acpSmokeProbe(
      { bin: process.execPath, bin_args: [silentScript] },
      { timeoutMs: 750 },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain("timed out after 750ms")
    expect(result.error).toContain("initialize")
  }, 15_000)

  it("rejects a protocolVersion outside what agentproto speaks", async () => {
    const result = await acpSmokeProbe({
      bin: process.execPath,
      bin_args: [badVersionScript],
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("protocolVersion 99")
  })

  it("fails cleanly when the binary cannot be spawned", async () => {
    const result = await acpSmokeProbe({
      bin: join(dir, "no-such-binary"),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it("exports the documented default timeout", () => {
    expect(SMOKE_PROBE_TIMEOUT_MS).toBe(30_000)
  })
})
