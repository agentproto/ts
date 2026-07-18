/**
 * SessionStore — the extension's live in-memory model of the daemon.
 *
 * /events REALITY (recon §SSE is inaccurate vs. the source): the global
 * GET /events SSE stream carries ONLY runtime events (boot, heartbeat-*,
 * conv-turn-appended, remote-log) — NOT session:* lifecycle events. Those
 * live on a separate SessionEventBus, surfaced via the session_events_poll
 * MCP tool (POST /mcp tools/call). So this store drives live updates
 * through a resilient session_events_poll loop, with a listSessions() +
 * listPermissions() poll fallback whenever that loop is unhealthy.
 *
 * Resilience contract (per user constraint):
 *  - resume via the `since` cursor returned by each poll;
 *  - exponential backoff on error (capped);
 *  - fall back to the pollIntervalMs listSessions()+listPermissions() poll
 *    whenever the loop is unhealthy (3 consecutive failures).
 *
 * focusOutput(id) returns a Disposable that opens the /sessions/:id/stream
 * SSE for that call only. Each subscription is independent; disposing one
 * never closes another, so multiple transcript panels can stay live.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import { subscribeSse } from "../client/sse.js"
import { makePendingSession, type PendingSessionDraft } from "./pending.logic.js"
import type {
  PendingPermission,
  SessionDescriptor,
  SessionLifecycleEvent,
  SessionStreamLine,
} from "../client/types.js"
import {
  applyLifecycleEvent,
  applyPermissionsSnapshot,
  applySessionsSnapshot,
  createStoreState,
  snapshot,
} from "./sessionStore.logic.js"

const HEALTH_THRESHOLD = 3
const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const IDLE_BACKOFF_MS = 250
const MAX_IDLE_BACKOFF_MS = 2_000
const SESSION_REFRESH_DEBOUNCE_MS = 150
const SESSION_REFRESH_RETRY_MAX_MS = 5_000

const SESSION_DESCRIPTOR_EVENT_TYPES = new Set([
  "session:turn-end",
  "session:awaiting-input",
  "session:exited",
  "session:command-done",
])

export interface FocusOutputHandlers {
  onLine: (line: SessionStreamLine) => void
}

/** A timer primitive that exposes a per-sleep cancellation handle. */
export interface Scheduler {
  sleep(ms: number): CancellableSleep
}

export interface CancellableSleep {
  readonly promise: Promise<void>
  cancel(): void
}

const defaultScheduler: Scheduler = {
  sleep(ms) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let resolveFn: (() => void) | undefined
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve
      timeout = setTimeout(() => {
        timeout = undefined
        resolve()
      }, ms)
    })
    return {
      promise,
      cancel() {
        if (timeout) {
          clearTimeout(timeout)
          timeout = undefined
        }
        resolveFn?.()
        resolveFn = undefined
      },
    }
  },
}

export class SessionStore {
  private readonly client: DaemonClient
  private readonly pollIntervalMs: number
  private readonly state = createStoreState()
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  private readonly scheduler: Scheduler
  private currentSleep: CancellableSleep | undefined
  private readonly focusSubs = new Set<{
    cancelled: boolean
    close(): void
    sse?: { close(): void }
  }>()

  private cursor = 0
  private consecutiveFailures = 0
  private pollLoop: Promise<void> | undefined
  private stopped = false
  private idleBackoff = IDLE_BACKOFF_MS

  private refreshTimeout: ReturnType<typeof setTimeout> | undefined
  private refreshRetryMs = SESSION_REFRESH_DEBOUNCE_MS
  private needsSessionRefresh = false

  private msSinceSnapshot = 0
  private pendingSeq = 0

  /** Off by default — archived sessions are hidden from every fetch this
   *  store makes until a caller opts in (the "show archived" tree toggle,
   *  `agentproto.toggleShowArchived`). Flipping it re-fetches immediately
   *  rather than waiting for the next poll tick, so the toggle reads as
   *  instant. */
  private _showArchived = false

