import { describe, expect, it } from "vitest"
import { composeSessionObservers, type SessionObserver } from "../session-observer.js"
import type { AgentStreamEvent } from "../sessions.js"
import type { SessionUsage } from "../usage.js"

/** A recording fake observer that logs every call in order. */
function makeRecorder(log: string[], label: string): SessionObserver {
  return {
    recordPrompt(id, message) {
      log.push(`${label}:prompt:${id}:${String(message)}`)
    },
    recordEvent(id, evt) {
      log.push(`${label}:event:${id}:${evt.kind}`)
    },
    recordUsageSnapshot(id) {
      log.push(`${label}:usage:${id}`)
    },
    async close(id) {
      log.push(`${label}:close:${id}`)
    },
    async closeAll() {
      log.push(`${label}:closeAll`)
    },
  }
}

const usage: SessionUsage = { source: "none" }
const evt: AgentStreamEvent = { kind: "turn-end", reason: "completed" }

describe("composeSessionObservers", () => {
  it("forwards every record* call to all members in order", () => {
    const log: string[] = []
    const composite = composeSessionObservers([
      makeRecorder(log, "a"),
      makeRecorder(log, "b"),
    ])

    composite.recordPrompt("s1", "hello")
    composite.recordEvent("s1", evt)
    composite.recordUsageSnapshot("s1", usage)

    expect(log).toEqual([
      "a:prompt:s1:hello",
      "b:prompt:s1:hello",
      "a:event:s1:turn-end",
      "b:event:s1:turn-end",
      "a:usage:s1",
      "b:usage:s1",
    ])
  })

  it("awaits close and closeAll across all members", async () => {
    const log: string[] = []
    const composite = composeSessionObservers([
      makeRecorder(log, "a"),
      makeRecorder(log, "b"),
    ])

    await composite.close("s1")
    await composite.closeAll()

    expect(log).toContain("a:close:s1")
    expect(log).toContain("b:close:s1")
    expect(log).toContain("a:closeAll")
    expect(log).toContain("b:closeAll")
  })

  it("isolates a throwing member: siblings still run and nothing propagates", async () => {
    const log: string[] = []
    const boom: SessionObserver = {
      recordPrompt() {
        throw new Error("sync boom")
      },
      recordEvent() {
        throw new Error("sync boom")
      },
      recordUsageSnapshot() {
        throw new Error("sync boom")
      },
      async close() {
        throw new Error("async boom")
      },
      async closeAll() {
        throw new Error("async boom")
      },
    }
    const composite = composeSessionObservers([boom, makeRecorder(log, "ok")])

    // None of these must throw.
    expect(() => composite.recordPrompt("s1", "x")).not.toThrow()
    expect(() => composite.recordEvent("s1", evt)).not.toThrow()
    expect(() => composite.recordUsageSnapshot("s1", usage)).not.toThrow()
    await expect(composite.close("s1")).resolves.toBeUndefined()
    await expect(composite.closeAll()).resolves.toBeUndefined()

    // The healthy sibling still received every call.
    expect(log).toEqual([
      "ok:prompt:s1:x",
      "ok:event:s1:turn-end",
      "ok:usage:s1",
      "ok:close:s1",
      "ok:closeAll",
    ])
  })

  it("is a no-op with zero members", async () => {
    const composite = composeSessionObservers([])
    expect(() => composite.recordEvent("s1", evt)).not.toThrow()
    await expect(composite.closeAll()).resolves.toBeUndefined()
  })
})
