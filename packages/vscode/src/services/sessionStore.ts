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
 * focusOutput(id) opens the /sessions/:id/stream SSE for ONE session at a
 * time (connection budget — see recon §Gaps 3) and closes the previous.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import { subscribeSse } from "../client/sse.js"
import type {
  PendingPermission,
  SessionDescriptor,
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

export interface FocusOutputHandlers {
  onLine: (line: SessionStreamLine) => void
}

export class SessionStore {
  private readonly client: DaemonClient
  private readonly pollIntervalMs: number
  private readonly state = createStoreState()
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  private cursor = 0
  private consecutiveFailures = 0
  private pollLoop: Promise<void> | undefined
  private stopped = false
  private focusSub: { close(): void } | undefined

  constructor(client: DaemonClient, pollIntervalMs = 5000) {
    this.client = client
    this.pollIntervalMs = Math.max(1000, pollIntervalMs)
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

  /**
   * Start the live-update loop: an initial snapshot, then a resilient
   * session_events_poll loop with poll fallback.
   */
  start(): void {
    void this.boot()
  }

  private async boot(): Promise<void> {
    // Initial snapshot — always do this so the UI has data even if the
    // poll loop fails immediately.
    await this.refreshAll()
    this.pollLoop = this.runPollLoop()
  }

  /**
   * Full snapshot refresh — listSessions() + listPermissions(). Used as the
   * initial load and as the fallback when the poll loop is unhealthy.
   * Returns true if anything changed.
   */
  async refreshAll(): Promise<boolean> {
    let changed = false
    try {
      const sessions = await this.client.listSessions()
      if (applySessionsSnapshot(this.state, sessions)) changed = true
    } catch {
      // Daemon unreachable — leave existing state; the views keep showing
      // the last known sessions.
    }
    try {
      const perms = await this.client.listPermissions()
      if (applyPermissionsSnapshot(this.state, perms)) changed = true
    } catch {
      // permissions endpoint optional/failed — non-fatal.
    }
    if (changed) this._onDidChange.fire()
    return changed
  }

  /**
   * Resilient session_events_poll loop. Resumes via `since` cursor, backs
   * off exponentially on error, and falls back to the pollIntervalMs
   * listSessions()+listPermissions() poll whenever unhealthy.
   */
  private async runPollLoop(): Promise<void> {
    while (!this.stopped) {
      if (this.consecutiveFailures >= HEALTH_THRESHOLD) {
        // Unhealthy — fall back to the snapshot poll on the configured
        // interval until the daemon recovers.
        await this.refreshAll()
        // Reset backoff so the first healthy poll after recovery is prompt.
        let backoff = INITIAL_BACKOFF_MS
        while (!this.stopped && this.consecutiveFailures >= HEALTH_THRESHOLD) {
          await sleep(Math.min(backoff, this.pollIntervalMs))
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
          await this.refreshAll()
        }
        // Recovered (or stopped) — continue the normal poll loop.
        continue
      }

      try {
        const result = await this.client.sessionEventsPoll(this.cursor)
        let changed = false
        for (const ev of result.events) {
          if (applyLifecycleEvent(this.state, ev)) changed = true
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
      } catch {
        this.consecutiveFailures++
        // Backoff before the next attempt (the loop re-checks the health
        // threshold at the top).
        await sleep(Math.min(INITIAL_BACKOFF_MS * 2 ** this.consecutiveFailures, MAX_BACKOFF_MS))
      }
    }
  }

  /**
   * Open the /sessions/:id/stream SSE for ONE session at a time. Closes
   * any previously-focused session's stream first (connection budget —
   * recon §Gaps 3). Returns a Disposable that closes the stream.
   */
  focusOutput(id: string, handlers: FocusOutputHandlers): vscode.Disposable {
    this.focusSub?.close()
    const url = `${this.client.url}/sessions/${encodeURIComponent(id)}/stream`
    this.client.resolveToken().then(token => {
      if (this.stopped) return
      this.focusSub = subscribeSse(
        url,
        token ? { authorization: `Bearer ${token}` } : {},
        {
          onEvent: (data) => {
            const line = data as SessionStreamLine
            if (line && typeof (line as { line?: unknown }).line === "string") {
              handlers.onLine(line)
            }
          },
        },
      )
    })
    return new vscode.Disposable(() => {
      this.focusSub?.close()
      this.focusSub = undefined
    })
  }

  dispose(): void {
    this.stopped = true
    this.focusSub?.close()
    this.focusSub = undefined
    void this.pollLoop?.catch(() => {})
    this._onDidChange.dispose()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
