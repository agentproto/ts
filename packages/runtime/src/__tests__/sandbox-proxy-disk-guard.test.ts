/**
 * Sandbox proxy — disk guard (FAKE TIMERS).
 *
 * On each periodic checkpoint tick the proxy reads the box's free disk; under
 * `DISK_GUARD_MIN_FREE_FRACTION` (10%) it forces a checkpoint — bypassing the
 * unchanged-since-last skip — and emits a warning. A full disk kills a box
 * with NO checkpoint (writes fail, the crash skips the teardown hook), so the
 * rescue has to happen while there is still room to pack and push.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  createSandboxAgentSessionProxy,
  type SandboxAgentSessionProxyOpts,
} from "../sandbox-agent-session-proxy.js"
import { DISK_GUARD_MIN_FREE_FRACTION } from "../sandbox-delivery.js"

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
    mcpUrl: "http://127.0.0.1:18790/mcp",
    ...overrides,
  }
}

/** `df -Pk /` output for a disk of `totalK` blocks with `freeK` available. */
const dfOutput = (totalK: number, freeK: number): string =>
  `Filesystem 1024-blocks Used Available Capacity Mounted on\n` +
  `/dev/sda1 ${totalK} ${totalK - freeK} ${freeK} ${Math.round(((totalK - freeK) / totalK) * 100)}% /\n`

const dfExec = (totalK: number, freeK: number): FakeHost["exec"] =>
  vi.fn(async () => ({ exitCode: 0, stdout: dfOutput(totalK, freeK), stderr: "" }))

function makeProxy(
  host: FakeHost,
  overrides: Partial<SandboxAgentSessionProxyOpts> = {},
): { proxy: ReturnType<typeof createSandboxAgentSessionProxy>; checkpoint: ReturnType<typeof vi.fn> } {
  const checkpoint = vi.fn(async (_turn?: number, _opts?: { force?: boolean }) => ({}))
  const proxy = createSandboxAgentSessionProxy({
    host,
    remoteSessionId: "remote_1",
    checkpoint: { run: checkpoint as never, intervalMs: 10 * 60_000 },
    ...overrides,
  })
  return { proxy, checkpoint }
}

describe("sandbox proxy — disk guard (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("under 10% free disk, the periodic tick forces a checkpoint and emits a warning", async () => {
    vi.useFakeTimers()
    const exec = dfExec(1_000_000, 999) // 0.1% free
    const onWarning = vi.fn()
    const { proxy, checkpoint } = makeProxy(makeHost({ exec }), { onWarning })

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.advanceTimersByTimeAsync(0) // let the fire-and-forget guard settle
    expect(exec).toHaveBeenCalled()
    expect(onWarning).toHaveBeenCalledTimes(1)
    expect(onWarning.mock.calls[0]![0]).toContain("free disk")
    expect(checkpoint).toHaveBeenCalledWith(0, { force: true })

    await proxy.close().catch(() => undefined)
  })

  it("a healthy disk warns nothing and checkpoints without force", async () => {
    vi.useFakeTimers()
    const exec = dfExec(1_000_000, 500_000) // 50% free
    const onWarning = vi.fn()
    const { proxy, checkpoint } = makeProxy(makeHost({ exec }), { onWarning })

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(exec).toHaveBeenCalled()
    expect(onWarning).not.toHaveBeenCalled()
    expect(checkpoint).toHaveBeenCalledWith(0, undefined)

    await proxy.close().catch(() => undefined)
  })

  it("a failed or unparseable probe is silent — the guard never guesses", async () => {
    vi.useFakeTimers()
    const exec = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "df failed" }))
    const onWarning = vi.fn()
    const { proxy, checkpoint } = makeProxy(makeHost({ exec }), { onWarning })

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(onWarning).not.toHaveBeenCalled()
    // The plain periodic checkpoint still ran — only the guard stayed quiet.
    expect(checkpoint).toHaveBeenCalled()

    await proxy.close().catch(() => undefined)
  })

  it("no warning, probe or checkpoint from a proxy whose periodic timer is off", async () => {
    vi.useFakeTimers()
    const exec = dfExec(1_000_000, 999)
    const onWarning = vi.fn()
    const { proxy, checkpoint } = makeProxy(makeHost({ exec }), {
      onWarning,
      checkpoint: { run: vi.fn(async () => ({})), intervalMs: 10 * 60_000, periodic: false },
    })

    await vi.advanceTimersByTimeAsync(3 * 10 * 60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(exec).not.toHaveBeenCalled()
    expect(onWarning).not.toHaveBeenCalled()
    expect(checkpoint).not.toHaveBeenCalled()

    await proxy.close().catch(() => undefined)
  })

  it(`threshold is ${DISK_GUARD_MIN_FREE_FRACTION * 100}% free exactly at the boundary`, () => {
    expect(DISK_GUARD_MIN_FREE_FRACTION).toBe(0.1)
  })
})
