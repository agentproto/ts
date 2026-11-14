/**
 * The Telegram-identity-bound exchange (app-link-auth.ts): a `"link"`
 * token minted by `app_link_mint` is useless on its own — only a matching
 * Telegram `initData` turns it into a usable `"session"` token. Exercises
 * every outcome Jeremy's amendment calls for: match, wrong-bot-token,
 * user-mismatch, stale initData, non-Telegram-gated token, and reuse of
 * the same link token (allowed until its own exp, each time with fresh
 * initData).
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { authorizeAppLink } from "../app-link-auth.js"
import { mintAppLinkToken, verifyAppLinkSessionToken } from "../app-link-token.js"
import type { TelegramBotCredsStore } from "../telegram-bot-creds.js"
import { FAKE_BOT_TOKEN, signInitData, buildInitDataFields } from "./helpers/telegram-init-data-fixture.js"

function tmpKeyPath(): string {
  return join(mkdtempSync(join(tmpdir(), "app-link-auth-test-")), "key")
}

function fakeTelegramCreds(tokensByAlias: Record<string, string>): TelegramBotCredsStore {
  return {
    read: async alias => (tokensByAlias[alias] ? { token: tokensByAlias[alias] } : null),
    write: async () => {},
    exists: async alias => alias in tokensByAlias,
  }
}

describe("authorizeAppLink", () => {
  it("a matching Telegram account exchanges the link for a usable session token", async () => {
    const keyPath = tmpKeyPath()
    const { token: linkToken } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "42" },
      ttlMs: 60_000,
      pendingTelegramAuth: true,
      keyPath,
    })
    const initData = signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN)
    const result = await authorizeAppLink({
      linkToken,
      initData,
      telegramCreds: fakeTelegramCreds({ default: FAKE_BOT_TOKEN }),
      keyPath,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.appId).toBe("@agentik/session-chat")
    expect(result.sessionId).toBe("sess_abc")
    expect(result.telegramUserId).toBe("42")
    const verified = verifyAppLinkSessionToken(result.sessionToken, keyPath)
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.payload.claims.sessionId).toBe("sess_abc")
      expect(verified.payload.claims.telegramUserId).toBe("42")
    }
  })

  it("initData signed by a DIFFERENT bot token is refused", async () => {
    const keyPath = tmpKeyPath()
    const { token: linkToken } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "42" },
      ttlMs: 60_000,
      pendingTelegramAuth: true,
      keyPath,
    })
    const initData = signInitData(buildInitDataFields({ userId: 42 }), "some-other-bot-token")
    const result = await authorizeAppLink({
      linkToken,
      initData,
      telegramCreds: fakeTelegramCreds({ default: FAKE_BOT_TOKEN }),
      keyPath,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it("a DIFFERENT Telegram user than the link's claim is refused (403)", async () => {
    const keyPath = tmpKeyPath()
    const { token: linkToken } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "42" },
      ttlMs: 60_000,
      pendingTelegramAuth: true,
      keyPath,
    })
    const initData = signInitData(buildInitDataFields({ userId: 999 }), FAKE_BOT_TOKEN)
    const result = await authorizeAppLink({
      linkToken,
      initData,
      telegramCreds: fakeTelegramCreds({ default: FAKE_BOT_TOKEN }),
      keyPath,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("stale initData (auth_date beyond the 300s window) is refused", async () => {
    const keyPath = tmpKeyPath()
    const { token: linkToken } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "42" },
      ttlMs: 60_000,
      pendingTelegramAuth: true,
      keyPath,
    })
    const initData = signInitData(
      buildInitDataFields({ userId: 42, authDate: Math.floor(Date.now() / 1000) - 3600 }),
      FAKE_BOT_TOKEN,
    )
    const result = await authorizeAppLink({
      linkToken,
      initData,
      telegramCreds: fakeTelegramCreds({ default: FAKE_BOT_TOKEN }),
      keyPath,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it("a link token that isn't Telegram-gated is refused (400)", async () => {
    const keyPath = tmpKeyPath()
    const { token: linkToken } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc" },
      ttlMs: 60_000,
      keyPath,
    })
    const initData = signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN)
    const result = await authorizeAppLink({
      linkToken,
      initData,
      telegramCreds: fakeTelegramCreds({ default: FAKE_BOT_TOKEN }),
      keyPath,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it("a failed attempt does not block the same legitimate user's retry", async () => {
    const keyPath = tmpKeyPath()
    const { token: linkToken } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "42" },
      ttlMs: 60_000,
      pendingTelegramAuth: true,
      keyPath,
    })
    const telegramCreds = fakeTelegramCreds({ default: FAKE_BOT_TOKEN })
    const badInitData = signInitData(buildInitDataFields({ userId: 999 }), FAKE_BOT_TOKEN)
    const failed = await authorizeAppLink({ linkToken, initData: badInitData, telegramCreds, keyPath })
    expect(failed.ok).toBe(false)

    const goodInitData = signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN)
    const succeeded = await authorizeAppLink({ linkToken, initData: goodInitData, telegramCreds, keyPath })
    expect(succeeded.ok).toBe(true)
  })

  it("the SAME link token can be exchanged again with fresh valid initData, and the second session token works", async () => {
    const keyPath = tmpKeyPath()
    const { token: linkToken } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "42" },
      ttlMs: 60_000,
      pendingTelegramAuth: true,
      keyPath,
    })
    const telegramCreds = fakeTelegramCreds({ default: FAKE_BOT_TOKEN })
    const initData = signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN)
    const first = await authorizeAppLink({ linkToken, initData, telegramCreds, keyPath })
    expect(first.ok).toBe(true)

    const second = await authorizeAppLink({
      linkToken,
      initData: signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN),
      telegramCreds,
      keyPath,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error("unreachable")
    const verified = verifyAppLinkSessionToken(second.sessionToken, keyPath)
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.payload.claims.sessionId).toBe("sess_abc")
  })

  it("a reusable link token is still refused once its own exp has passed, even with fresh valid initData", async () => {
    const keyPath = tmpKeyPath()
    vi.useFakeTimers()
    try {
      const { token: linkToken } = mintAppLinkToken({
        appId: "@agentik/session-chat",
        claims: { sessionId: "sess_abc", telegramUserId: "42" },
        ttlMs: 60_000,
        pendingTelegramAuth: true,
        keyPath,
      })
      const telegramCreds = fakeTelegramCreds({ default: FAKE_BOT_TOKEN })
      const first = await authorizeAppLink({
        linkToken,
        initData: signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN),
        telegramCreds,
        keyPath,
      })
      expect(first.ok).toBe(true)

      vi.advanceTimersByTime(61_000)
      const late = await authorizeAppLink({
        linkToken,
        initData: signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN),
        telegramCreds,
        keyPath,
      })
      expect(late.ok).toBe(false)
      if (!late.ok) {
        expect(late.status).toBe(401)
        expect(late.error).toMatch(/expired/)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it("an invalid/forged link token is refused (401)", async () => {
    const keyPath = tmpKeyPath()
    const initData = signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN)
    const result = await authorizeAppLink({
      linkToken: "garbage.token",
      initData,
      telegramCreds: fakeTelegramCreds({ default: FAKE_BOT_TOKEN }),
      keyPath,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it("caps an outsized sessionTtlMs claim at the 24h hard cap", async () => {
    const keyPath = tmpKeyPath()
    const { token: linkToken } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "42", sessionTtlMs: String(999 * 24 * 60 * 60_000) },
      ttlMs: 60_000,
      pendingTelegramAuth: true,
      keyPath,
    })
    const initData = signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN)
    const result = await authorizeAppLink({
      linkToken,
      initData,
      telegramCreds: fakeTelegramCreds({ default: FAKE_BOT_TOKEN }),
      keyPath,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    const verified = verifyAppLinkSessionToken(result.sessionToken, keyPath)
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      const ttlSeconds = verified.payload.exp - Math.floor(Date.now() / 1000)
      expect(ttlSeconds).toBeLessThanOrEqual(24 * 60 * 60 + 5)
    }
  })

  it("concurrent exchanges of the SAME link token with valid initData both succeed", async () => {
    const keyPath = tmpKeyPath()
    const { token: linkToken } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "42" },
      ttlMs: 60_000,
      pendingTelegramAuth: true,
      keyPath,
    })
    const telegramCreds = fakeTelegramCreds({ default: FAKE_BOT_TOKEN })
    const initData = signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN)
    const [first, second] = await Promise.all([
      authorizeAppLink({ linkToken, initData, telegramCreds, keyPath }),
      authorizeAppLink({ linkToken, initData, telegramCreds, keyPath }),
    ])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
  })

  it("honours a custom botAlias claim from app_link_mint", async () => {
    const keyPath = tmpKeyPath()
    const { token: linkToken } = mintAppLinkToken({
      appId: "@agentik/session-chat",
      claims: { sessionId: "sess_abc", telegramUserId: "42", botAlias: "support-bot" },
      ttlMs: 60_000,
      pendingTelegramAuth: true,
      keyPath,
    })
    const initData = signInitData(buildInitDataFields({ userId: 42 }), "support-bot-token")
    const result = await authorizeAppLink({
      linkToken,
      initData,
      telegramCreds: fakeTelegramCreds({ default: FAKE_BOT_TOKEN, "support-bot": "support-bot-token" }),
      keyPath,
    })
    expect(result.ok).toBe(true)
  })
})