  constructor(
    client: DaemonClient,
    pollIntervalMs = 5000,
    scheduler: Scheduler = defaultScheduler,
  ) {
    this.client = client
    this.pollIntervalMs = Math.max(1000, pollIntervalMs)
    this.scheduler = scheduler
  }

  get sessions(): SessionDescriptor[] {
    return snapshot(this.state).sessions
  }

  get permissions(): PendingPermission[] {
    return snapshot(this.state).permissions
  }

  /** True when the session_events_poll loop is healthy. */
  get healthy(): boolean {
    return this.consecutiveFailures < HEALTH_THRESHOLD
  }

  get showArchived(): boolean {
    return this._showArchived
  }

  /** Flip the archived-visibility toggle and re-fetch immediately. A no-op
   *  (no redundant fetch) when the value doesn't actually change. */
  setShowArchived(value: boolean): void {
    if (this._showArchived === value) return
    this._showArchived = value
    void this.refreshAll()
  }

  /**
   * Start the live-update loop: an initial snapshot, then a resilient
   * session_events_poll loop with poll fallback.
   */
  start(): void {
    this.pollLoop = this.boot().then(() => this.runPollLoop())
  }

  private async boot(): Promise<void> {
    // Initial snapshot — always do this so the UI has data even if the
    // poll loop fails immediately.
    await this.refreshAll()
  }

  /**
   * Show a row for a spawn that's been asked for but not yet acknowledged, and
   * return its temp id for `resolvePending`.
   *
   * The wizard already refreshes the store the instant spawnAgent() returns —
   * the wait people see is that call itself, which blocks while the daemon
   * boots an adapter and completes an ACP handshake. Nothing can make that
   * faster from here; this makes it VISIBLE, which is the actual complaint.
   */
  addPending(draft: PendingSessionDraft): string {
    const row = makePendingSession(draft, ++this.pendingSeq, new Date().toISOString())
    this.state.pending.set(row.id, row)
    this._onDidChange.fire()
    return row.id
  }

  /**
   * Drop an optimistic row — the spawn either landed (the real descriptor is in
   * the snapshot by now) or failed. Safe to call twice.
   */
  resolvePending(pendingId: string): void {
    if (this.state.pending.delete(pendingId)) this._onDidChange.fire()
  }

  /**
   * Full snapshot refresh — listSessions() + listPermissions(). Used as the
   * initial load and as the fallback when the poll loop is unhealthy.
   * Returns true if anything changed.
   */
  async refreshAll(): Promise<boolean> {
    const { changed } = await this.refreshCore()
    return changed
  }

  private async refreshCore(): Promise<{ changed: boolean; reachable: boolean }> {
    let changed = false
    let reachable = false
    try {
      const sessions = await this.client.listSessions({ includeArchived: this._showArchived })
      reachable = true
      if (this.stopped) return { changed, reachable }
      if (applySessionsSnapshot(this.state, sessions)) changed = true
    } catch {
      // Daemon unreachable — leave existing state; the views keep showing
      // the last known sessions.
    }
    try {
      const perms = await this.client.listPermissions()
      if (this.stopped) return { changed, reachable }
      if (applyPermissionsSnapshot(this.state, perms)) changed = true
    } catch {
      // permissions endpoint optional/failed — non-fatal.
    }
    if (changed) this._onDidChange.fire()
    return { changed, reachable }
  }

