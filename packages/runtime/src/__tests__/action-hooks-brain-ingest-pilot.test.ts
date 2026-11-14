/**
 * Phase 1 exit test for the brain-ingest pilot: a real brain and a real
 * receipt file. A restart between receipt creation and completion must not
 * produce duplicate committed output.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BRAIN_STATE_FILENAME,
  createBrainManager,
  type BrainManager,
  type ExportedSessionLike,
} from "@agentproto/workspace-brain"

import { createSessionEventBus, type SessionCompletedEvent } from "../session-event-bus.js"
import { createBrainIngestReaction } from "../action-hooks/brain-ingest-reaction.js"
import { createReactionReceiptStore } from "../action-hooks/receipt-store.js"
import { createReactionRunner } from "../action-hooks/reaction-runner.js"

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "brain-ingest-pilot-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function transcript(title: string, body: string): ExportedSessionLike {
  return {
    meta: { title },
    messages: [
      { role: "user", text: "how do we ship?", ts: 1700000000000 },
      { role: "assistant", text: body, ts: 1700000001000 },
    ],
  }
}

const SESSION = "sess-pilot"
const WORKSPACE = "ws-a"

function realBrain(brainDir: string): BrainManager {
  return createBrainManager({
    workspace: WORKSPACE,
    brainDir,
    readSession: async () => transcript("Ship it", "we cut a release with cargo cut"),
    listSessionRefs: async () => [],
  })
}

function fakeBrains(brain: BrainManager, sessionWorkspace: Record<string, string | undefined>) {
  const ingestSession = vi.fn((sessionId: string) => brain.ingestSession(sessionId))
  const getBrain = vi.fn(() => ({ ...brain, ingestSession }))
  return {
    ingestSession,
    brains: {
      resolveWorkspace: async (sessionId: string) => sessionWorkspace[sessionId],
      getBrain,
    },
  }
}

function ledgerCount(brainDir: string): number {
  try {
    const parsed = JSON.parse(readFileSync(join(brainDir, BRAIN_STATE_FILENAME), "utf8")) as {
      ingested?: Record<string, unknown>
    }
    return Object.keys(parsed.ingested ?? {}).length
  } catch {
    return 0
  }
}

function walk(dir: string, base = dir): Array<{ path: string; size: number }> {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: Array<{ path: string; size: number }> = []
  for (const name of names) {
    const full = join(dir, name)
    const stats = statSync(full)
    if (stats.isDirectory()) out.push(...walk(full, base))
    else out.push({ path: full.slice(base.length + 1), size: stats.size })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

function sourceFiles(brainDir: string): Array<{ path: string; size: number }> {
  return walk(join(brainDir, "knowledge"))
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const receiptInput = (sessionId: string) => ({
  sessionId,
  event: "agentproto:session-completed",
  occurrenceId: "exit:1",
  bindingId: "builtin:brain-ingest",
  actionId: "session:brain-ingest",
  configRevision: "brain-ingest-v1",
  maxAttempts: 3,
  reactionDepth: 0,
})

describe("brain-ingest pilot", () => {
  it("crash while running: boot reconciliation ingests once and is stable on a second pass", async () => {
    const brainDir = tmp()
    const expectedDir = tmp()
    const storeDir = tmp()
    const receiptPath = join(storeDir, "reaction-receipts.json")
    const brain = realBrain(brainDir)
    const { brains, ingestSession } = fakeBrains(brain, { [SESSION]: WORKSPACE })

    const store1 = createReactionReceiptStore({ filePath: receiptPath })
    const pending = await store1.insertPending(receiptInput(SESSION))
    await store1.markRunning(pending.receiptKey)

    const store2 = createReactionReceiptStore({ filePath: receiptPath })
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => [WORKSPACE] })
    const runner = createReactionRunner({ bus: createSessionEventBus(), store: store2, bindings: [reaction.binding] })

    await runner.reconcileOnBoot()

    const receipt = store2.get(pending.receiptKey)
    expect(receipt?.status).toBe("done")
    expect(receipt?.outcomeRef).toBe(`brain:${WORKSPACE}:${SESSION}`)
    expect(ledgerCount(brainDir)).toBe(1)
    expect(ingestSession).toHaveBeenCalledTimes(1)

    const expected = realBrain(expectedDir)
    await expected.ingestSession(SESSION)
    expect(sourceFiles(brainDir)).toEqual(sourceFiles(expectedDir))

    const filesAfter = sourceFiles(brainDir)
    await runner.reconcileOnBoot()
    expect(ledgerCount(brainDir)).toBe(1)
    expect(ingestSession).toHaveBeenCalledTimes(1)
    expect(sourceFiles(brainDir)).toEqual(filesAfter)
  })

  it("crash after the ingest committed but before the receipt was marked: already-ingested, no duplicate output", async () => {
    const brainDir = tmp()
    const storeDir = tmp()
    const receiptPath = join(storeDir, "reaction-receipts.json")
    const brain = realBrain(brainDir)
    const { brains, ingestSession } = fakeBrains(brain, { [SESSION]: WORKSPACE })

    await brain.ingestSession(SESSION)
    const filesBefore = sourceFiles(brainDir)
    expect(ledgerCount(brainDir)).toBe(1)

    const store = createReactionReceiptStore({ filePath: receiptPath })
    const pending = await store.insertPending(receiptInput(SESSION))
    await store.markRunning(pending.receiptKey)

    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => [WORKSPACE] })
    const runner = createReactionRunner({ bus: createSessionEventBus(), store, bindings: [reaction.binding] })
    await runner.reconcileOnBoot()

    const receipt = store.get(pending.receiptKey)
    expect(receipt?.status).toBe("done")
    expect(receipt?.outcomeRef).toBe(`brain:${WORKSPACE}:${SESSION}`)
    expect(ingestSession).toHaveBeenCalledTimes(1)
    expect(ledgerCount(brainDir)).toBe(1)
    expect(sourceFiles(brainDir)).toEqual(filesBefore)
  })

  it("live path: one owned event ingests once, a duplicate same-occurrence event is a no-op, and a non-owned workspace is untouched", async () => {
    const brainDir = tmp()
    const storeDir = tmp()
    const brain = realBrain(brainDir)
    const { brains, ingestSession } = fakeBrains(brain, {
      [SESSION]: WORKSPACE,
      "sess-other": "ws-b",
    })
    const store = createReactionReceiptStore({ filePath: join(storeDir, "reaction-receipts.json") })
    const reaction = createBrainIngestReaction({ brains, ownedWorkspaces: () => [WORKSPACE] })
    const bus = createSessionEventBus()
    const runner = createReactionRunner({ bus, store, bindings: [reaction.binding] })
    runner.start()

    const event: SessionCompletedEvent = {
      type: "agentproto:session-completed",
      sessionId: SESSION,
      occurrenceId: "exit:1",
      basis: "outcome",
      endedAt: "2026-01-01T00:00:00.000Z",
      ts: "2026-01-01T00:00:00.000Z",
    }
    bus.emit(event)
    await waitFor(() => store.rows().some(row => row.status === "done"))

    const rows = store.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcomeRef).toBe(`brain:${WORKSPACE}:${SESSION}`)
    expect(ledgerCount(brainDir)).toBe(1)
    expect(ingestSession).toHaveBeenCalledTimes(1)

    bus.emit(event)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(store.rows()).toHaveLength(1)
    expect(ingestSession).toHaveBeenCalledTimes(1)

    bus.emit({ ...event, sessionId: "sess-other", occurrenceId: "exit:2" })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(store.rows()).toHaveLength(1)
    expect(ingestSession).toHaveBeenCalledTimes(1)

    runner.stop()
  })

  it("two concurrent ingests of one session produce the same files as one call (in-process determinism only)", async () => {
    const concurrentDir = tmp()
    const singleDir = tmp()

    const concurrent = realBrain(concurrentDir)
    await Promise.all([concurrent.ingestSession(SESSION), concurrent.ingestSession(SESSION)])
    expect(ledgerCount(concurrentDir)).toBe(1)

    const single = realBrain(singleDir)
    await single.ingestSession(SESSION)

    // Two concurrent in-process ingests both read an empty ledger and write
    // the same deterministic chunk uris; this proves in-process determinism,
    // not interleaving safety across processes.
    expect(sourceFiles(concurrentDir)).toEqual(sourceFiles(singleDir))
  })
})
