/**
 * ReactionRunner.health() never throws, and a failing read is logged instead
 * of passing for an empty, healthy runner.
 */

import { describe, expect, it } from "vitest"

import { createSessionEventBus } from "../session-event-bus.js"
import {
  createReactionReceiptStore,
  createReactionRunner,
  type ReactionBinding,
  type ReactionReceiptStore,
} from "../action-hooks/index.js"

const EVENT = "agentproto:session-completed"

const binding: ReactionBinding = {
  bindingId: "bind-a",
  event: EVENT,
  actionId: "brain:ingest",
  configRevision: "cfg-1",
  maxAttempts: 3,
  reactionDepth: 0,
  occurrenceIdOf: () => "exit:1",
  target: { actionId: "brain:ingest", idempotent: true, run: async () => ({ ok: true }) },
}

describe("reaction runner health failure", () => {
  it("logs the failure and answers with zero counts when the store rows cannot be read", () => {
    const real = createReactionReceiptStore({ persist: false, log: () => {} })
    const failing: ReactionReceiptStore = {
      ...real,
      rows: () => {
        throw new Error("boom")
      },
    }
    const lines: string[] = []
    const runner = createReactionRunner({
      bus: createSessionEventBus(),
      store: failing,
      bindings: [binding],
      log: line => lines.push(line),
      trace: () => {},
    })

    const health = runner.health()

    expect(lines).toEqual(["[reaction-runner] health failed: boom"])
    expect(health.totals).toEqual({ receipts: 0, pending: 0, running: 0, done: 0, failed: 0, dead: 0 })
    expect(health.bindings.map(entry => entry.bindingId)).toEqual(["bind-a"])
    expect(health.bindings[0]?.counts).toEqual({ pending: 0, running: 0, done: 0, failed: 0, dead: 0 })
    expect(health.orphans).toEqual([])
  })
})
