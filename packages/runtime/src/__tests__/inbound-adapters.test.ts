/**
 * Unit tests for the provider-agnostic inbound adapter layer.
 */

import { describe, expect, it } from "vitest"
import {
  normalizeInbound,
  verifyInboundSignature,
  type InboundProvider,
} from "../inbound-adapters.js"
import { createHmac, randomBytes } from "node:crypto"

describe("normalizeInbound", () => {
  it("normalizes a generic JSON envelope", () => {
    const result = normalizeInbound(
      "generic",
      {
        source: "#lobby",
        contact_ref: "u42",
        text: "hello",
        provider_message_id: "msg-1",
      },
      { alias: "generic-alias" },
    )
    expect(result).toEqual({
      ok: true,
      msg: {
        alias: "generic-alias",
        source: "#lobby",
        contactRef: "u42",
        text: "hello",
      },
      providerMessageId: "msg-1",
    })
  })

  it("uses sourceOverride when provided", () => {
    const result = normalizeInbound(
      "generic",
      { contact_ref: "u42", text: "hello" },
      { alias: "my-alias", sourceOverride: "override" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok || "challenge" in result) return
    expect(result.msg).toMatchObject({
      alias: "my-alias",
      source: "override",
      contactRef: "u42",
      text: "hello",
    })
  })

  it("recognizes an agentpush challenge", () => {
    const result = normalizeInbound("agentpush", { challenge: "abc123" }, { alias: "ap" })
    expect(result).toEqual({ ok: true, challenge: "abc123" })
  })

  it("normalizes a telegram message with distinct source and contactRef", () => {
    // source must be the channel name ("telegram"), NOT the chat id --
    // a binding is keyed on (alias, source, contactRef); collapsing them
    // means nothing written via transmit_message (which always sends
    // source:"telegram") can ever match on lookup. Regression for a bug
    // that shipped with zero coverage of the happy path's actual values.
    const result = normalizeInbound(
      "telegram",
      {
        message: {
          from: { id: 1, is_bot: false },
          chat: { id: 6371794295 },
          text: "hello",
          message_id: 42,
        },
      },
      { alias: "tg" },
    )
    expect(result).toEqual({
      ok: true,
      msg: {
        alias: "tg",
        source: "telegram",
        contactRef: "6371794295",
        text: "hello",
      },
      providerMessageId: "42",
    })
  })

  it("uses sourceOverride for telegram when provided, contactRef still the chat id", () => {
    const result = normalizeInbound(
      "telegram",
      {
        message: {
          from: { id: 1, is_bot: false },
          chat: { id: 6371794295 },
          text: "hi",
          message_id: 1,
        },
      },
      { alias: "tg", sourceOverride: "telegram-agentproto" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok || "challenge" in result) return
    expect(result.msg).toMatchObject({
      source: "telegram-agentproto",
      contactRef: "6371794295",
    })
  })

  it("ignores bot messages for telegram", () => {
    const result = normalizeInbound(
      "telegram",
      {
        message: {
          from: { is_bot: true, id: 1 },
          chat: { id: 10 },
          text: "hi",
          message_id: 1,
        },
      },
      { alias: "tg" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe("bot_or_self_message")
  })

  it("returns no_text when telegram message has no text", () => {
    const result = normalizeInbound(
      "telegram",
      {
        message: {
          from: { id: 1 },
          chat: { id: 10 },
          message_id: 1,
        },
      },
      { alias: "tg" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe("no_text")
  })
})

describe("verifyInboundSignature", () => {
  it("passes for agentpush hmac-sha256", () => {
    const secret = randomBytes(16).toString("hex")
    const rawBody = JSON.stringify({ messageId: "m1", text: "hi" })
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
    const result = verifyInboundSignature("agentpush", {
      rawBody,
      headers: { "x-agentpush-signature": `sha256=${expected}` },
      secret,
      nowMs: Date.now(),
    })
    expect(result).toEqual({ ok: true })
  })

  it("fails when agentpush signature header is malformed", () => {
    const result = verifyInboundSignature("agentpush", {
      rawBody: "{}",
      headers: { "x-agentpush-signature": "bad" },
      secret: "s",
      nowMs: Date.now(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("bad x-agentpush-signature format")
  })

  it("passes for telegram secret token", () => {
    const secret = "my-bot-secret-token"
    const result = verifyInboundSignature("telegram", {
      rawBody: JSON.stringify({ update_id: 1 }),
      headers: { "x-telegram-bot-api-secret-token": secret },
      secret,
      nowMs: Date.now(),
    })
    expect(result).toEqual({ ok: true })
  })

  it("fails for telegram when token mismatch", () => {
    const result = verifyInboundSignature("telegram", {
      rawBody: "{}",
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      secret: "secret",
      nowMs: Date.now(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("bad x-telegram-bot-api-secret-token")
  })

  it("rejects unsupported providers", () => {
    const result = verifyInboundSignature("native" as InboundProvider, {
      rawBody: "{}",
      headers: {},
      secret: "s",
      nowMs: Date.now(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("native uses the sessions bearer gate")
  })
})