  /**
   * Resilient session_events_poll loop. Resumes via `since` cursor, backs
   * off exponentially on error, and falls back to the pollIntervalMs
   * listSessions()+listPermissions() poll whenever unhealthy.
   *
   * Every poll iteration is followed by a bounded throttle delay. This keeps
   * the loop from hot-spinning when the daemon answers quickly (e.g. mocks or
   * bursts of events) while remaining responsive: the delay is reset to the
   * minimum whenever events arrive.
   */
  private async runPollLoop(): Promise<void> {
    while (!this.stopped) {
      if (this.consecutiveFailures >= HEALTH_THRESHOLD) {
        // Unhealthy — fall back to the snapshot poll on the configured
        // interval until the daemon recovers. A successful refresh resets
        // the failure count so the normal poll loop can resume.
        let backoff = INITIAL_BACKOFF_MS
        while (!this.stopped && this.consecutiveFailures >= HEALTH_THRESHOLD) {
          const { changed, reachable } = await this.refreshCore()
          if (changed || reachable) {
            this.consecutiveFailures = 0
            this.idleBackoff = IDLE_BACKOFF_MS
            break
          }
          if (this.stopped) return
          await this.sleep(Math.min(backoff, this.pollIntervalMs))
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        }
        // Recovered (or stopped) — continue the normal poll loop.
        continue
      }

      try {
        const result = await this.client.sessionEventsPoll(this.cursor)
        let changed = false
        let needsSessionRefresh = false
        for (const ev of result.events) {
          if (applyLifecycleEvent(this.state, ev)) changed = true
          if (isSessionDescriptorEvent(ev)) needsSessionRefresh = true
        }
        // Permission events invalidate the local inbox optimistically, but
        // we still re-fetch to reconcile the full enriched rows.
        const hadPermissionEvent = result.events.some(
          ev => ev.type === "session:permission-request" || ev.type === "session:permission-resolved",
        )
        if (hadPermissionEvent) {
          try {
            const perms = await this.client.listPermissions()
            if (applyPermissionsSnapshot(this.state, perms)) changed = true
          } catch {
            // non-fatal — optimistic local mutation already applied
          }
        }
        // Advance the cursor — never regress.
        if (result.nextCursor > this.cursor) {
          this.cursor = result.nextCursor
        }
        this.consecutiveFailures = 0
        if (changed) this._onDidChange.fire()
        if (needsSessionRefresh) this.scheduleSessionRefresh()

        // Bounded throttle before the next poll.
        const delay = Math.min(this.idleBackoff, this.pollIntervalMs)
        await this.sleep(delay)
        if (this.stopped) return
        // A snapshot on a clock, independent of any event.
        //
        // The daemon announces turn-end/awaiting-input/exited/command-done and
        // nothing else — there is no "session started". So a session spawned
        // anywhere but here is, to this store, a thing that has never happened:
        // the descriptor refresh above only ever runs off one of those four
        // events, and a freshly-started session has emitted none of them. On a
        // busy daemon some OTHER session's turn-end would refresh the whole
        // list and the newcomer would appear as a side effect; on a quiet one,
        // nothing ever fired and the tree stayed empty until a human clicked
        // Refresh. Which is what people did, and reported as "the sidebar
        // doesn't update".
        //
        // Paced by the loop's own sleep rather than a wall clock so the cadence
        // stays deterministic under a fake scheduler in tests.
        this.msSinceSnapshot += delay
        if (this.msSinceSnapshot >= this.pollIntervalMs) {
          this.msSinceSnapshot = 0
          this.scheduleSessionRefresh()
        }
        if (result.events.length === 0) {
          this.idleBackoff = Math.min(this.idleBackoff * 2, MAX_IDLE_BACKOFF_MS)
        } else {
          this.idleBackoff = IDLE_BACKOFF_MS
        }
      } catch {
        this.consecutiveFailures++
        if (this.consecutiveFailures >= HEALTH_THRESHOLD) {
          // Enter the fallback path immediately on the next loop iteration.
          continue
        }
        // Backoff before the next attempt.
        await this.sleep(
          Math.min(INITIAL_BACKOFF_MS * 2 ** this.consecutiveFailures, MAX_BACKOFF_MS),
        )
      }
    }
  }

