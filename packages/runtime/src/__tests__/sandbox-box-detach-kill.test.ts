/**
 * Computer-box teardown on kill and crash.
 *
 * Two leaks observed 2026-10-19/20:
 *  1. a shared computer: killing one of several attached sessions only
 *     removed it from the ledger, never releasing its provider/controller
 *     session slot, so the box stayed "attached" (sessions: N) and DELETE
 *     409'd until forced;
 *  2. a session whose adapter died in its box ended `error` without tearing
 *     the box down, and a later `agent_kill` was refused as a label-only
 *     no-op on an ended row, so the box leaked too.
 *
 * Hermetic: the real sandbox proxy over a fake box-daemon host, with a
 * fake provider-side "detach"/"stop" seam counting teardown calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSandboxAgentSessionProxy } from "../sandbox-agent-session-proxy.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { recordSandboxBoot } from "../sandbox-ledger.js"

type FakeHost = Parameters<typeof createSandboxAgentSessionProxy>[0]["host"]

function makeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  return {
    prompt: vi.fn(async () => {}),
    interrupt: vi.fn(async () => ({ wasBusy: false })),
    output: vi.fn(async () => ""),
    kill: vi.fn(async () => {}),
    waitForAny: vi.fn(async () => ({ timedOut: false, event: "turn-end" as const, sessionIds: [] })),
    currentEventsCursor: vi.fn(async () => 0),
    stop: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    mcpUrl: "http://127.0.0.1:18790/mcp",
    ...overrides,
  }
}

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 25))
}

describe("sandbox box teardown on kill", () => {
  let tmp: string
  const prevLedger = process.env.AGENTPROTO_SANDBOX_LEDGER

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sandbox-detach-kill-"))
    process.env.AGENTPROTO_SANDBOX_LEDGER = join(tmp, "sandboxes.json")
  })
  afterEach(() => {
    if (prevLedger === undefined) delete process.env.AGENTPROTO_SANDBOX_LEDGER
    else process.env.AGENTPROTO_SANDBOX_LEDGER = prevLedger
    rmSync(tmp, { recursive: true, force: true })
  })

  const registry = () =>
    createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      sessionEvents: createSessionEventBus(),
    })

  it("killing one of two sessions on a shared box detaches its provider slot without stopping the box", async () => {
    recordSandboxBoot({ sandboxId: "cmp-x", provider: "computer", state: "booted", sessionId: "sess_a" })
    const hostA = makeHost()
    const hostB = makeHost()
    const reg = registry()
    const a = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/home/user",
      agentSession: createSandboxAgentSessionProxy({
        host: hostA,
        remoteSessionId: "remote_a",
        lifecyclePolicy: { teardown: "kill" },
        ledger: { sandboxId: "cmp-x", provider: "computer", sessionId: "sess_a" },
      }),
      adapterSlug: "claude-code",
      remote: true,
      sandboxId: "cmp-x",
      sandboxProvider: "computer",
      sandboxTeardown: "kill",
    })
    const b = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/home/user",
      agentSession: createSandboxAgentSessionProxy({
        host: hostB,
        remoteSessionId: "remote_b",
        lifecyclePolicy: { teardown: "pause" },
        ledger: { sandboxId: "cmp-x", provider: "computer", sessionId: "sess_b" },
      }),
      adapterSlug: "claude-code",
      remote: true,
      sandboxId: "cmp-x",
      sandboxProvider: "computer",
      sandboxTeardown: "pause",
    })
    recordSandboxBoot({ sandboxId: "cmp-x", provider: "computer", state: "connected", sessionId: b.id })

    expect(reg.kill(a.id, undefined, "operator-stopped")).toBe(true)
    await flush()

    expect(hostA.detach).toHaveBeenCalledTimes(1)
    expect(hostA.stop).not.toHaveBeenCalled()
    expect(hostA.pause).not.toHaveBeenCalled()
    // The survivor was not touched.
    expect(hostB.detach).not.toHaveBeenCalled()
    expect(hostB.stop).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("killing an errored (crashed-adapter) session still tears its box down", async () => {
    const host = makeHost({
      prompt: vi.fn(async () => {
        throw new Error("adapter connection closed")
      }),
    })
    const reg = registry()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/home/user",
      agentSession: createSandboxAgentSessionProxy({ host, remoteSessionId: "remote_c" }),
      adapterSlug: "claude-code",
      remote: true,
      sandboxId: "cmp-crashed",
      sandboxProvider: "computer",
      sandboxTeardown: "kill",
    })

    await reg.sendPrompt(desc.id, "do work")
    expect(reg.get(desc.id)?.status).toBe("error")
    expect(host.stop).not.toHaveBeenCalled()

    // The operator's kill on the already-errored row must retry the box
    // teardown instead of only refusing as a label-only no-op.
    expect(reg.kill(desc.id)).toBe(true)
    await flush()

    expect(host.stop).toHaveBeenCalledTimes(1)
    reg.shutdown()
  })
})
