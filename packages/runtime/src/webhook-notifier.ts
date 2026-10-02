/**
 * Fire-and-forget webhook notifier for session lifecycle events.
 *
 * Each session can register its own `notifyUrl` (via `agent_start`).
 * A global URL can be set via `AGENTPROTO_NOTIFY_URL` env var or
 * `~/.agentproto/notify.json` (env wins). Both are POSTed when an event
 * fires — the union of per-session + global URLs, deduplicated.
 *
 * Retry policy: one retry after 2 s on network error. No retry on 4xx/5xx.
 * Timeout: 10 s per attempt. All errors are swallowed — the notifier never
 * throws into the session's hot path.
 *
 * Of the daemon-scoped `cron:*` events, ONLY `cron:unhealthy` is relayed (to
 * the global URL — cron events carry no sessionId). `cron:fired` /
 * `cron:succeeded` / `cron:failed` stay filtered: relaying every fire would
 * spam whatever the operator's global URL feeds (e.g. a Telegram relay) on a
 * schedule that can be every 20 minutes.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SessionEvent, SessionAwaitingQuestion } from "./session-event-bus.js"

export interface WebhookNotifier {
  /** Register a per-session URL (called from agent_start). */
  register(sessionId: string, url: string): void
  unregister(sessionId: string): void
  /** Handler to wire into SessionEventBus.onAny. Fire-and-forget. */
  onSessionEvent(ev: SessionEvent): void
}

interface NotifyPayload {
  /** Present for `session:*` events; absent for daemon-scoped `cron:*` events. */
  sessionId?: string
  /** Present for `cron:*` events (no session to attribute them to). */
  jobId?: string
  label?: string
  event: string
  awaitingInput?: boolean
  ts: string
  exitCode?: number
  status?: string
  question?: SessionAwaitingQuestion
  /** `session:turn-end`'s `SessionTurnEndEvent.reason` (e.g. `"completed"`,
   *  `"error"`, `"aborted"`), when the daemon/adapter reported one. Absent
   *  for other event types and for a turn-end with no reason to report. Also
   *  carries `cron:unhealthy`'s pause reason. */
  reason?: string
  /** `session:turn-end`'s `SessionTurnEndEvent.error` — the captured
   *  in-band error text, when the turn ended with `reason: "error"` and the
   *  adapter emitted an `error` stream event. Without this a registered
   *  webhook learned only that a turn-end happened, not that it failed or
   *  why — the same blind spot `agent_sessions_list`/`monitorSessionWait`
   *  had before this field existed. */
  error?: string
  /** `cron:unhealthy`'s consecutive non-productive run count at pause time. */
  consecutiveFailures?: number
  /** `cron:unhealthy`'s real outcome of the run that tripped the threshold. */
  outcome?: string
}

export function createWebhookNotifier(opts?: {
  /** Pre-resolved global URL — overridden at call time by env var or file. */
  globalUrl?: string
}): WebhookNotifier {
  const perSession = new Map<string, string>()

  const resolveGlobalUrl = (): string | undefined => {
    if (process.env.AGENTPROTO_NOTIFY_URL) return process.env.AGENTPROTO_NOTIFY_URL
    try {
      const path = join(homedir(), ".agentproto", "notify.json")
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
      if (parsed && typeof parsed === "object" && "url" in parsed) {
        const { url } = parsed as { url: unknown }
        if (typeof url === "string" && url) return url
      }
    } catch {
      // file absent or malformed — not an error
    }
    return opts?.globalUrl
  }

  const post = async (url: string, payload: NotifyPayload): Promise<void> => {
    const body = JSON.stringify(payload)
    const headers = { "Content-Type": "application/json" }
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      })
      if (resp.ok) return
      // 4xx/5xx — no retry
    } catch {
      // Network error — one retry after 2 s
      await new Promise<void>(res => setTimeout(res, 2_000))
      try {
        await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        // Give up silently
      }
    }
  }

  return {
    register(sessionId, url) {
      perSession.set(sessionId, url)
    },
    unregister(sessionId) {
      perSession.delete(sessionId)
    },
    onSessionEvent(ev) {
      // The ONE daemon-scoped cron event worth waking an operator for: a job
      // that just auto-paused. It carries no sessionId, so only the GLOBAL
      // URL applies (not a per-session notifyUrl). Relaying it here — rather
      // than in a cron-specific channel — reuses the webhook an operator
      // already points at the daemon. cron:fired/succeeded/failed stay
      // filtered (see the module doc): relaying every fire would spam the
      // same URL on a schedule that can be every 20 minutes.
      if (ev.type === "cron:unhealthy") {
        const globalUrl = resolveGlobalUrl()
        if (!globalUrl) return
        void post(globalUrl, {
          event: ev.type,
          jobId: ev.jobId,
          label: ev.label,
          ts: ev.ts,
          consecutiveFailures: ev.consecutiveFailures,
          outcome: ev.lastOutcome,
          reason: ev.reason,
        })
        return
      }

      // Only fire on meaningful lifecycle events (not command-done, which
      // goes through the command-tools layer)
      if (
        ev.type !== "session:turn-end" &&
        ev.type !== "session:awaiting-input" &&
        ev.type !== "session:exited"
      ) {
        return
      }

      const targets = new Set<string>()
      const sessionUrl = perSession.get(ev.sessionId)
      if (sessionUrl) targets.add(sessionUrl)
      const globalUrl = resolveGlobalUrl()
      if (globalUrl) targets.add(globalUrl)
      if (targets.size === 0) return

      const payload: NotifyPayload = {
        sessionId: ev.sessionId,
        label: ev.label,
        event: ev.type.replace("session:", ""),
        awaitingInput:
          ev.type === "session:awaiting-input" ||
          (ev.type === "session:turn-end" && ev.awaitingInput),
        ts: ev.ts,
      }
      if (ev.type === "session:exited") {
        payload.exitCode = ev.exitCode
        payload.status = ev.status
      }
      if ((ev.type === "session:turn-end" || ev.type === "session:awaiting-input") && ev.question) {
        payload.question = ev.question
      }
      if (ev.type === "session:turn-end") {
        if (ev.reason !== undefined) payload.reason = ev.reason
        if (ev.error !== undefined) payload.error = ev.error
      }

      for (const url of targets) {
        void post(url, payload)
      }
    },
  }
}
