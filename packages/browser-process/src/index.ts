/**
 * Shared primitive for launching and health-waiting browser service processes.
 *
 * Two exports:
 *   - `waitHealthy`         — poll a health URL until it responds OK or timeout.
 *   - `ensureBrowserProcess` — idempotent: probe once, skip spawn if already up,
 *                              else launch via spec.launch() and wait for health.
 */

import type { ChildProcess } from "node:child_process"

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface BrowserProcessSpec {
  kind: string
  healthUrl: string
  /**
   * Spawn the service and return its ChildProcess, OR return null if the
   * process is externally managed (e.g. launchd) — in that case `pid` in the
   * result will be `undefined`.
   */
  launch(): ChildProcess | null
  timeoutMs?: number
  intervalMs?: number
  log?: (msg: string) => void
  /**
   * Opt-in non-blocking cold start. When set, `ensureBrowserProcess` polls
   * health for only this many milliseconds after `launch()`. If the service
   * becomes healthy in that window it returns `{ healthy: true }` as usual;
   * if not, it kicks off a detached background `waitHealthy` (up to
   * `timeoutMs`) so the booting process keeps converging, and returns
   * IMMEDIATELY with `{ healthy: false }`. When unset (default), behaviour is
   * unchanged — blocking wait up to `timeoutMs`.
   */
  initialWaitMs?: number
}

export interface BrowserProcessResult {
  baseUrl: string
  wasAlreadyRunning: boolean
  /**
   * Whether the service is confirmed healthy at return time. Always true on
   * the warm path (`wasAlreadyRunning: true`) and on the blocking cold path.
   * Only `false` when `spec.initialWaitMs` was set and the service had not
   * become healthy within that bounded window — convergence continues in the
   * background.
   */
  healthy: boolean
  pid?: number
  stop?: () => Promise<void>
}

async function probe(healthUrl: string): Promise<boolean> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 3000)
  try {
    const r = await fetch(healthUrl, { signal: ac.signal })
    return r.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

/**
 * Poll `healthUrl` until it returns an OK response, then return that Response.
 * Throws if `timeoutMs` (default 60 000) elapses before a healthy response.
 */
export async function waitHealthy(
  healthUrl: string,
  opts?: {
    timeoutMs?: number
    intervalMs?: number
    log?: (s: string) => void
  }
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const intervalMs = opts?.intervalMs ?? 1_000
  const log = opts?.log
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 3000)
    try {
      const r = await fetch(healthUrl, { signal: ac.signal })
      if (r.ok) return r
    } catch {
      // not yet healthy — keep polling
    } finally {
      clearTimeout(t)
    }
    log?.(`waiting for ${healthUrl}…`)
  }
  throw new Error(
    `service at ${healthUrl} did not become healthy within ${timeoutMs / 1000}s`
  )
}

/**
 * Idempotent service launcher.
 * 1. Probes `spec.healthUrl` — if already healthy, returns `{ wasAlreadyRunning: true }`.
 * 2. Calls `spec.launch()` (may return `null` for externally managed services).
 * 3. Polls health until `spec.timeoutMs` — returns `{ pid, wasAlreadyRunning: false }`.
 */
export async function ensureBrowserProcess(
  spec: BrowserProcessSpec
): Promise<BrowserProcessResult> {
  const baseUrl = new URL(spec.healthUrl).origin

  if (await probe(spec.healthUrl)) {
    return { baseUrl, wasAlreadyRunning: true, healthy: true }
  }

  const child = spec.launch()

  // ── Non-blocking cold start (opt-in via spec.initialWaitMs) ─────────────────
  if (spec.initialWaitMs !== undefined) {
    try {
      const res = await waitHealthy(spec.healthUrl, {
        timeoutMs: spec.initialWaitMs,
        intervalMs: spec.intervalMs,
        log: spec.log,
      })
      await res.body?.cancel().catch(() => {})
      return { baseUrl, pid: child?.pid, wasAlreadyRunning: false, healthy: true }
    } catch {
      // Not healthy within the bounded window — keep converging in the
      // background (fire-and-forget) so the booting process isn't abandoned,
      // and return promptly with healthy: false.
      spec.log?.(
        `[${spec.kind}] not healthy within ${spec.initialWaitMs}ms — continuing health-wait in background`
      )
      void waitHealthy(spec.healthUrl, {
        timeoutMs: spec.timeoutMs,
        intervalMs: spec.intervalMs,
        log: spec.log,
      })
        .then(async res => {
          await res.body?.cancel().catch(() => {})
          spec.log?.(`[${spec.kind}] became healthy (background)`)
        })
        .catch(err => {
          spec.log?.(
            `[${spec.kind}] background health-wait gave up: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        })
      return { baseUrl, pid: child?.pid, wasAlreadyRunning: false, healthy: false }
    }
  }

  // ── Blocking cold start (default) ───────────────────────────────────────────
  const res = await waitHealthy(spec.healthUrl, {
    timeoutMs: spec.timeoutMs,
    intervalMs: spec.intervalMs,
    log: spec.log,
  })
  await res.body?.cancel().catch(() => {})

  return { baseUrl, pid: child?.pid, wasAlreadyRunning: false, healthy: true }
}
