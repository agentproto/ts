/**
 * A sentinel targeting an `external` session (Claude Desktop / `claude` CLI)
 * must land its events in the SESSION inbox even after the row's liveness
 * window lapsed: an external row has no process to restart, so a not-alive
 * bounce would park the event in the sentinel journal and orphan the sentinel,
 * and `agentproto hook inbox` would never see it.
 */

import "../sentinel-platform.js"

import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSentinelStore, createSentinelRuntime, createFakeSentinelProvider, makeFakeEvent, singleMatch } from "@agentproto/sentinel"

const WINDOW = 10 * 60_000

function setup(opts?: { kill?: boolean }) {
  let clock = Date.parse("2026-01-01T00:00:00.000Z")
  const tmp = mkdtempSync(join(tmpdir(), "external-sentinel-"))
  const registry = createSessionsRegistry({
    persist: false,
    transcriptDir: tmp,
    sessionEvents: createSessionEventBus(),
    externalSessionLivenessMs: WINDOW,
    externalNow: () => clock,
  })
  registry.touchExternal({ id: "desktop-1", host: "claude-desktop" })
  if (opts?.kill) registry.kill("desktop-1")
  clock += WINDOW + 60_000

  const store = createSentinelStore({ persist: false })
  const provider = createFakeSentinelProvider()
  const sentinel = store.create({
    provider: "fake",
    handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
    spec: {
      match: singleMatch("fake:widget-1"),
      until: { kind: "never" },
      target: { kind: "session", sessionId: "desktop-1", urgency: "next-turn" },
    },
  })
  provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1", summary: "Widget created" }))

  // Wired like index.ts: liveness by STATUS; restart rejects external rows.
  const restartSession = vi.fn(async (id: string) => {
    throw new Error(`session "${id}" is an external session (no process the daemon can restart)`)
  })
  const parkedPath = join(tmp, "parked.jsonl")
  const runtime = createSentinelRuntime({
    store,
    registry,
    resolveProvider: async slug => (slug === "fake" ? provider : null),
    isSessionAlive: id => {
      const d = registry.get(id)
      return !!d && (d.status === "running" || d.status === "starting")
    },
    restartSession,
    sessionInfo: id => {
      const d = registry.get(id)
      return d ? { endedReason: d.endedReason, archived: d.archived, retiredAt: d.retiredAt } : undefined
    },
    parkedPath,
    triagePath: join(tmp, "triage.jsonl"),
    log: () => undefined,
  })
  const cleanup = () => {
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  }
  return { registry, store, sentinel, runtime, restartSession, parkedPath, cleanup }
}

describe("sentinel event for an expired external session", () => {
  it("lands in the session inbox and does not orphan the sentinel", async () => {
    const t = setup()
    try {
      expect(t.registry.get("desktop-1")?.status).toBe("exited")

      await t.runtime.pollOnce()

      const inbox = t.registry.listInbox("desktop-1")!
      expect(inbox).toHaveLength(1)
      expect(inbox[0]).toMatchObject({ text: "[fake] Widget created", delivered: { via: "inbox" } })
      expect(t.store.get(t.sentinel.id)?.status).not.toBe("orphaned")
      expect(t.restartSession).not.toHaveBeenCalled()
      expect(existsSync(t.parkedPath) ? readFileSync(t.parkedPath, "utf8").trim() : "").toBe("")
    } finally {
      t.cleanup()
    }
  })

  it("still parks and orphans when the external row was deliberately ended", async () => {
    const t = setup({ kill: true })
    try {
      await t.runtime.pollOnce()

      expect(t.registry.listInbox("desktop-1")).toEqual([])
      expect(t.store.get(t.sentinel.id)?.status).toBe("orphaned")
    } finally {
      t.cleanup()
    }
  })
})
