/**
 * The legacy workspace-brain subscriber's opt-in ownership skip. A true from
 * `skipWorkspace` must leave `ingestSession` untouched; an absent option must
 * keep the previous behaviour exactly.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

import { createSessionEventBus } from "../session-event-bus.js"
import { createWorkspaceBrainSubscriber } from "../workspace-brain-subscriber.js"

function fakes() {
  const ingestSession = vi.fn(async () => ({ sessionId: "sess-1", ok: true, sourceId: "sess-1" }))
  const brains = {
    resolveWorkspace: vi.fn(async () => "ws-a"),
    getBrain: vi.fn(() => ({ ingestSession })),
  } as unknown as Parameters<typeof createWorkspaceBrainSubscriber>[0]["brains"]
  return { brains, ingestSession }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const exit = () =>
  ({ type: "session:exited", sessionId: "sess-1", exitCode: 0, status: "exited", ts: "x" }) as never

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("workspace-brain subscriber skipWorkspace", () => {
  it("does not call ingestSession when the workspace is owned elsewhere", async () => {
    vi.useFakeTimers()
    const { brains, ingestSession } = fakes()
    const bus = createSessionEventBus()
    const subscriber = createWorkspaceBrainSubscriber({
      bus,
      brains,
      debounceMs: 1_000,
      skipWorkspace: () => true,
    })
    subscriber.start()
    bus.emit(exit())
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(ingestSession).not.toHaveBeenCalled()
    subscriber.stop()
  })

  it("calls ingestSession when skipWorkspace is false", async () => {
    vi.useFakeTimers()
    const { brains, ingestSession } = fakes()
    const bus = createSessionEventBus()
    const subscriber = createWorkspaceBrainSubscriber({
      bus,
      brains,
      debounceMs: 1_000,
      skipWorkspace: () => false,
    })
    subscriber.start()
    bus.emit(exit())
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(ingestSession).toHaveBeenCalledWith("sess-1")
    subscriber.stop()
  })

  it("ingests as before when the option is absent", async () => {
    vi.useFakeTimers()
    const { brains, ingestSession } = fakes()
    const bus = createSessionEventBus()
    const subscriber = createWorkspaceBrainSubscriber({ bus, brains, debounceMs: 1_000 })
    subscriber.start()
    bus.emit(exit())
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(ingestSession).toHaveBeenCalledWith("sess-1")
    subscriber.stop()
  })
})
