/**
 * Validates a Telegram Mini App `initData` string per the documented
 * algorithm (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * `secretKey = HMAC_SHA256("WebAppData", botToken)`, `hash =
 * HMAC_SHA256(secretKey, data_check_string)` over the params sorted and
 * joined `key=value` with `\n`, excluding `hash` itself.
 *
 * Ported from `services/telegram-session-chat-miniapp/src/telegram-init-data.ts`
 * (a separate, pre-AIP-53 proxy service being superseded by the daemon-side
 * flow this file backs — app-link-auth.ts) rather than imported: that
 * service lives outside this package's dependency graph and is slated for
 * removal once the daemon absorbs its job.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export interface TelegramInitDataUser {
  id: number
  [key: string]: unknown
}

export type ValidateTelegramInitDataResult =
  | { ok: true; user: TelegramInitDataUser }
  | { ok: false; error: string }

const DEFAULT_MAX_AGE_SECONDS = 300

export function validateTelegramInitData(
  initData: string,
  botToken: string | undefined,
  opts?: { maxAgeSeconds?: number },
): ValidateTelegramInitDataResult {
  if (!botToken) return { ok: false, error: "missing bot token" }
  if (!initData) return { ok: false, error: "missing initData" }

  const params = new URLSearchParams(initData)
  const hash = params.get("hash")
  if (!hash) return { ok: false, error: "missing hash" }
  params.delete("hash")

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest()
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex")

  const computedBuf = Buffer.from(computedHash, "hex")
  const givenBuf = Buffer.from(hash, "hex")
  if (computedBuf.length !== givenBuf.length || !timingSafeEqual(computedBuf, givenBuf)) {
    return { ok: false, error: "invalid hash" }
  }

  const maxAgeSeconds = opts?.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  const authDateRaw = params.get("auth_date")
  if (!authDateRaw) return { ok: false, error: "missing auth_date" }
  const authDate = Number(authDateRaw)
  if (!Number.isFinite(authDate)) return { ok: false, error: "invalid auth_date" }
  const ageSeconds = Date.now() / 1000 - authDate
  if (ageSeconds > maxAgeSeconds) return { ok: false, error: "stale initData" }
  // A meaningfully future-dated auth_date is never legitimate (Telegram
  // stamps it server-side at hello time) — allow only ordinary clock skew.
  const FUTURE_SKEW_TOLERANCE_SECONDS = 60
  if (ageSeconds < -FUTURE_SKEW_TOLERANCE_SECONDS) return { ok: false, error: "auth_date is in the future" }

  const userRaw = params.get("user")
  if (!userRaw) return { ok: false, error: "missing user" }
  let user: TelegramInitDataUser
  try {
    const parsed = JSON.parse(userRaw) as unknown
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).id !== "number"
    ) {
      return { ok: false, error: "invalid user payload" }
    }
    user = parsed as TelegramInitDataUser
  } catch {
    return { ok: false, error: "invalid user json" }
  }

  return { ok: true, user }
}
