/**
 * AIP-53 link-token scoping — the pure HMAC mint/verify primitives
 * (app-link-token.ts). Each test uses its own tmp `keyPath` so the
 * per-process key cache can't leak a key between tests.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  mintAppLinkToken,
  verifyAppLinkToken,
  mintAppLinkSessionToken,
  verifyAppLinkSessionToken,
  appLinkTokenSignature,
  extractAppLinkBearer,
} from "../app-link-token.js"

function tmpKeyPath(): string {
  return join(mkdtempSync(join(tmpdir(), "app-link-token-test-")), "key")
}

describe("mintAppLinkToken / verifyAppLinkToken", () => {
  it("round-trips a freshly minted token", () => {
    const keyPath = tmpKeyPath()
    const { token, exp } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "123" },
      ttlMs: 60_000,
      pendingTelegramAuth: true,
      keyPath,
    })
    const result = verifyAppLinkToken(token, keyPath)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.payload.appId).toBe("@agentik/session-chat")
    expect(result.payload.claims).toEqual({ sessionId: "sess_abc", telegramUserId: "123" })
    expect(result.payload.pendingTelegramAuth).toBe(true)
    expect(result.payload.exp).toBe(exp)
  })

  it("a tampered payload fails signature verification", () => {
    const keyPath = tmpKeyPath()
    const { token } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "123" },
      ttlMs: 60_000,
      keyPath,
    })
    const [payloadB64, sig] = token.split(".")
    const tamperedPayload = Buffer.from(
      JSON.stringify({ v: 1, kind: "link", appId: "@agentik/session-chat", claims: { sessionId: "sess_OTHER", telegramUserId: "123" }, exp: 9_999_999_999 }),
    ).toString("base64url")
    const tampered = `${tamperedPayload}.${sig}`
    const result = verifyAppLinkToken(tampered, keyPath)
    expect(result.ok).toBe(false)
    expect(payloadB64).not.toBe(tamperedPayload)
  })

  it("a token signed with a DIFFERENT key fails verification", () => {
    const keyPathA = tmpKeyPath()
    const keyPathB = tmpKeyPath()
    const { token } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "123" },
      ttlMs: 60_000,
      keyPath: keyPathA,
    })
    const result = verifyAppLinkToken(token, keyPathB)
    expect(result.ok).toBe(false)
  })

  it("an expired token is refused", () => {
    const keyPath = tmpKeyPath()
    vi.useFakeTimers()
    try {
      const { token } = mintAppLinkToken({
        appId: "@agentik/session-chat",
        claims: { sessionId: "sess_abc", telegramUserId: "123" },
        ttlMs: 1_000,
        keyPath,
      })
      vi.advanceTimersByTime(1_001)
      const result = verifyAppLinkToken(token, keyPath)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/expired/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a session token is refused by verifyAppLinkToken and vice versa — kinds don't cross", () => {
    const keyPath = tmpKeyPath()
    const link = mintAppLinkToken({ appId: "x", claims: { sessionId: "s" }, ttlMs: 60_000, keyPath })
    const session = mintAppLinkSessionToken({ appId: "x", claims: { sessionId: "s" }, ttlMs: 60_000, keyPath })
    expect(verifyAppLinkSessionToken(link.token, keyPath).ok).toBe(false)
    expect(verifyAppLinkToken(session.token, keyPath).ok).toBe(false)
    expect(verifyAppLinkToken(link.token, keyPath).ok).toBe(true)
    expect(verifyAppLinkSessionToken(session.token, keyPath).ok).toBe(true)
  })

  it("malformed tokens (no dot, garbage) are refused without throwing", () => {
    const keyPath = tmpKeyPath()
    expect(verifyAppLinkToken("not-a-token", keyPath).ok).toBe(false)
    expect(verifyAppLinkToken("abc.def", keyPath).ok).toBe(false)
  })
})

describe("appLinkTokenSignature / extractAppLinkBearer", () => {
  it("signature is the part after the dot", () => {
    const keyPath = tmpKeyPath()
    const { token } = mintAppLinkToken({ appId: "x", claims: { sessionId: "s" }, ttlMs: 60_000, keyPath })
    expect(appLinkTokenSignature(token)).toBe(token.split(".")[1])
  })

  it("extracts a bearer header over a query token", () => {
    const req = { headers: { authorization: "Bearer HEADER_TOKEN" }, url: "/x?token=QUERY_TOKEN" }
    expect(extractAppLinkBearer(req)).toBe("HEADER_TOKEN")
  })

  it("falls back to ?token= when there is no Authorization header", () => {
    const req = { headers: {}, url: "/x?token=QUERY_TOKEN" }
    expect(extractAppLinkBearer(req)).toBe("QUERY_TOKEN")
  })

  it("returns undefined when neither is present", () => {
    expect(extractAppLinkBearer({ headers: {}, url: "/x" })).toBeUndefined()
  })
})
