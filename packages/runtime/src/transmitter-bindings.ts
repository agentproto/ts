/**
 * TransmitterBindingStore — persists which agentproto session a given
 * agentpush (alias, source, contactRef) triple should route inbound
 * messages into.
 *
 * State is in-memory; bindings persist to disk (debounced async write),
 * mirroring the cursor-store pattern in inbound-watcher.ts
 * (loadCursors/schedulePersist/flushSync).
 */

import { resolve, dirname } from "node:path"
import { homedir } from "node:os"
import { readFileSync, promises as fsp } from "node:fs"
import type { OutboundProvider } from "./outbound-adapters.js"

// ── Types ─────────────────────────────────────────────────────────────

export interface TransmitterBinding {
  /** Imported agentpush MCP alias (or bot alias for native providers). */
  alias: string
  /** Channel/phone the poll is scoped to. */
  source: string
  /** Sender id (agentpush contact_ref). */
  contactRef: string
  /** agentproto session to route inbound INTO. */
  sessionId: string
  mode: "route" | "route-or-spawn"
  /** Outbound provider this binding was created through. Default "agentpush". */
  provider?: OutboundProvider
  /** ms epoch of last activity. */
  lastSeenTs: number
}

export interface TransmitterBindingStore {
  get(alias: string, source: string, contactRef: string): TransmitterBinding | undefined
  upsert(
    b: Omit<TransmitterBinding, "lastSeenTs"> & { lastSeenTs?: number },
  ): TransmitterBinding
  remove(alias: string, source: string, contactRef: string): boolean
  list(): TransmitterBinding[]
}

// ── Constants ─────────────────────────────────────────────────────────

export const BINDINGS_FILE_PATH = (): string =>
  resolve(homedir(), ".agentproto", "transmitter-bindings.json")

const PERSIST_DEBOUNCE_MS = 1_500

const keyOf = (alias: string, source: string, contactRef: string): string =>
  `${alias}:${source}:${contactRef}`

// ── Factory ───────────────────────────────────────────────────────────

export function createTransmitterBindingStore(opts?: {
  /** Override persist path. Default ~/.agentproto/transmitter-bindings.json */
  filePath?: string
  /** Injectable clock for tests. */
  nowMs?: () => number
  /** Debounce interval for disk persistence. Default matches cursor store. */
  debounceMs?: number
}): TransmitterBindingStore {
  const filePath = opts?.filePath ?? BINDINGS_FILE_PATH()
  const nowMs = opts?.nowMs ?? Date.now
  const debounceMs = opts?.debounceMs ?? PERSIST_DEBOUNCE_MS

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  // ── Load-on-construct (mirrors loadCursors in inbound-watcher.ts) ──

  const load = (): Map<string, TransmitterBinding> => {
    const out = new Map<string, TransmitterBinding>()
    let raw: string
    try {
      raw = readFileSync(filePath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[transmitter-bindings] read failed, starting empty: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return out
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, TransmitterBinding>
      for (const [key, binding] of Object.entries(parsed)) {
        out.set(key, binding)
      }
    } catch (err) {
      console.warn(
        `[transmitter-bindings] corrupt file, starting empty: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return out
  }

  const bindings = load()

  // ── Persistence (mirrors schedulePersist/flushSync) ────────────────

  const snapshot = (): Record<string, TransmitterBinding> => {
    const out: Record<string, TransmitterBinding> = {}
    for (const [key, binding] of bindings.entries()) out[key] = binding
    return out
  }

  const schedulePersist = (): void => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void (async () => {
        try {
          const snap = snapshot()
          await fsp.mkdir(dirname(filePath), { recursive: true })
          await fsp.writeFile(filePath, JSON.stringify(snap, null, 2) + "\n")
        } catch (err) {
          console.warn(
            `[transmitter-bindings] persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })()
    }, debounceMs)
  }

  // ── Public interface ────────────────────────────────────────────────

  return {
    get(alias: string, source: string, contactRef: string): TransmitterBinding | undefined {
      return bindings.get(keyOf(alias, source, contactRef))
    },

    upsert(
      b: Omit<TransmitterBinding, "lastSeenTs"> & { lastSeenTs?: number },
    ): TransmitterBinding {
      const binding: TransmitterBinding = {
        alias: b.alias,
        source: b.source,
        contactRef: b.contactRef,
        sessionId: b.sessionId,
        mode: b.mode,
        provider: b.provider,
        lastSeenTs: b.lastSeenTs ?? nowMs(),
      }
      bindings.set(keyOf(b.alias, b.source, b.contactRef), binding)
      schedulePersist()
      return binding
    },

    remove(alias: string, source: string, contactRef: string): boolean {
      const existed = bindings.delete(keyOf(alias, source, contactRef))
      if (existed) schedulePersist()
      return existed
    },

    list(): TransmitterBinding[] {
      return Array.from(bindings.values())
    },
  }
}
