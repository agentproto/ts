/**
 * Workshop-brain subscriber — auto-ingest a workspace's conversations when its
 * sessions exit.
 *
 * Subscribes to `session:exited` on the {@link SessionEventBus} and, after a
 * short debounce, fire-and-forgets an ingestion of each freshly-exited session
 * into its workspace's brain. The debounce batches a flurry of exits (e.g. an
 * orchestrator tearing down N children at once) into one pass instead of N
 * index rebuilds.
 *
 * Mirrors `webhook-notifier.ts`'s containment discipline: the handler never
 * throws into the bus's hot path — every error is swallowed and logged, so a
 * brain hiccup can never take down an exit event.
 */

import type { SessionEventBus } from "./session-event-bus.js"
import type { WorkspaceBrains } from "./workspace-brains.js"

export interface WorkspaceBrainSubscriberOptions {
  readonly bus: SessionEventBus
  /** The shared brain registry. */
  readonly brains: WorkspaceBrains
  /** Debounce window for batching consecutive exits. Default 5000ms. */
  debounceMs?: number
}

export interface WorkspaceBrainSubscriber {
  /** Wire the handler onto the bus (idempotent). */
  start(): void
  /** Unsubscribe (idempotent). */
  stop(): void
  /** Flush any pending (not-yet-debounced) exits now. */
  flush(): void
}

export function createWorkspaceBrainSubscriber(
  opts: WorkspaceBrainSubscriberOptions,
): WorkspaceBrainSubscriber {
  const { bus, brains } = opts
  const debounceMs = opts.debounceMs ?? 5_000

  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null

  const drain = (): void => {
    timer = null
    if (pending.size === 0) return
    const sessionIds = Array.from(pending)
    pending.clear()
    for (const sessionId of sessionIds) {
      void ingest(sessionId)
    }
  }

  // Fire-and-forget, contained — never throws.
  const ingest = (sessionId: string): Promise<void> => {
    return (async () => {
      try {
        const workspace = await brains.resolveWorkspace(sessionId)
        if (!workspace) return
        const result = await brains.getBrain(workspace).ingestSession(sessionId)
        if (result.ok) {
          console.log(
            `[workspace-brain] ingested session ${sessionId} into workspace "${workspace}"` +
              (result.sourceId ? ` as ${result.sourceId}` : ""),
          )
        }
      } catch (err) {
        console.warn(
          `[workspace-brain] ingest of ${sessionId} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })()
  }

  const onExit = (ev: { sessionId: string }): void => {
    pending.add(ev.sessionId)
    if (timer === null) {
      timer = setTimeout(drain, debounceMs)
    }
  }

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = bus.on("session:exited", onExit)
    },
    stop() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      unsubscribe?.()
      unsubscribe = null
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      drain()
    },
  }
}
