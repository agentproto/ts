/**
 * The daemon delivery.apply switch on the sentinel path: an opted-in event
 * type has its classified level applied to the inbox urgency, and an applied
 * level-0 event is ledgered and dropped without ever reaching the target.
 * No switch means the sentinel keeps its original wake-for-everything
 * delivery.
 */

import "../sentinel-platform.js"

import { registerGithubDeliveryModule } from "@agentproto/delivery-github"
import { afterEach, describe, expect, it } from "vitest"
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
import type { DeliveryApplyConfig } from "@agentproto/delivery"
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

function setup(apply: DeliveryApplyConfig | undefined): Harness {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-delivery-apply-"))
  const registry = createSessionsRegistry({
    persist: false,
    transcriptDir: dir,
    sessionEvents: createSessionEventBus(),
  })
  registry.touchExternal({ id: "desktop-1", host: "claude-desktop" })

  const store = createSentinelStore({ persist: false })
  const provider = createFakeSentinelProvider()
  const subject = "test:acme/widgets#1"
  store.create({
    provider: "fake",
    handle: { provider: "fake", remoteId: subject, cursor: "0" },
    spec: {
      match: singleMatch(subject, ["test.*"]),
      until: { kind: "never" },
      target: { kind: "session", sessionId: "desktop-1", urgency: "next-turn" },
    },
  })
  provider.emit(makeFakeEvent({ id: "evt_fyi", type: "test.build.completed", subject, levelHint: 1 }))
  provider.emit(makeFakeEvent({ id: "evt_drop", type: "test.build.completed", subject, levelHint: 0 }))

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
    ...(apply !== undefined ? { apply: () => apply } : {}),
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

function ledgerLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

afterEach(() => {
  // no fake timers used here
})

describe("sentinel delivery.apply switch", () => {
  it("applies the classified level and drops an applied level-0 event", async () => {
    const h = setup({ types: { "test.*": true } })
    try {
      await h.runtime.pollOnce()

      const inbox = h.registry.listInbox("desktop-1")!
      expect(inbox).toHaveLength(1)
      expect(inbox[0]!.urgency).toBe("fyi")
      expect(inbox[0]!.text).toContain("test.build.completed")

      const lines = ledgerLines(h.ledgerPath)
      expect(lines).toHaveLength(2)
      expect(lines.find(l => l.eventId === "evt_fyi")).toMatchObject({ applied: true, level: 1 })
      expect(lines.find(l => l.eventId === "evt_drop")).toMatchObject({
        applied: true,
        level: 0,
        outcome: "dropped",
      })
    } finally {
      h.cleanup()
    }
  })

  it("leaves delivery untouched when the type is not opted in", async () => {
    const h = setup({ types: { "github.pr_merged": true } })
    try {
      await h.runtime.pollOnce()

      const inbox = h.registry.listInbox("desktop-1")!
      expect(inbox).toHaveLength(2)
      expect(inbox.every(m => m.urgency === "next-turn")).toBe(true)

      const lines = ledgerLines(h.ledgerPath)
      expect(lines).toHaveLength(2)
      expect(lines.every(l => l.applied === false)).toBe(true)
    } finally {
      h.cleanup()
    }
  })
})
