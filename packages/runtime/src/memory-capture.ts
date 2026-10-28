/**
 * AIP-72 section 9 capture, native-dir-diff path: at every turn end and at
 * session exit, diff the session's projected native memory dir against the
 * snapshot the driver wrote at spawn (`@agentproto/harness`
 * `native-memory.ts`), and write each difference to the agent's store as a
 * PROPOSAL (rule 24: a capture never commits).
 *
 * One place: the daemon's session-event bus (`session:turn-end`,
 * `session:exited`), the same bus the clerk turn-end controller listens to.
 * Only sessions whose spawn projected the dir carry
 * `meta.memoryCapture: "native-dir-diff"` (set in `session-spawn.ts`), so
 * everything else is a no-op. Sandbox sessions never get the flag: their
 * config dir lives in the box.
 *
 * Dedupe: the snapshot records every file it proposed with the sha it
 * proposed (`snapshot.proposed`), so an unchanged file is never proposed
 * twice, across turns and respawns of the lineage. Never throws into the
 * bus: a failure is a log line.
 */

import {
  diffNativeMemory,
  NATIVE_MEMORY_DIR,
  nativeMemoryProposals,
  readNativeMemorySnapshot,
  writeNativeMemorySnapshot,
} from "@agentproto/harness"
import type { MemoryStore } from "@agentproto/memory"
import { join } from "node:path"

/** The descriptor slice the capture reads. */
export interface NativeMemoryCaptureSession {
  id: string
  meta?: Record<string, string>
  adapterConfigDir?: string
}

export interface NativeMemoryCaptureBus {
  on(type: "session:turn-end" | "session:exited", handler: (ev: { sessionId: string }) => void): () => void
}

export interface NativeMemoryCaptureOptions {
  registry: { get(id: string): NativeMemoryCaptureSession | undefined }
  sessionEvents: NativeMemoryCaptureBus
  memoryStoreAt: (root: string) => MemoryStore
  log?: (message: string) => void
  now?: () => Date
}

export interface NativeMemoryCapture {
  /** Run one capture for a session now; resolves to the proposals written. */
  capture(sessionId: string): Promise<number>
  dispose(): void
}

export function createNativeMemoryCapture(opts: NativeMemoryCaptureOptions): NativeMemoryCapture {
  const log = opts.log ?? (message => console.warn(`[memory-capture] ${message}`))
  // One capture at a time per session: a turn end and the exit can land
  // back to back and both rewrite the snapshot.
  const chains = new Map<string, Promise<number>>()

  async function run(sessionId: string): Promise<number> {
    const session = opts.registry.get(sessionId)
    const meta = session?.meta
    if (!session || meta?.memoryCapture !== "native-dir-diff") return 0
    const root = meta.memoryStoreRoot
    const configDir = session.adapterConfigDir
    if (!root || !configDir || meta.memory === "disabled") return 0
    const snapshot = readNativeMemorySnapshot(configDir)
    if (!snapshot) return 0
    const store = opts.memoryStoreAt(root)
    const diff = diffNativeMemory(join(configDir, NATIVE_MEMORY_DIR), snapshot)
    const tags = (meta.memoryAnchors ?? "").split(",").filter(Boolean)
    const proposals = await nativeMemoryProposals(diff, {
      sessionId,
      producer: "adapter:claude-code",
      tags,
      now: (opts.now?.() ?? new Date()).toISOString(),
      readItem: async id => (await store.read(id))?.item,
    })
    let written = 0
    for (const proposal of proposals) {
      if (snapshot.proposed[proposal.file] === proposal.sha) continue
      try {
        await store.write(proposal.item, { mode: "propose" })
        snapshot.proposed[proposal.file] = proposal.sha
        written++
      } catch (err) {
        log(`session ${sessionId}: ${proposal.file} not proposed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (written > 0) writeNativeMemorySnapshot(configDir, snapshot)
    return written
  }

  function capture(sessionId: string): Promise<number> {
    const next = (chains.get(sessionId) ?? Promise.resolve(0))
      .catch(() => 0)
      .then(() => run(sessionId))
      .catch(err => {
        log(`session ${sessionId}: capture failed: ${err instanceof Error ? err.message : String(err)}`)
        return 0
      })
    chains.set(sessionId, next)
    void next.finally(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId)
    })
    return next
  }

  const offTurnEnd = opts.sessionEvents.on("session:turn-end", ev => void capture(ev.sessionId))
  const offExit = opts.sessionEvents.on("session:exited", ev => void capture(ev.sessionId))
  return {
    capture,
    dispose() {
      offTurnEnd()
      offExit()
    },
  }
}
