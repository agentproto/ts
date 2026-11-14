/**
 * View redaction (plan §4 W-B task 4 — code-verified leak closed): a raw
 * secret (or its secretRef handle) never crosses a listing/get view —
 * `sentinelView` is the single wire shape both MCP tools and the REST twin
 * print, so redacting there covers both surfaces.
 */

import { describe, expect, it } from "vitest"

import { createSentinelStore } from "../sentinel-store.js"
import { sentinelView } from "../sentinel-tools.js"
import { singleMatch, type SentinelSpec } from "../sentinel-providers/types.js"

const whsecSecret = "whsec_" + Buffer.from(new Uint8Array(32).fill(3)).toString("base64")

const webhookSpec: SentinelSpec = {
  match: singleMatch("github:agentproto/ts#42"),
  until: { kind: "never" },
  target: { kind: "webhook", url: "https://example.com/hook", secret: whsecSecret },
}

describe("sentinelView — webhook-target redaction", () => {
  it("mcp sentinel_list: the raw secret never appears in a listing view", () => {
    const store = createSentinelStore({ persist: false })
    const sentinel = store.create({ provider: "fake", handle: { provider: "fake" }, spec: webhookSpec })

    const listing = JSON.stringify(store.list().map(sentinelView))
    expect(listing).not.toContain(whsecSecret)

    const view = sentinelView(sentinel)
    expect(view.target).toEqual({
      kind: "webhook",
      url: "https://example.com/hook",
      hasSecret: true,
      secretRedacted: true,
    })
    expect(JSON.stringify(view)).not.toContain(whsecSecret)
  })

  it("REST GET /sentinels/:id shape: a single get view is redacted the same way", () => {
    const store = createSentinelStore({ persist: false })
    const sentinel = store.create({ provider: "fake", handle: { provider: "fake" }, spec: webhookSpec })

    // The REST twin serializes exactly `sentinelView(sentinel)` — same call.
    const body = JSON.stringify(sentinelView(store.get(sentinel.id)!))
    expect(body).toContain('"hasSecret":true')
    expect(body).toContain('"secretRedacted":true')
    expect(body).not.toContain(whsecSecret)
    expect(body).not.toMatch(/secretRef/)
  })

  it("session-target views keep their exact shape (no regression)", () => {
    const store = createSentinelStore({ persist: false })
    const sentinel = store.create({
      provider: "fake",
      handle: { provider: "fake" },
      spec: { ...webhookSpec, target: { kind: "session", sessionId: "sess_1", urgency: "next-turn" } },
    })
    expect(sentinelView(sentinel).target).toEqual({
      kind: "session",
      sessionId: "sess_1",
      urgency: "next-turn",
    })
  })
})
