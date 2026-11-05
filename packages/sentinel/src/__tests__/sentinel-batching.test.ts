/**
 * Per-target batching: a burst of sentinel envelopes for one session is
 * delivered as ONE message after `target.batchMs`. The default (absent or 0)
 * keeps the pre-batching behaviour, one message per envelope.
 */

import { registerGithubDeliveryModule } from "@agentproto/delivery-github"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSentinelStore, type SentinelStore } from "../sentinel-store.js"
import {
  createSentinelRuntime,
  type SentinelRuntimeOptions,
  type SentinelRuntimeRegistry,
} from "../sentinel-runtime.js"
import { createFakeSentinelProvider, makeFakeEvent } from "../sentinel-providers/fake.js"
import { singleMatch } from "../sentinel-providers/types.js"
import type { SendMessageResult, SessionMessage } from "../local-types.js"
import { registerSentinelClassifier, registerSentinelRepeatKey } from "../sentinel-triage.js"
import { registerSentinelCoalesceRule } from "../sentinel-coalesce.js"

registerGithubDeliveryModule({
  registerClassifier: registerSentinelClassifier,
  registerCoalesceRule: registerSentinelCoalesceRule,
  registerRepeatKey: registerSentinelRepeatKey,
})

const okResult = (): SendMessageResult => ({
  messageId: "msg_test",
  delivered: { via: "turn" },
  queued: false,
  urgencyApplied: "next-turn",
})

interface RecordedCall {
  msg: SessionMessage
  opts?: { source?: string; origin?: string; coalesceKey?: string }
}

function stubRegistry(failFirstSends = 0): SentinelRuntimeRegistry & { calls: RecordedCall[]; attempts: () => number } {
  const calls: RecordedCall[] = []
  let attempts = 0
  return {
    calls,
    attempts: () => attempts,
    async sendMessage(msg, opts) {
      attempts++
      if (attempts <= failFirstSends) throw new Error("transient send failure")
      calls.push({ msg, opts })
      return okResult()
    },
  }
}

interface Harness {
  store: SentinelStore
  calls: RecordedCall[]
  acks: string[]
  attempts: () => number
  runtime: ReturnType<typeof createSentinelRuntime>
  ledgerPath: string
  cleanup: () => void
}

function setup(batchMs: number | undefined, failFirstSends = 0): Harness {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-batching-"))
  const ledgerPath = join(dir, "delivery-ledger.jsonl")
  const parkedPath = join(dir, "parked.jsonl")
  const store = createSentinelStore({ persist: false })
  const acks: string[] = []
  const provider = createFakeSentinelProvider({ onAck: (_handle, cursor) => acks.push(cursor) })
  const prs = ["acme/widgets#1", "acme/widgets#2", "acme/widgets#3"]

  for (const pr of prs) {
    const subject = `github:${pr}`
    store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: subject, cursor: "0" },
      spec: {
        match: singleMatch(subject, ["github.*"]),
        until: { kind: "never" },
        target: {
          kind: "session",
          sessionId: "sess_1",
          urgency: "next-turn",
          ...(batchMs !== undefined ? { batchMs } : {}),
        },
      },
    })
    provider.emit(
      makeFakeEvent({
        id: `evt_${pr.replace(/\W/g, "_")}`,
        type: "github.check_suite.completed",
        subject,
        summary: `check suite completed on ${pr}`,
      }),
    )
  }

  const registry = stubRegistry(failFirstSends)
  const opts: SentinelRuntimeOptions = {
    store,
    registry,
    resolveProvider: async slug => (slug === "fake" ? provider : null),
    isSessionAlive: () => true,
    restartSession: async id => id,
    ledgerPath,
    parkedPath,
    outboxPersist: false,
    log: () => undefined,
  }
  const runtime = createSentinelRuntime(opts)

  return {
    store,
    calls: registry.calls,
    acks,
    attempts: registry.attempts,
    runtime,
    ledgerPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("sentinel per-target batching", () => {
  it("delivers three envelopes on three different PRs for one target as ONE message", async () => {
    vi.useFakeTimers()
    const h = setup(500)
    try {
      await h.runtime.pollOnce()
      expect(h.calls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(500)

      expect(h.calls).toHaveLength(1)
      const sent = h.calls[0]!
      expect(sent.msg.to).toBe("sess_1")
      expect(sent.msg.text).toContain("check suite completed on acme/widgets#1")
      expect(sent.msg.text).toContain("check suite completed on acme/widgets#2")
      expect(sent.msg.text).toContain("check suite completed on acme/widgets#3")

      const lines = readFileSync(h.ledgerPath, "utf8").trim().split("\n")
      expect(lines).toHaveLength(3)
      expect(lines.map(line => JSON.parse(line))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventId: "evt_acme_widgets_1", subject: "github:acme/widgets#1", outcome: "delivered" }),
          expect.objectContaining({ eventId: "evt_acme_widgets_2", subject: "github:acme/widgets#2", outcome: "delivered" }),
          expect.objectContaining({ eventId: "evt_acme_widgets_3", subject: "github:acme/widgets#3", outcome: "delivered" }),
        ]),
      )
    } finally {
      h.cleanup()
    }
  })

  it("batchMs 0 (the default) keeps one message per envelope", async () => {
    vi.useFakeTimers()
    const h = setup(undefined)
    try {
      await h.runtime.pollOnce()
      expect(h.calls).toHaveLength(3)

      const lines = readFileSync(h.ledgerPath, "utf8").trim().split("\n")
      expect(lines).toHaveLength(3)
    } finally {
      h.cleanup()
    }
  })

  it("an explicit batchMs 0 behaves like the default", async () => {
    const h = setup(0)
    try {
      await h.runtime.pollOnce()
      expect(h.calls).toHaveLength(3)
    } finally {
      h.cleanup()
    }
  })

  it("acks the poll cursor only after the batched flush landed", async () => {
    vi.useFakeTimers()
    const h = setup(500)
    try {
      await h.runtime.pollOnce()
      expect(h.acks).toEqual([])

      await vi.advanceTimersByTimeAsync(500)
      expect(h.calls).toHaveLength(1)

      await h.runtime.pollOnce()
      expect(h.acks.length).toBeGreaterThan(0)
      expect(h.calls).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  it("a failed flush is not acked and is redelivered on the next poll, sent exactly once", async () => {
    vi.useFakeTimers()
    const h = setup(500, 1)
    try {
      await h.runtime.pollOnce()
      expect(h.acks).toEqual([])

      await vi.advanceTimersByTimeAsync(500)
      expect(h.attempts()).toBe(1)
      expect(h.calls).toHaveLength(0)
      // A further poll while nothing landed must still not ack the lost events.
      await h.runtime.pollOnce()
      expect(h.acks).toEqual([])

      await vi.advanceTimersByTimeAsync(500)
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0]!.msg.text).toContain("check suite completed on acme/widgets#1")
      expect(h.calls[0]!.msg.text).toContain("check suite completed on acme/widgets#3")

      await h.runtime.pollOnce()
      expect(h.acks.length).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(500)
      expect(h.calls).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })
})
