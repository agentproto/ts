/**
 * Daemon-scoped `cron:*` events (including `cron:unhealthy`) must reach the
 * SAME global notify URL session events use — no separate notification
 * channel. Cron events carry no sessionId, so only the global URL applies.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { createWebhookNotifier } from "../webhook-notifier.js"

describe("webhook-notifier — cron event relay", () => {
  const originalFetch = global.fetch
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.AGENTPROTO_NOTIFY_URL
    delete process.env.AGENTPROTO_NOTIFY_URL
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalEnv === undefined) delete process.env.AGENTPROTO_NOTIFY_URL
    else process.env.AGENTPROTO_NOTIFY_URL = originalEnv
  })

  function capture() {
    const calls: unknown[] = []
    global.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String((init as { body: string }).body)))
      return { ok: true } as Response
    }) as unknown as typeof fetch
    return calls
  }

  it("relays cron:unhealthy to the global URL with the health detail", async () => {
    const calls = capture()
    const notifier = createWebhookNotifier({ globalUrl: "http://example.invalid/hook" })

    notifier.onSessionEvent({
      type: "cron:unhealthy",
      jobId: "cron_1",
      label: "nightly",
      consecutiveFailures: 2,
      lastOutcome: "errored",
      reason: "auto-paused after 2 consecutive non-productive runs (last outcome: errored)",
      ts: "t",
    })
    await new Promise(res => setTimeout(res, 0))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      event: "cron:unhealthy",
      jobId: "cron_1",
      label: "nightly",
      consecutiveFailures: 2,
      outcome: "errored",
      reason: "auto-paused after 2 consecutive non-productive runs (last outcome: errored)",
    })
    expect(calls[0]).not.toHaveProperty("sessionId")
  })

  it("relays cron:succeeded and cron:failed too", async () => {
    const calls = capture()
    const notifier = createWebhookNotifier({ globalUrl: "http://example.invalid/hook" })

    notifier.onSessionEvent({
      type: "cron:succeeded",
      jobId: "cron_1",
      summary: "ok",
      ts: "t",
    })
    notifier.onSessionEvent({
      type: "cron:failed",
      jobId: "cron_1",
      error: "boom",
      ts: "t",
    })
    await new Promise(res => setTimeout(res, 0))

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ event: "cron:succeeded", jobId: "cron_1", summary: "ok" })
    expect(calls[1]).toMatchObject({ event: "cron:failed", jobId: "cron_1", error: "boom" })
  })

  it("still relays session events to a per-session URL", async () => {
    const calls = capture()
    const notifier = createWebhookNotifier()
    notifier.register("sess_1", "http://example.invalid/hook")

    notifier.onSessionEvent({
      type: "session:turn-end",
      sessionId: "sess_1",
      awaitingInput: false,
      ts: "t",
    })
    await new Promise(res => setTimeout(res, 0))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ event: "turn-end", sessionId: "sess_1" })
  })
})
