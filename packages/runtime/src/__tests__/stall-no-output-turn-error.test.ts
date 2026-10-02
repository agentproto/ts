/**
 * A turn that produces NOTHING (no text, no tool call, no usage) and then
 * goes silent past the stall threshold is a provider stuck retrying — most
 * visibly opencode swallowing a 429 into an internal retry loop forever. It
 * used to surface as `stalledSinceMs` with no reason, indistinguishable from
 * a slow-but-healthy turn. `markStalled` now also attaches a readable turn
 * error for that case, while a turn that streamed output FIRST keeps the
 * pre-existing stalled-only behavior.
 */

import { describe, it, expect } from "vitest"
import {
  createSessionsRegistry,
  NO_OUTPUT_STALL_TURN_ERROR,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"

/** Wait until `predicate()` is true, or fail after a bounded number of
 *  macrotask turns — keeps the test off an arbitrary fixed sleep. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** A turn that hangs after producing `output` events (none by default). The
 *  gate lets the test release the turn AFTER asserting on the stall;
 *  `onOutputConsumed` fires once the consumer has pulled the event AFTER the
 *  output (i.e. the runtime has already processed it). */
function gatedTurn(output: AgentStreamEvent[], onOutputConsumed?: () => void) {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const session: AgentSessionLike = {
    sessionId: "gated",
    async *send() {
      for (const evt of output) yield evt
      if (output.length > 0) onOutputConsumed?.()
      await gate
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  return { session, release }
}

describe("stall watchdog: no-output turn error", () => {
  it("attaches a readable turn error when a turn stalls with zero output", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const { session, release } = gatedTurn([])
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "fake",
    })

    const turn = registry.sendPrompt(desc.id, "go")
    await until(() => registry.get(desc.id)?.busy === true, "turn to start")

    expect(registry.markStalled(desc.id, Date.now())).toBe(true)
    const after = registry.get(desc.id)
    expect(after?.stalledSinceMs).toBeDefined()
    expect(after?.lastTurnErroredAt).toBeDefined()
    expect(after?.lastTurnErrorMessage).toBe(NO_OUTPUT_STALL_TURN_ERROR)

    // Let the (successful) turn finish so nothing is left hanging; a clean
    // turn-end clears the marker, same as any other turn error.
    release()
    await turn
    expect(registry.get(desc.id)?.lastTurnErroredAt).toBeUndefined()
    registry.shutdown()
  })

  it("does NOT attach a turn error when the turn streamed output before stalling", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    let outputConsumed!: () => void
    const outputSeen = new Promise<void>(resolve => {
      outputConsumed = resolve
    })
    const { session, release } = gatedTurn(
      [{ kind: "text-delta", text: "working on it…" }],
      outputConsumed,
    )
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "fake",
    })

    const turn = registry.sendPrompt(desc.id, "go")
    // `outputSeen` resolves only after the runtime has consumed the
    // text-delta — so `turnHadOutput` is provably set before we stall.
    await outputSeen

    expect(registry.markStalled(desc.id, Date.now())).toBe(true)
    const after = registry.get(desc.id)
    expect(after?.stalledSinceMs).toBeDefined()
    expect(after?.lastTurnErroredAt).toBeUndefined()
    expect(after?.lastTurnErrorMessage).toBeUndefined()

    release()
    await turn
    registry.shutdown()
  })
})
