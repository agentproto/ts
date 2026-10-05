/**
 * Fire-and-forget webhook notifier for session lifecycle events.
 *
 * Each session can register its own `notifyUrl` (via `agent_start`), with an
 * optional `notifySecret` (`whsec_...`). A global URL can be set via
 * `AGENTPROTO_NOTIFY_URL` env var (+ optional `AGENTPROTO_NOTIFY_SECRET`) or
 * `~/.agentproto/notify.json` `{url, secret?}` (env wins). Both are POSTed
 * when an event fires — the union of per-session + global URLs, deduplicated
 * by URL (a URL registered both ways is posted once; the per-session secret
 * wins over the global one on conflict).
 *
 * Signing (opt-in, backward compatible): when a target has a secret, the
 * POST carries Standard Webhooks headers (`webhook-id` / `webhook-timestamp`
 * / `webhook-signature`, see `webhook-egress/signing.ts`) — HMAC-SHA256 over
 * `id.timestamp.body`, the same contract sentinel/MCP Events already use for
 * egress. A target with no secret is posted exactly as before: unauthenticated,
 * `Content-Type` only. Existing callers that never set `notifySecret` or a
 * `secret` in notify.json see zero behavior change.
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

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SessionEvent, SessionAwaitingQuestion } from "./session-event-bus.js"
import { decodeWhsecSecret, signWebhook } from "./webhook-egress/signing.js"

export interface WebhookNotifier {
  /** Register a per-session URL (called from agent_start), with an optional
   *  `whsec_...` secret to sign its deliveries. */
  register(sessionId: string, url: string, secret?: string): void
  unregister(sessionId: string): void
  /** Handler to wire into SessionEventBus.onAny. Fire-and-forget. */
  onSessionEvent(ev: SessionEvent): void
}

interface Target {
  url: string
  secret?: string
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
  /** Pre-resolved global secret — overridden by `AGENTPROTO_NOTIFY_SECRET` or file. */
  globalSecret?: string
}): WebhookNotifier {
  const perSession = new Map<string, Target>()

  // Global secrets are operator-supplied and not validated upstream. An
  // invalid one must NOT fall back to an unsigned post (the receiver expects
  // signatures) and must not throw: skip the target and warn.
  const buildGlobalTarget = (url: string, secret: string | undefined): Target | undefined => {
    if (!secret) return { url }
    if (decodeWhsecSecret(secret) === null) {
      console.warn(
        `[webhook-notifier] global notify secret is not a valid whsec_ secret — skipping global webhook ${url}`
      )
      return undefined
    }
    return { url, secret }
  }

  const resolveGlobalTarget = (): Target | undefined => {
    if (process.env.AGENTPROTO_NOTIFY_URL) {
      return buildGlobalTarget(
        process.env.AGENTPROTO_NOTIFY_URL,
        process.env.AGENTPROTO_NOTIFY_SECRET || undefined
      )
    }
    let fileUrl: string | undefined
    let fileSecret: string | undefined
    try {
      const path = join(homedir(), ".agentproto", "notify.json")
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
      if (parsed && typeof parsed === "object" && "url" in parsed) {
        const { url, secret } = parsed as { url: unknown; secret?: unknown }
        if (typeof url === "string" && url) {
          fileUrl = url
          fileSecret = typeof secret === "string" && secret ? secret : undefined
        }
      }
    } catch {
      // file absent or malformed — not an error
    }
    if (fileUrl) return buildGlobalTarget(fileUrl, fileSecret)
    return opts?.globalUrl ? buildGlobalTarget(opts.globalUrl, opts.globalSecret || undefined) : undefined
  }

  const post = async (target: Target, payload: NotifyPayload): Promise<void> => {
    // `body` stays the plain string fetch always sent — only the signature
    // (when there's a secret) is computed over its exact UTF-8 bytes, so
    // existing unauthenticated receivers (and tests reading `init.body` as a
    // JSON string) see zero change.
    const body = JSON.stringify(payload)
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (target.secret) {
      try {
        Object.assign(
          headers,
          signWebhook({
            msgId: `evt_${randomUUID()}`,
            timestamp: Math.floor(Date.now() / 1000),
            payload: new TextEncoder().encode(body),
            secrets: [target.secret],
          })
        )
      } catch {
        // Invalid secret — never fall back to an unsigned post, never throw.
        return
      }
    }
    try {
      const resp = await fetch(target.url, {
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
        await fetch(target.url, {
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
    register(sessionId, url, secret) {
      perSession.set(sessionId, { url, ...(secret ? { secret } : {}) })
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
        const globalTarget = resolveGlobalTarget()
        if (!globalTarget) return
        void post(globalTarget, {
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

      // Deduplicated by URL; the per-session secret wins over the global
      // one when the same URL is registered both ways.
      const targets = new Map<string, Target>()
      const globalTarget = resolveGlobalTarget()
      if (globalTarget) targets.set(globalTarget.url, globalTarget)
      const sessionTarget = perSession.get(ev.sessionId)
      if (sessionTarget) targets.set(sessionTarget.url, sessionTarget)
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

      for (const target of targets.values()) {
        void post(target, payload)
      }
    },
  }
}
