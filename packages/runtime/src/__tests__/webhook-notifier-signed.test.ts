/**
 * Opt-in webhook signing: a per-session `register(id, url, secret)` or a
 * global `{url, secret}` (notify.json / env) signs every POST with Standard
 * Webhooks headers (`webhook-id` / `webhook-timestamp` / `webhook-signature`
 * — see webhook-egress/signing.ts). A target with no secret is posted
 * exactly as before — unauthenticated, `Content-Type` only — so existing
 * callers see zero behavior change.
 */

import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createWebhookNotifier } from "../webhook-notifier.js"
import { decodeWhsecSecret, encodeWhsecSecret } from "../webhook-egress/signing.js"

function key(byte: number): Buffer {
  return Buffer.alloc(32, byte)
}

const SECRET_A = encodeWhsecSecret(key(0xaa))
const SECRET_B = encodeWhsecSecret(key(0xbb))

function verifySignature(
  headers: Record<string, string>,
  body: string,
  secret: string
): boolean {
  const key = decodeWhsecSecret(secret)
  if (!key) return false
  const msgId = headers["webhook-id"]
  const timestamp = headers["webhook-timestamp"]
  const expected = createHmac("sha256", key)
    .update(`${msgId}.${timestamp}.`, "utf8")
    .update(Buffer.from(body, "utf8"))
    .digest("base64")
  return (headers["webhook-signature"] ?? "")
    .split(" ")
    .some(seg => seg === `v1,${expected}`)
}

describe("webhook-notifier — opt-in signing", () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
    delete process.env.AGENTPROTO_NOTIFY_URL
    delete process.env.AGENTPROTO_NOTIFY_SECRET
  })

  function captureFetch(): {
    calls: Array<{ url: string; headers: Record<string, string>; body: string }>
  } {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    global.fetch = vi.fn(async (url, init) => {
      calls.push({
        url: String(url),
        headers: (init as { headers: Record<string, string> }).headers,
        body: String((init as { body: string }).body),
      })
      return { ok: true } as Response
    }) as unknown as typeof fetch
    return { calls }
  }

  it("a session registered WITHOUT a secret is posted unauthenticated — zero change", async () => {
    const { calls } = captureFetch()
    const notifier = createWebhookNotifier()
    notifier.register("sess_1", "http://example.invalid/hook")
    notifier.onSessionEvent({
      type: "session:exited",
      sessionId: "sess_1",
      ts: "t",
      exitCode: 0,
      status: "exited",
    })
    await new Promise(res => setTimeout(res, 0))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers).toEqual({ "Content-Type": "application/json" })
    expect(calls[0]!.headers["webhook-signature"]).toBeUndefined()
  })

  it("a session registered WITH a secret is signed, and the signature verifies against that secret", async () => {
    const { calls } = captureFetch()
    const notifier = createWebhookNotifier()
    notifier.register("sess_1", "http://example.invalid/hook", SECRET_A)
    notifier.onSessionEvent({
      type: "session:exited",
      sessionId: "sess_1",
      ts: "t",
      exitCode: 0,
      status: "exited",
    })
    await new Promise(res => setTimeout(res, 0))

    expect(calls).toHaveLength(1)
    const { headers, body } = calls[0]!
    expect(headers["webhook-id"]).toMatch(/^evt_/)
    expect(headers["webhook-timestamp"]).toMatch(/^\d+$/)
    expect(verifySignature(headers, body, SECRET_A)).toBe(true)
    // Wrong secret must NOT verify.
    expect(verifySignature(headers, body, SECRET_B)).toBe(false)
  })

  it("the global target's secret signs when there's no per-session secret", async () => {
    const { calls } = captureFetch()
    const notifier = createWebhookNotifier({
      globalUrl: "http://global.invalid/hook",
      globalSecret: SECRET_A,
    })
    notifier.onSessionEvent({
      type: "session:exited",
      sessionId: "sess_1",
      ts: "t",
      exitCode: 0,
      status: "exited",
    })
    await new Promise(res => setTimeout(res, 0))

    expect(calls).toHaveLength(1)
    expect(verifySignature(calls[0]!.headers, calls[0]!.body, SECRET_A)).toBe(true)
  })

  it("the per-session secret wins over the global one when both target the same URL", async () => {
    const { calls } = captureFetch()
    const notifier = createWebhookNotifier({
      globalUrl: "http://example.invalid/hook",
      globalSecret: SECRET_B,
    })
    notifier.register("sess_1", "http://example.invalid/hook", SECRET_A)
    notifier.onSessionEvent({
      type: "session:exited",
      sessionId: "sess_1",
      ts: "t",
      exitCode: 0,
      status: "exited",
    })
    await new Promise(res => setTimeout(res, 0))

    // Deduplicated to ONE post (same URL), signed with the session secret.
    expect(calls).toHaveLength(1)
    expect(verifySignature(calls[0]!.headers, calls[0]!.body, SECRET_A)).toBe(true)
    expect(verifySignature(calls[0]!.headers, calls[0]!.body, SECRET_B)).toBe(false)
  })

  it("AGENTPROTO_NOTIFY_SECRET signs the env-resolved global URL", async () => {
    const { calls } = captureFetch()
    process.env.AGENTPROTO_NOTIFY_URL = "http://env.invalid/hook"
    process.env.AGENTPROTO_NOTIFY_SECRET = SECRET_A
    const notifier = createWebhookNotifier()
    notifier.onSessionEvent({
      type: "session:exited",
      sessionId: "sess_1",
      ts: "t",
      exitCode: 0,
      status: "exited",
    })
    await new Promise(res => setTimeout(res, 0))

    expect(calls).toHaveLength(1)
    expect(verifySignature(calls[0]!.headers, calls[0]!.body, SECRET_A)).toBe(true)
  })

  it("two posts to two different signed targets get independent, both-valid signatures", async () => {
    const { calls } = captureFetch()
    const notifier = createWebhookNotifier({
      globalUrl: "http://global.invalid/hook",
      globalSecret: SECRET_B,
    })
    notifier.register("sess_1", "http://session.invalid/hook", SECRET_A)
    notifier.onSessionEvent({
      type: "session:exited",
      sessionId: "sess_1",
      ts: "t",
      exitCode: 0,
      status: "exited",
    })
    await new Promise(res => setTimeout(res, 0))

    expect(calls).toHaveLength(2)
    const sessionCall = calls.find(c => c.url === "http://session.invalid/hook")!
    const globalCall = calls.find(c => c.url === "http://global.invalid/hook")!
    expect(verifySignature(sessionCall.headers, sessionCall.body, SECRET_A)).toBe(true)
    expect(verifySignature(globalCall.headers, globalCall.body, SECRET_B)).toBe(true)
  })
})
