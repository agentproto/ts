/**
 * The session-lifecycle classifier and the delivery floor.
 *
 * These go through the engine (not the classifier alone): the level a follow
 * digest records and delivers comes from `computeLevel`, so an EMPTY
 * classifier registry still pins a floored `session.awaiting_input` envelope
 * at level 3, and a `fyi` digest holding one lands as `next-turn`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClassifierRegistry } from "@agentproto/delivery"

import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import type { SessionMessage } from "../session-message.js"
import { createSessionFollowStore, type SessionFollowInput } from "../session-follow-store.js"
import { wireSessionFollow, type SessionFollowHandle } from "../session-follow.js"
import type { SessionDescriptor } from "../sessions.js"

type Desc = Partial<SessionDescriptor> & { id: string }

const T0 = "2026-11-04T00:00:00.000Z"

const running = (id: string, extra: Partial<SessionDescriptor> = {}): Desc => ({
  id,
  status: "running",
  cwd: "/work/proj",
  ...extra,
})

function stubRegistry(initial: Desc[]) {
  const sessions = new Map<string, Desc>(initial.map(d => [d.id, d]))
  const sent: SessionMessage[] = []
  const sendMessage = vi.fn(async (msg: SessionMessage) => {
    sent.push(msg)
    return { messageId: msg.id }
  })
  return {
    sent,
    registry: {
      get: (id: string) => sessions.get(id) as SessionDescriptor | undefined,
      sendMessage: sendMessage as unknown as (
        msg: SessionMessage,
        opts?: { source?: string; origin?: string },
      ) => Promise<unknown>,
    },
  }
}

describe("session-lifecycle classifier through the engine", () => {
  let bus: SessionEventBus
  let handle: SessionFollowHandle | undefined
  let tmp: string

  beforeEach(() => {
    bus = createSessionEventBus()
    tmp = mkdtempSync(join(tmpdir(), "session-lifecycle-"))
  })
  afterEach(() => {
    handle?.dispose()
    handle = undefined
    rmSync(tmp, { recursive: true, force: true })
  })

  function setup(
    descs: Desc[],
    follow: Partial<SessionFollowInput> & Pick<SessionFollowInput, "selector">,
    extra: Partial<Parameters<typeof wireSessionFollow>[0]> = {},
  ) {
    const reg = stubRegistry(descs)
    const store = createSessionFollowStore({ persist: false })
    store.upsert({ batchMs: 0, follower: "chief", ...follow })
    handle = wireSessionFollow({
      registry: reg.registry,
      sessionEvents: bus,
      store,
      readLastOutput: () => undefined,
      parkedPath: join(tmp, "parked.jsonl"),
      ledgerPath: join(tmp, "delivery-ledger.jsonl"),
      log: () => {},
      ...extra,
    })
    return reg
  }

  const awaitingInput = (sessionId: string): void => {
    bus.emit({
      type: "session:awaiting-input",
      sessionId,
      ts: T0,
      question: { text: "which one?", source: "structured" },
    } as never)
  }

  const ledger = (): Array<Record<string, unknown>> =>
    readFileSync(join(tmp, "delivery-ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as Record<string, unknown>)

  it("computes level 3 for session.awaiting_input with an EMPTY classifier registry", async () => {
    const { sent } = setup(
      [running("chief"), running("w")],
      { selector: { sessionIds: ["w"] } },
      { classifierRegistry: createClassifierRegistry([]) },
    )

    awaitingInput("w")
    await handle!.flush()

    expect(sent).toHaveLength(1)
    expect(ledger()).toHaveLength(1)
    expect(ledger()[0]).toMatchObject({
      producer: "follow",
      type: "awaiting-input",
      floor: "awaiting-human",
      level: 3,
      applied: false,
    })
  })

  it("delivers a fyi digest holding a must-wake entry as next-turn", async () => {
    const { sent } = setup(
      [running("chief"), running("w")],
      { selector: { sessionIds: ["w"] }, urgency: "fyi" },
      { classifierRegistry: createClassifierRegistry([]) },
    )

    awaitingInput("w")
    await handle!.flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.urgency).toBe("next-turn")
    expect(ledger()).toHaveLength(1)
    expect(ledger()[0]).toMatchObject({ level: 3, floor: "awaiting-human" })
  })
})
