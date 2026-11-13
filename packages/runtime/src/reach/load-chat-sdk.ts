/**
 * Loads the optional `@agentproto/reach-chat-sdk` package, only when a route
 * names a `chat-sdk` entry, so a daemon without such a route never imports
 * the Chat SDK. A missing or broken package resolves to `undefined`, and the
 * registry then skips those entries `chat-sdk-not-installed`.
 */

import type { ChatSdkReachAdapterFactory } from "./registry.js"

type ChatSdkModule = { createChatSdkReachAdapter: ChatSdkReachAdapterFactory }

export function routeNamesChatSdk(entries: readonly unknown[]): boolean {
  return entries.some(e => e !== null && typeof e === "object" && (e as { kind?: unknown }).kind === "chat-sdk")
}

export async function loadChatSdkReachFactory(
  entries: readonly unknown[],
  importer: () => Promise<ChatSdkModule> = () => import("@agentproto/reach-chat-sdk"),
): Promise<ChatSdkReachAdapterFactory | undefined> {
  if (!routeNamesChatSdk(entries)) return undefined
  try {
    const mod = await importer()
    return typeof mod.createChatSdkReachAdapter === "function" ? mod.createChatSdkReachAdapter : undefined
  } catch {
    return undefined
  }
}
