import { describe, expect, it } from "vitest"
import { validateTelegramInitData } from "../telegram-init-data.js"
import { FAKE_BOT_TOKEN, signInitData, buildInitDataFields } from "./helpers/telegram-init-data-fixture.js"

describe("validateTelegramInitData", () => {
  it("accepts a correctly signed initData payload", () => {
    const initData = signInitData(buildInitDataFields(), FAKE_BOT_TOKEN)
    const result = validateTelegramInitData(initData, FAKE_BOT_TOKEN)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.user.id).toBe(42)
  })

  it("rejects a tampered field (signature mismatch)", () => {
    const initData = signInitData(buildInitDataFields(), FAKE_BOT_TOKEN)
    const tampered = initData.replace(
      "user=" + encodeURIComponent(JSON.stringify({ id: 42, first_name: "Jeremy" })),
      "user=" + encodeURIComponent(JSON.stringify({ id: 999, first_name: "Jeremy" })),
    )
    expect(validateTelegramInitData(tampered, FAKE_BOT_TOKEN).ok).toBe(false)
  })

  it("rejects a stale auth_date beyond maxAgeSeconds", () => {
    const oldAuthDate = Math.floor(Date.now() / 1000) - 3600
    const initData = signInitData(buildInitDataFields({ authDate: oldAuthDate }), FAKE_BOT_TOKEN)
    const result = validateTelegramInitData(initData, FAKE_BOT_TOKEN, { maxAgeSeconds: 300 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/stale/)
  })

  it("rejects when signed with the wrong bot token", () => {
    const initData = signInitData(buildInitDataFields(), FAKE_BOT_TOKEN)
    expect(validateTelegramInitData(initData, "different-token").ok).toBe(false)
  })

  it("rejects when botToken is missing", () => {
    const initData = signInitData(buildInitDataFields(), FAKE_BOT_TOKEN)
    expect(validateTelegramInitData(initData, undefined).ok).toBe(false)
  })
})