  /**
   * Schedule a debounced refresh of authoritative session descriptors.
   * Coalesces multiple lifecycle events that fire in quick succession into
   * a single listSessions() call so cost/tokens/status do not stay stale.
   */
  private scheduleSessionRefresh(): void {
    if (this.stopped) return
    this.needsSessionRefresh = true
    if (this.refreshTimeout) return
    this.refreshRetryMs = SESSION_REFRESH_DEBOUNCE_MS
    this.refreshTimeout = setTimeout(() => {
      this.refreshTimeout = undefined
      void this.runSessionRefresh()
    }, SESSION_REFRESH_DEBOUNCE_MS)
  }

  /**
   * Retry a failed descriptor refresh with bounded exponential backoff.
   * Keeps the invalidation flag set so the next successful poll or retry
   * reconciles the descriptor.
   */
  private scheduleSessionRefreshRetry(): void {
    if (this.stopped) return
    this.needsSessionRefresh = true
    if (this.refreshTimeout) return
    const delay = Math.min(this.refreshRetryMs, SESSION_REFRESH_RETRY_MAX_MS)
    this.refreshRetryMs = Math.min(this.refreshRetryMs * 2, SESSION_REFRESH_RETRY_MAX_MS)
    this.refreshTimeout = setTimeout(() => {
      this.refreshTimeout = undefined
      void this.runSessionRefresh()
    }, delay)
  }

  private async runSessionRefresh(): Promise<void> {
    if (this.stopped || !this.needsSessionRefresh) return
    this.needsSessionRefresh = false
    try {
      const sessions = await this.client.listSessions({ includeArchived: this._showArchived })
      if (this.stopped) return
      this.refreshRetryMs = SESSION_REFRESH_DEBOUNCE_MS
      if (applySessionsSnapshot(this.state, sessions)) this._onDidChange.fire()
    } catch {
      if (this.stopped) return
      // Keep the invalidation alive and retry later rather than going silent.
      this.scheduleSessionRefreshRetry()
    }
  }

  /**
   * Open the /sessions/:id/stream SSE for the requested session. Returns a
   * Disposable that closes ONLY the stream created by this call. Multiple
   * active subscriptions are allowed so independent transcript panels stay
   * live.
   */
  focusOutput(id: string, handlers: FocusOutputHandlers): vscode.Disposable {
    const sub: {
      cancelled: boolean
      close(): void
      sse?: { close(): void }
    } = {
      cancelled: false,
      close() {
        this.sse?.close()
      },
    }
    this.focusSubs.add(sub)
    const url = `${this.client.url}/sessions/${encodeURIComponent(id)}/stream`
    this.client.resolveToken().then(token => {
      if (this.stopped || sub.cancelled) return
      sub.sse = subscribeSse(
        url,
        token ? { authorization: `Bearer ${token}` } : {},
        {
          onEvent: (data) => {
            if (sub.cancelled) return
            const line = data as SessionStreamLine
            if (line && typeof (line as { line?: unknown }).line === "string") {
              handlers.onLine(line)
            }
          },
        },
      )
    })
    return new vscode.Disposable(() => {
      sub.cancelled = true
      sub.close()
      this.focusSubs.delete(sub)
    })
  }

  dispose(): void {
    this.stopped = true
    this.currentSleep?.cancel()
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout)
      this.refreshTimeout = undefined
    }
    for (const sub of [...this.focusSubs]) {
      sub.cancelled = true
      sub.close()
    }
    this.focusSubs.clear()
    void this.pollLoop?.catch(() => {})
    this._onDidChange.dispose()
  }

  private async sleep(ms: number): Promise<void> {
    const handle = this.scheduler.sleep(ms)
    this.currentSleep = handle
    try {
      await handle.promise
    } finally {
      this.currentSleep = undefined
    }
  }
}

function isSessionDescriptorEvent(ev: SessionLifecycleEvent): boolean {
  return SESSION_DESCRIPTOR_EVENT_TYPES.has(ev.type)
}
