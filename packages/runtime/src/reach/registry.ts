/**
 * The adapter registry: three kinds, `telegram`, `webhook` and `chat-sdk`.
 * Turns one principal's configured route (`reach.routes.<principal>`) into
 * adapter instances, in order. An entry that cannot be used is skipped and
 * reported with its id and a fixed reason, never its URL, secret or token.
 *
 * `chat-sdk` lives in the optional `@agentproto/reach-chat-sdk` package: the
 * daemon loads it only when the route names that kind and hands its factory
 * in as `chatSdkFactory`. This module stays synchronous and imports no
 * vendor code; with no factory a `chat-sdk` entry is skipped
 * `chat-sdk-not-installed`.
 */

import type { ReachAdapter, ReachChatSdkRouteEntry } from "@agentproto/reach"

import type { ApprovalTelegramBridge } from "../approvals/telegram-bridge.js"
import { decodeWhsecSecret } from "../webhook-egress/signing.js"
import { createTelegramReachAdapter } from "./telegram-adapter.js"
import { createWebhookReachAdapter } from "./webhook-adapter.js"

export const REACH_ADAPTER_KINDS = ["telegram", "webhook", "chat-sdk"] as const

/** `createChatSdkReachAdapter` from `@agentproto/reach-chat-sdk`. */
export type ChatSdkReachAdapterFactory = (entry: ReachChatSdkRouteEntry) => ReachAdapter

export interface ReachRouteDeps {
  /** The bridge, or a function returning it at send time. */
  telegramBridge?: Pick<ApprovalTelegramBridge, "announce"> | (() => Pick<ApprovalTelegramBridge, "announce"> | undefined)
  /** Whether a bridge exists to serve `telegram` entries. Default: whether
   *  `telegramBridge` is given. */
  telegramAvailable?: boolean
  telegramAlias?: string
  fetchImpl?: typeof fetch
  /** Serves `chat-sdk` entries. Absent when the optional package is not
   *  installed, or the route names no such entry. */
  chatSdkFactory?: ChatSdkReachAdapterFactory
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

export interface ReachRoute {
  /** Every usable entry, in route order. */
  adapters: ReachAdapter[]
  /** Entries refused outright (malformed, unknown kind, duplicate id). */
  skipped: ReachRouteSkip[]
  /** Adapters in the route that can never acknowledge on this daemon (a
   *  `telegram` entry with no bridge, or another alias). */
  unservable: ReachRouteSkip[]
}

export function createReachRoute(entries: readonly unknown[], deps: ReachRouteDeps = {}): ReachRoute {
  const adapters: ReachAdapter[] = []
  const skipped: ReachRouteSkip[] = []
  const unservable: ReachRouteSkip[] = []
  const telegramAvailable = deps.telegramAvailable ?? deps.telegramBridge !== undefined
  const bridgeAlias = deps.telegramAlias ?? "default"
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
      if (!telegramAvailable) unservable.push({ index, id, reason: "telegram-not-configured" })
      else if (typeof entry.alias === "string" && entry.alias !== bridgeAlias) {
        unservable.push({ index, id, reason: "alias-not-configured" })
      }
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
    if (entry.kind === "chat-sdk") {
      const problem = chatSdkEntryProblem(entry)
      if (problem) {
        skipped.push({ index, id, reason: problem })
        return
      }
      if (!deps.chatSdkFactory) {
        skipped.push({ index, id, reason: "chat-sdk-not-installed" })
        return
      }
      try {
        adapters.push(deps.chatSdkFactory(entry as unknown as ReachChatSdkRouteEntry))
      } catch {
        // The factory's message could name the entry's values: keep a fixed
        // reason only.
        skipped.push({ index, id, reason: "chat-sdk-invalid" })
      }
      return
    }
    skipped.push({ index, id, reason: "unknown-kind" })
  })
  return { adapters, skipped, unservable }
}

/** The same checks `@agentproto/reach-chat-sdk` makes, here so a bad entry
 *  is named even when the package is not installed. Fixed reasons only. */
function chatSdkEntryProblem(entry: Record<string, unknown>): string | undefined {
  if (entry.platform !== "whatsapp") return "unknown-platform"
  if (typeof entry.to !== "string" || !/^\d{6,15}$/.test(entry.to)) return "invalid-to"
  const wa = entry.whatsapp
  if (!isRecord(wa)) return "missing-whatsapp"
  if (typeof wa.phoneNumberId !== "string" || !/^\d+$/.test(wa.phoneNumberId)) return "invalid-phone-number-id"
  if (typeof wa.accessToken !== "string" || wa.accessToken.trim() === "") return "missing-access-token"
  const timeoutMs = entry.timeoutMs
  if (timeoutMs !== undefined && !(typeof timeoutMs === "number" && Number.isInteger(timeoutMs) && timeoutMs > 0)) {
    return "invalid-timeout"
  }
  return undefined
}

/** Kinds that only `tell`: they answer every approval `ask` undelivered, so
 *  they never make a route able to deliver one. */
const TELL_ONLY_KINDS: ReadonlySet<string> = new Set(["chat-sdk"])

/**
 * The route the daemon runs for one principal, built once. `on` is true only
 * when at least one adapter can acknowledge an approval (a webhook, or a
 * telegram entry the bridge serves; a tell-only `chat-sdk` entry does not
 * count): a route that can never deliver starts no router, and the bridge
 * keeps announcing by itself. `warnings` are the `reach:` lines to
 * log at boot; none names a URL or a secret.
 */
export function planReachRoute(
  entries: readonly unknown[],
  deps: ReachRouteDeps = {},
  principal = "owner",
): ReachRoute & { on: boolean; warnings: string[] } {
  const route = createReachRoute(entries, deps)
  const warnings = route.skipped.map(s => `reach: route entry ${s.id ?? `#${s.index}`} skipped (${s.reason})`)
  const tellOnly = route.adapters.filter(a => TELL_ONLY_KINDS.has(a.kind))
  const on = route.adapters.length - tellOnly.length > route.unservable.length
  if (!on && entries.length > 0) {
    const why =
      [...route.unservable.map(u => `${u.id}: ${u.reason}`), ...tellOnly.map(a => `${a.id}: tell-only`)].join(", ") ||
      "no usable entry"
    warnings.push(
      `reach: routes.${principal} has no adapter that can deliver (${why}); router not started, approvals are announced as without reach`,
    )
  }
  return { ...route, on, warnings }
}
