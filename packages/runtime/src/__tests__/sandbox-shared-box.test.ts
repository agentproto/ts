/**
 * AIP-36 shared-box amendment — attach/detach refcount.
 *
 * The ledger row IS the refcount: two sessions attached to the same box
 * `reuse`-attach (state "connected"), teardown = DETACH, and only the LAST
 * session to close() stops the box. Stopping the FIRST of two must never
 * kill the box under the surviving one's feet (also robust to a daemon
 * restart: the count lives on disk).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSandboxAgentSessionProxy } from "../sandbox-agent-session-proxy.js"
import {
  recordSandboxBoot,
  recordSessionDetach,
  readSandboxLedger,
  sandboxLedgerPath,
} from "../sandbox-ledger.js"
import type { SandboxLedgerEntry } from "../sandbox-ledger.js"

type FakeHost = Parameters<typeof createSandboxAgentSessionProxy>[0]["host"]

function makeHost(): FakeHost {
  return {
    prompt: vi.fn(async () => {}),
    interrupt: vi.fn(async () => ({ wasBusy: false })),
    output: vi.fn(async () => ""),
    kill: vi.fn(async () => {}),
    waitForAny: vi.fn(async () => ({ timedOut: false, event: "turn-end" as const, sessionIds: [] })),
    currentEventsCursor: vi.fn(async () => 0),
    stop: vi.fn(async () => {}),
    mcpUrl: "http://127.0.0.1:18790/mcp",
  }
}

const ledgerFile = join(tmpdir(), `agentproto-shared-box-${process.pid}.json`)

const entryOf = (): SandboxLedgerEntry | undefined =>
  readSandboxLedger(ledgerFile).find(e => e.sandboxId === "bx_shared")

beforeEach(() => {
  vi.stubEnv("AGENTPROTO_SANDBOX_LEDGER", ledgerFile)
  recordSandboxBoot({
    sandboxId: "bx_shared",
    provider: "fake",
    state: "booted",
    sessionId: "sess_a",
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(ledgerFile, { force: true })
})

describe("shared sandbox — detach refcount", () => {
  it("stopping the 1st of 2 sessions detaches but does NOT kill the box", async () => {
    expect(sandboxLedgerPath()).toBe(ledgerFile)
    recordSessionDetach("bx_shared", "sess_a") // stale-op safety (no-op)
    recordSandboxBoot({ sandboxId: "bx_shared", provider: "fake", state: "booted", sessionId: "sess_b" })

    const proxyA = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_a",
      ledger: { sandboxId: "bx_shared", provider: "fake", sessionId: "sess_a" },
    })
    await proxyA.close()

    expect(entryOf()?.attachedSessions).toEqual(["sess_b"])
    const survivors = readSandboxLedger(ledgerFile).find(e => e.sandboxId === "bx_shared")
    expect(survivors?.state).not.toBe("stopped")
  })

  it("the LAST session detach stops the box and empties the list", async () => {
    recordSandboxBoot({ sandboxId: "bx_shared", provider: "fake", state: "booted", sessionId: "sess_b" })
    const remainingAfterA = recordSessionDetach("bx_shared", "sess_a")
    expect(remainingAfterA).toEqual(["sess_b"])

    const proxyB = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_b",
      ledger: { sandboxId: "bx_shared", provider: "fake", sessionId: "sess_b" },
    })
    await proxyB.close()

    expect(entryOf()?.attachedSessions).toEqual([])
    expect(entryOf()?.state).toBe("stopped")
  })

  it("a solo box still tears down on the only close (regression guard)", async () => {
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_a",
      ledger: { sandboxId: "bx_shared", provider: "fake", sessionId: "sess_a" },
    })
    await proxy.close()
    expect(host.stop).toHaveBeenCalledTimes(1)
  })
})
