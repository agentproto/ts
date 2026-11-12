/**
 * The adapter registry: exactly two kinds, `telegram` and `webhook`. Turns
 * one principal's configured route (`reach.routes.<principal>`) into adapter
 * instances, in order. An entry that cannot be used is skipped and reported
 * with its id and a fixed reason, never its URL or secret.
 */

import type { ReachAdapter } from "@agentproto/reach"

import type { ApprovalTelegramBridge } from "../approvals/telegram-bridge.js"
import { decodeWhsecSecret } from "../webhook-egress/signing.js"
import { createTelegramReachAdapter } from "./telegram-adapter.js"
import { createWebhookReachAdapter } from "./webhook-adapter.js"

export const REACH_ADAPTER_KINDS = ["telegram", "webhook"] as const

export interface ReachRouteDeps {
  telegramBridge?: Pick<ApprovalTelegramBridge, "announce">
  telegramAlias?: string
  fetchImpl?: typeof fetch
  onError?: (err: unknown) => void
}

export interface ReachRouteSkip {
  index: number
  id?: string
  reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false
  try {
    const protocol = new URL(value).protocol
    return protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}

export function createReachRoute(
  entries: readonly unknown[],
  deps: ReachRouteDeps = {},
): { adapters: ReachAdapter[]; skipped: ReachRouteSkip[] } {
  const adapters: ReachAdapter[] = []
  const skipped: ReachRouteSkip[] = []
  entries.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "") {
      skipped.push({ index, reason: "missing-id" })
      return
    }
    const id = entry.id
    if (adapters.some(a => a.id === id)) {
      skipped.push({ index, id, reason: "duplicate-id" })
      return
    }
    if (entry.kind === "telegram") {
      if (entry.alias !== undefined && typeof entry.alias !== "string") {
        skipped.push({ index, id, reason: "invalid-alias" })
        return
      }
      adapters.push(
        createTelegramReachAdapter({
          id,
          ...(typeof entry.alias === "string" ? { alias: entry.alias } : {}),
          ...(deps.telegramBridge ? { bridge: deps.telegramBridge } : {}),
          ...(deps.telegramAlias ? { bridgeAlias: deps.telegramAlias } : {}),
          ...(deps.onError ? { onError: deps.onError } : {}),
        }),
      )
      return
    }
    if (entry.kind === "webhook") {
      if (!isHttpUrl(entry.url)) {
        skipped.push({ index, id, reason: "invalid-url" })
        return
      }
      if (typeof entry.secret !== "string" || !decodeWhsecSecret(entry.secret)) {
        skipped.push({ index, id, reason: "invalid-secret" })
        return
      }
      const timeoutMs = entry.timeoutMs
      if (timeoutMs !== undefined && !(typeof timeoutMs === "number" && Number.isInteger(timeoutMs) && timeoutMs > 0)) {
        skipped.push({ index, id, reason: "invalid-timeout" })
        return
      }
      adapters.push(
        createWebhookReachAdapter({
          id,
          url: entry.url as string,
          secret: entry.secret,
          ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        }),
      )
      return
    }
    skipped.push({ index, id, reason: "unknown-kind" })
  })
  return { adapters, skipped }
}
