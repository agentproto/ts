/** Test-only Telegram Mini App `initData` signer — mirrors the real
 *  signing Telegram's client SDK does, for exercising
 *  `validateTelegramInitData` / `authorizeAppLink` without a real bot. */

import { createHmac } from "node:crypto"

export const FAKE_BOT_TOKEN = "123456:FAKE-TEST-TOKEN-not-real"

export function signInitData(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map(key => `${key}=${fields[key]}`)
    .join("\n")
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest()
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex")
  const params = new URLSearchParams({ ...fields, hash })
  return params.toString()
}

export function buildInitDataFields(overrides?: { authDate?: number; userId?: number }): Record<string, string> {
  return {
    auth_date: String(overrides?.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify({ id: overrides?.userId ?? 42, first_name: "Jeremy" }),
  }
}
