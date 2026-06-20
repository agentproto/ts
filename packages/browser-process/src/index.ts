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
}

export interface BrowserProcessResult {
  baseUrl: string
  wasAlreadyRunning: boolean
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
    return { baseUrl, wasAlreadyRunning: true }
  }

  const child = spec.launch()

  const res = await waitHealthy(spec.healthUrl, {
    timeoutMs: spec.timeoutMs,
    intervalMs: spec.intervalMs,
    log: spec.log,
  })
  await res.body?.cancel().catch(() => {})

  return { baseUrl, pid: child?.pid, wasAlreadyRunning: false }
}
