/**
 * A sentinel target with `batchMs` sends ONE message through the real
 * sessions registry for a burst of envelopes on one session. The default
 * (no `batchMs`) still sends one message per envelope.
 */

import "../sentinel-platform.js"

import { registerGithubDeliveryModule } from "@agentproto/delivery-github"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSentinelRuntime,
  createSentinelStore,
  createFakeSentinelProvider,
  makeFakeEvent,
  registerSentinelClassifier,
  registerSentinelCoalesceRule,
  registerSentinelRepeatKey,
  singleMatch,
} from "@agentproto/sentinel"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry } from "../sessions.js"

registerGithubDeliveryModule({
  registerClassifier: registerSentinelClassifier,
  registerCoalesceRule: registerSentinelCoalesceRule,
  registerRepeatKey: registerSentinelRepeatKey,
})

interface Harness {
  registry: ReturnType<typeof createSessionsRegistry>
  runtime: ReturnType<typeof createSentinelRuntime>
  ledgerPath: string
  cleanup: () => void
}

function setup(batchMs: number | undefined): Harness {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-batching-runtime-"))
  const registry = createSessionsRegistry({
    persist: false,
    transcriptDir: dir,
    sessionEvents: createSessionEventBus(),
  })
  registry.touchExternal({ id: "desktop-1", host: "claude-desktop" })

  const store = createSentinelStore({ persist: false })
  const provider = createFakeSentinelProvider()
  for (const n of [1, 2, 3]) {
    const subject = `github:acme/widgets#${n}`
    store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: subject, cursor: "0" },
      spec: {
        match: singleMatch(subject, ["github.*"]),
        until: { kind: "never" },
        target: {
          kind: "session",
          sessionId: "desktop-1",
          urgency: "next-turn",
          ...(batchMs !== undefined ? { batchMs } : {}),
        },
      },
    })
    provider.emit(
      makeFakeEvent({
        id: `evt_${n}`,
        type: "github.check_suite.completed",
        subject,
        summary: `check suite completed on PR ${n}`,
      }),
    )
  }

  const ledgerPath = join(dir, "delivery-ledger.jsonl")
  const runtime = createSentinelRuntime({
    store,
    registry,
    resolveProvider: async slug => (slug === "fake" ? provider : null),
    isSessionAlive: id => {
      const d = registry.get(id)
      return !!d && (d.status === "running" || d.status === "starting")
    },
    restartSession: async () => {
      throw new Error("external session cannot be restarted")
    },
    parkedPath: join(dir, "parked.jsonl"),
    ledgerPath,
    outboxPersist: false,
    log: () => undefined,
  })

  return {
    registry,
    runtime,
    ledgerPath,
    cleanup: () => {
      runtime.stop()
      registry.shutdown()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("sentinel batching through the sessions registry", () => {
  it("lands a burst for one target as ONE inbox message", async () => {
    vi.useFakeTimers()
    const h = setup(500)
    try {
      await h.runtime.pollOnce()
      expect(h.registry.listInbox("desktop-1")).toEqual([])

      await vi.advanceTimersByTimeAsync(500)

      const inbox = h.registry.listInbox("desktop-1")!
      expect(inbox).toHaveLength(1)
      expect(inbox[0]!.text).toContain("check suite completed on PR 1")
      expect(inbox[0]!.text).toContain("check suite completed on PR 2")
      expect(inbox[0]!.text).toContain("check suite completed on PR 3")
      expect(inbox[0]!.delivered?.via).toBe("inbox")

      const lines = readFileSync(h.ledgerPath, "utf8").trim().split("\n")
      expect(lines).toHaveLength(3)
    } finally {
      h.cleanup()
    }
  })

  it("sends one message per envelope when batchMs is absent", async () => {
    vi.useFakeTimers()
    const h = setup(undefined)
    try {
      await h.runtime.pollOnce()
      expect(h.registry.listInbox("desktop-1")).toHaveLength(3)
    } finally {
      h.cleanup()
    }
  })
})
