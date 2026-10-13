/**
 * A2A push notification delivery (`a2a-task-http.ts`'s config store half is
 * in a2a-tasks.ts). One background watcher per task, started the moment a
 * push config exists for a still-running task: it consumes `watchTask` (the
 * same poll loop the SSE streams use — never a copy) and POSTs every yielded
 * `StreamResponse` member to every config of the task that exists at that
 * moment (the store is re-read per event, so a deleted config stops
 * receiving at once). Delivery is best-effort: a failed POST is logged and
 * retried per the rules below, never thrown, and never stops the watcher.
 *
 * Watchers live in memory only: after a daemon restart, tasks that were
 * still being watched are not resumed (their configs persist; a later
 * config create on the same task starts a fresh watcher).
 */

import {
  watchTask,
  type A2aTask,
  type A2aTaskPushNotificationConfig,
} from "./a2a-tasks.js"

/** Per-POST knobs, injectable so tests run fast. */
export interface A2aPushDeps {
  /** `fetch` used for every webhook POST. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Poll cadence of the shared task watcher. Defaults to 1000 ms. */
  pollMs?: number
  /** Hard cap on one watcher (same 30 min cap as SSE streaming). */
  maxMs?: number
  /** Per-POST attempt timeout. Defaults to 10 s. */
  requestTimeoutMs?: number
  /** Backoff between POST attempts (nth retry waits nth entry). Defaults to
   *  `[1 s, 5 s]` — at most 3 attempts total. */
  retryDelaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Failures are logged here, never thrown. Defaults to a silent log. */
  log?: (line: string) => void
}

const DEFAULT_PUSH_POLL_MS = 1000
const DEFAULT_PUSH_MAX_MS = 30 * 60 * 1000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000]

/** `token` rides as the A2A notification token header (A2A 0.3 named it;
 *  1.0 kept the `token` field and every SDK still sends this header). */
export const A2A_NOTIFICATION_TOKEN_HEADER = "X-A2A-Notification-Token"

/**
 * POST one `StreamResponse` member to one config. 2xx is done; a 4xx other
 * than 408/429 is not retried; anything else (5xx, 408, 429, network error,
 * timeout) is retried up to `retryDelaysMs.length + 1` attempts. Failures
 * are logged, never thrown.
 */
export async function deliverPushEvent(
  config: A2aTaskPushNotificationConfig,
  body: unknown,
  deps: A2aPushDeps,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const log = deps.log ?? ((): void => {})
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)))
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (config.token !== undefined && config.token !== "") headers[A2A_NOTIFICATION_TOKEN_HEADER] = config.token
  if (config.authentication !== undefined && config.authentication.credentials !== undefined) {
    headers.authorization = `${config.authentication.scheme} ${config.authentication.credentials}`
  }
  for (let attempt = 0; ; attempt++) {
    let status: number | undefined
    try {
      const res = await fetchImpl(config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = res.status
      if (res.status >= 200 && res.status < 300) return
    } catch (err) {
      log(`a2a push: POST to ${config.url} for task ${config.taskId} failed: ${err instanceof Error ? err.message : String(err)} (attempt ${attempt + 1})`)
      status = undefined
    }
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      log(`a2a push: POST to ${config.url} for task ${config.taskId} answered ${status}; not retried`)
      return
    }
    if (attempt >= delays.length) {
      log(`a2a push: POST to ${config.url} for task ${config.taskId} gave up after ${attempt + 1} attempt(s) (last status ${status ?? "network error"})`)
      return
    }
    await sleep(delays[attempt]!)
  }
}

/** The one in-memory watcher registry: `taskId` → its running watcher. */
export interface A2aPushService {
  /** Start one watcher for the task if none runs. The watcher re-reads
   *  `listConfigs` before every delivery, ends on the terminal event (after
   *  delivering it), at the 30 min cap, or when `readTask` fails. */
  ensureWatching(input: {
    appId: string
    taskId: string
    readTask: (taskId: string) => Promise<A2aTask>
    listConfigs: () => Promise<A2aTaskPushNotificationConfig[]>
  }): void
  /** A config created on an already terminal task: store it, then send one
   *  final `{statusUpdate: {final: true}}` — no watcher. */
  deliverFinal(input: {
    task: A2aTask
    listConfigs: () => Promise<A2aTaskPushNotificationConfig[]>
  }): Promise<void>
  /** True while a watcher runs for this task (one per task, never per
   *  config). */
  isWatching(taskId: string): boolean
  activeWatchers(): number
}

/** The `StreamResponse` body of a delivered event: the yielded oneof member
 *  itself (`{task}` / `{statusUpdate}` / `{artifactUpdate}`); the `error`
 *  marker never reaches delivery (the watcher ends on it). */

export function createA2aPushService(deps: A2aPushDeps = {}, onIdle?: () => void): A2aPushService {
  const log = deps.log ?? ((): void => {})
  const pollMs = Math.max(1, deps.pollMs ?? DEFAULT_PUSH_POLL_MS)
  const maxMs = deps.maxMs ?? DEFAULT_PUSH_MAX_MS
  const now = deps.now ?? Date.now
  const running = new Map<string, Promise<void>>()

  const service: A2aPushService = {
    ensureWatching({ taskId, readTask, listConfigs }) {
      if (running.has(taskId)) return
      const run = (async () => {
        try {
          const watcher = watchTask(taskId, { readTask, pollMs, deadline: now() + maxMs, initial: false, ...(deps.sleep ? { sleep: deps.sleep } : {}) })
          for await (const ev of watcher) {
            if ("error" in ev) {
              log(`a2a push: watcher for task ${taskId} stopped: ${ev.error.message}`)
              return
            }
            const configs = await listConfigs()
            for (const config of configs) {
              await deliverPushEvent(config, ev, deps)
            }
            if ("statusUpdate" in ev && ev.statusUpdate.final === true) return
          }
        } catch (err) {
          log(`a2a push: watcher for task ${taskId} failed: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
          running.delete(taskId)
          if (running.size === 0) onIdle?.()
        }
      })()
      running.set(taskId, run)
    },
    async deliverFinal({ task, listConfigs }) {
      const configs = await listConfigs()
      if (configs.length === 0) return
      const body = {
        statusUpdate: {
          taskId: task.id,
          ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
          status: task.status,
          final: true,
        },
      }
      for (const config of configs) {
        await deliverPushEvent(config, body, deps)
      }
    },
    isWatching(taskId) {
      return running.has(taskId)
    },
    activeWatchers() {
      return running.size
    },
  }
  return service
}

/** One push service per daemon state dir, in memory for the process's
 *  lifetime (watchers included — they are not resumed across restarts). The
 *  entry is pruned once its last watcher ends, so a later create builds a
 *  fresh service from the calling request's deps. */
const services = new Map<string, A2aPushService>()

export function getA2aPushService(stateDir: string, create: (onIdle: () => void) => A2aPushService): A2aPushService {
  const existing = services.get(stateDir)
  if (existing) return existing
  const service = create(() => {
    if (services.get(stateDir) === service) services.delete(stateDir)
  })
  services.set(stateDir, service)
  return service
}

