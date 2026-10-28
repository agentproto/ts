/**
 * AIP-72 section 9 capture, native-dir-diff path (`memory-capture.ts`): a
 * turn end diffs the session's projected native memory dir and writes what
 * changed to the agent's store as proposals, never commits, once per
 * change. Temp dirs, a real FilesMemoryStore and session-event bus.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FilesMemoryStore } from "@agentproto/memory"
import { projectNativeMemory, writeNativeMemorySnapshot } from "@agentproto/harness"
import { createNativeMemoryCapture, type NativeMemoryCaptureSession } from "../memory-capture.js"
import { createSessionEventBus } from "../session-event-bus.js"

const NOW = new Date("2026-10-28T12:00:00.000Z")
const RUN7 = `---
name: release-notes-french
description: Release notes should be written in French
metadata:
  node_type: memory
  type: feedback
  originSessionId: 57ba2314-30ee-42b0-b9a1-65d619c856fa
  modified: 2026-10-28T03:48:20.484Z
---
Write all release notes in French.
`

let root: string
let configDir: string
let store: FilesMemoryStore
let sessions: Map<string, NativeMemoryCaptureSession>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-capture-"))
  configDir = join(root, "adapter-config", "sess_a")
  store = new FilesMemoryStore({ root: join(root, "store"), now: () => NOW })
  sessions = new Map()
  sessions.set("sess_a", {
    id: "sess_a",
    adapterConfigDir: configDir,
    meta: {
      memoryCapture: "native-dir-diff",
      memoryStoreRoot: join(root, "store"),
      memoryCaptureTags: "agent:scout,project:acme",
    },
  })
  const snapshot = projectNativeMemory(join(configDir, "memory"), [])
  writeNativeMemorySnapshot(configDir, snapshot)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function setup() {
  const bus = createSessionEventBus()
  const capture = createNativeMemoryCapture({
    registry: { get: id => sessions.get(id) },
    sessionEvents: bus,
    memoryStoreAt: () => store,
    now: () => NOW,
    log: () => {},
  })
  const turnEnd = (sessionId = "sess_a") =>
    bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: NOW.toISOString() })
  return { bus, capture, turnEnd }
}

async function proposals() {
  return store.list({ proposals: true })
}
async function committed() {
  return store.list({ status: ["active", "superseded", "archived"] })
}

describe("native memory capture at turn end", () => {
  it("proposes a new native file exactly once, commits nothing", async () => {
    const { capture } = setup()
    await writeFile(join(configDir, "memory", "feedback_release_notes_language.md"), RUN7)
    expect(await capture.capture("sess_a")).toBe(1)
    const pending = await proposals()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.item).toMatchObject({
      slug: "release-notes-french",
      type: "feedback",
      kind: "feedback",
      tags: ["agent:scout", "project:acme"],
      provenance: { source: "native-memory", sessionId: "sess_a", ref: "claude-code:57ba2314-30ee-42b0-b9a1-65d619c856fa" },
      capture: { mode: "live" },
    })
    expect(await committed()).toEqual([])
    // A second turn end with no change proposes nothing.
    expect(await capture.capture("sess_a")).toBe(0)
    expect(await proposals()).toHaveLength(1)
    capture.dispose()
  })

  it("runs from the session-event bus on turn-end and on exit", async () => {
    const { bus, capture, turnEnd } = setup()
    await writeFile(join(configDir, "memory", "feedback_a.md"), RUN7)
    turnEnd()
    await expect.poll(async () => (await proposals()).length).toBe(1)
    await writeFile(join(configDir, "memory", "user_b.md"), RUN7.replace("release-notes-french", "prefers-tabs").replace("type: feedback", "type: user"))
    bus.emit({ type: "session:exited", sessionId: "sess_a", status: "exited", ts: NOW.toISOString() })
    await expect.poll(async () => (await proposals()).length).toBe(2)
    turnEnd()
    expect(await capture.capture("sess_a")).toBe(0)
    expect(await proposals()).toHaveLength(2)
    expect(await committed()).toEqual([])
    capture.dispose()
  })

  it("re-proposes a native file the agent changed again", async () => {
    const { capture } = setup()
    const file = join(configDir, "memory", "feedback_a.md")
    await writeFile(file, RUN7)
    expect(await capture.capture("sess_a")).toBe(1)
    await writeFile(file, RUN7.replace("in French.", "in French, always."))
    expect(await capture.capture("sess_a")).toBe(1)
    expect(await proposals()).toHaveLength(2)
    capture.dispose()
  })

  it("does nothing for a session the spawn did not project, or with memory disabled", async () => {
    const { capture } = setup()
    await writeFile(join(configDir, "memory", "feedback_a.md"), RUN7)
    sessions.set("sess_b", { id: "sess_b", adapterConfigDir: configDir, meta: { memoryStoreRoot: join(root, "store") } })
    expect(await capture.capture("sess_b")).toBe(0)
    sessions.get("sess_a")!.meta!.memory = "disabled"
    expect(await capture.capture("sess_a")).toBe(0)
    expect(await capture.capture("missing")).toBe(0)
    expect(await proposals()).toEqual([])
    capture.dispose()
  })
})
