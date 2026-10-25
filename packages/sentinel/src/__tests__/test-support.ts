import { createHmac } from "node:crypto"

import { sentinelPlatform } from "../platform.js"
import type { McpEventEnvelope } from "../platform.js"
import type { SessionEvent, SessionEventBus } from "../local-types.js"

export { writeFileDurable } from "../durable-internal.js"

export const callbackHost = (url: string): string => sentinelPlatform().webhookDelivery.callbackHost(url)
export const redactUrls = (text: string): string => sentinelPlatform().webhookDelivery.redactUrls(text)
export const serializeEnvelope = (event: McpEventEnvelope): Uint8Array =>
  sentinelPlatform().webhookDelivery.serializeEnvelope(event)

export function createSessionEventBus(): SessionEventBus {
  const handlers = new Set<(ev: SessionEvent) => void>()
  return {
    emit(ev) {
      for (const handler of handlers) handler(ev)
    },
    onAny(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}

export class SessionNotAliveError extends Error {
  readonly sessionId: string
  readonly status: string
  constructor(sessionId: string, status = "exited", caller = "test") {
    super(`${caller}: session "${sessionId}" is not alive (status=${status})`)
    this.name = "SessionNotAliveError"
    this.sessionId = sessionId
    this.status = status
  }
}

export function signWebhook(input: {
  msgId: string
  timestamp: number
  payload: Uint8Array
  secrets: readonly string[]
}): { "webhook-id": string; "webhook-timestamp": string; "webhook-signature": string } {
  const prefix = Buffer.from(`${input.msgId}.${input.timestamp}.`, "utf8")
  const payload = Buffer.from(input.payload.buffer, input.payload.byteOffset, input.payload.byteLength)
  const segments = input.secrets.map((secret) => {
    const key = Buffer.from(secret.slice("whsec_".length), "base64")
    const mac = createHmac("sha256", key).update(prefix).update(payload).digest()
    return `v1,${mac.toString("base64")}`
  })
  return {
    "webhook-id": input.msgId,
    "webhook-timestamp": String(input.timestamp),
    "webhook-signature": segments.join(" "),
  }
}
