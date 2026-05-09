/**
 * In-process event bus for the runtime gateway. Anything the daemon
 * does that an external observer might want to watch (heartbeat fired,
 * conversation turn appended, boot completed, …) flows through here.
 *
 * The HTTP server's `/events` SSE stream subscribes to it and forwards
 * each event as a `data: <json>\n\n` frame. Tests and embedded usage
 * subscribe directly via `events.on()`.
 */

import { EventEmitter } from "node:events"

export interface BootEvent {
  type: "boot"
  at: string
  workspace: string
  registered: readonly string[]
}

export interface HeartbeatFiredEvent {
  type: "heartbeat-fired"
  at: string
  agent: string
  conversationId: string
  prompt: string
  reply: string
  durationMs: number
}

export interface HeartbeatErrorEvent {
  type: "heartbeat-error"
  at: string
  agent?: string
  error: string
}

export interface ConvTurnEvent {
  type: "conv-turn-appended"
  at: string
  conversationId: string
  role: "user" | "assistant"
  contentPreview: string
}

/**
 * One log line from a supervised tunnel provider (cloudflared today).
 * Surfaced verbatim so users can debug "why didn't my remote URL come
 * up" by tailing /events.
 */
export interface RemoteLogEvent {
  type: "remote-log"
  at: string
  line: string
}

export type RuntimeEvent =
  | BootEvent
  | HeartbeatFiredEvent
  | HeartbeatErrorEvent
  | ConvTurnEvent
  | RemoteLogEvent

export interface RuntimeEvents {
  on<E extends RuntimeEvent["type"]>(
    type: E,
    handler: (ev: Extract<RuntimeEvent, { type: E }>) => void,
  ): () => void
  onAny(handler: (ev: RuntimeEvent) => void): () => void
  emit(ev: RuntimeEvent): void
}

export function createRuntimeEvents(): RuntimeEvents {
  const ee = new EventEmitter()
  ee.setMaxListeners(50)

  return {
    on(type, handler) {
      const wrapped = (ev: RuntimeEvent) => {
        if (ev.type === type) handler(ev as Extract<RuntimeEvent, { type: typeof type }>)
      }
      ee.on("event", wrapped)
      return () => ee.off("event", wrapped)
    },
    onAny(handler) {
      ee.on("event", handler)
      return () => ee.off("event", handler)
    },
    emit(ev) {
      ee.emit("event", ev)
    },
  }
}
