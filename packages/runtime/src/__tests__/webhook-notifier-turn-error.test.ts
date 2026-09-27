/**
 * `session:turn-end` previously reached a registered webhook stripped of
 * both `reason` and the new `error` text — a subscriber learned only that a
 * turn ended, never that it failed or why. Part of the same
 * indistinguishable-errored-turn gap as `agent_sessions_list`/
 * `monitorSessionWait` (see turn-error-notify.test.ts).
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { createWebhookNotifier } from "../webhook-notifier.js"

describe("webhook-notifier — turn-end reason/error forwarding", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("forwards `reason` and `error` for an in-band-failed turn", async () => {
    const calls: unknown[] = []
    global.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String((init as { body: string }).body)))
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const notifier = createWebhookNotifier()
    notifier.register("sess_1", "http://example.invalid/hook")
    notifier.onSessionEvent({
      type: "session:turn-end",
      sessionId: "sess_1",
      awaitingInput: false,
      ts: "t",
      reason: "error",
      error: "Internal error: API Error: 400 ...",
    })

    // Fire-and-forget — let the microtask queue settle.
    await new Promise(res => setTimeout(res, 0))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: "sess_1",
      event: "turn-end",
      reason: "error",
      error: "Internal error: API Error: 400 ...",
    })
  })

  it("omits `reason`/`error` for a productive turn-end", async () => {
    const calls: unknown[] = []
    global.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String((init as { body: string }).body)))
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const notifier = createWebhookNotifier()
    notifier.register("sess_2", "http://example.invalid/hook")
    notifier.onSessionEvent({
      type: "session:turn-end",
      sessionId: "sess_2",
      awaitingInput: false,
      ts: "t",
    })

    await new Promise(res => setTimeout(res, 0))

    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toHaveProperty("reason")
    expect(calls[0]).not.toHaveProperty("error")
  })
})
