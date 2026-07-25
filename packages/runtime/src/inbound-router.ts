/**
 * inbound-router — shared routing decision for inbound agentpush messages,
 * used by both the poll loop (`inbound-watcher.ts`) and the push ingress
 * (`POST /inbound` in `http-server.ts`).
 *
 * Given a mode and an optional session binding, decides whether to:
 *   - spawn a brand-new agent (today's poll-loop behavior),
 *   - route the message as a user turn into an already-bound live session,
 *   - resurrect a dead bound session and then route into it, or
 *   - skip (no binding, routing-only mode).
 */

import type { TransmitterBindingStore } from "./transmitter-bindings.js"

export type InboundRouteMode = "spawn" | "route" | "route-or-spawn"

export interface InboundMessage {
  alias: string
  source: string
  contactRef: string
  /** Rendered user-turn text. */
  text: string
  /** Raw agentpush events, forwarded to the spawn fallback template. */
  messages?: unknown[]
}

/** Deliver `text` as a new user turn on a live session. Same shape as
 *  `SessionsRegistry.enqueuePrompt` (sessions.ts) — the daemon wires that
 *  method in directly. */
export type InboundEnqueuePrompt = (
  sessionId: string,
  text: string,
  opts?: { interrupt?: boolean },
) => Promise<void> | void

/** Whether `sessionId` is currently live enough to route into without a
 *  restart first. */
export type InboundIsSessionAlive = (sessionId: string) => boolean

/** Resurrect a dead session in place. Returns the (possibly new) live
 *  session id. */
export type InboundRestartSession = (sessionId: string) => Promise<string>

/** Spawn-fallback for an unbound contact — today's poll-loop behavior. */
export type InboundSpawnForContact = (msg: InboundMessage) => Promise<void>

/** Diagnostic sink for routing decisions (e.g. a missing spawn fallback). */
export type InboundRouterLog = (msg: string) => void

export interface InboundRouterDeps {
  bindings: TransmitterBindingStore
  enqueuePrompt: InboundEnqueuePrompt
  isSessionAlive: InboundIsSessionAlive
  restartSession: InboundRestartSession
  spawnForContact?: InboundSpawnForContact
  log?: InboundRouterLog
}

export type InboundRouteAction = "routed" | "spawned" | "restarted-routed" | "skipped"

export async function routeInboundMessage(
  deps: InboundRouterDeps,
  msg: InboundMessage,
  mode: InboundRouteMode,
): Promise<{ action: InboundRouteAction; sessionId?: string }> {
  const log = deps.log ?? ((): void => {})

  const trySpawn = async (): Promise<{ action: InboundRouteAction }> => {
    if (!deps.spawnForContact) {
      log(
        `[inbound-router] mode "${mode}" has no spawnForContact configured — ` +
          `skipping ${msg.alias}:${msg.source}:${msg.contactRef}`,
      )
      return { action: "skipped" }
    }
    await deps.spawnForContact(msg)
    return { action: "spawned" }
  }

  if (mode === "spawn") {
    return trySpawn()
  }

  const binding = deps.bindings.get(msg.alias, msg.source, msg.contactRef)

  if (!binding) {
    if (mode === "route-or-spawn") return trySpawn()
    return { action: "skipped" }
  }

  const routeInto = async (sessionId: string): Promise<{ action: InboundRouteAction; sessionId: string }> => {
    await deps.enqueuePrompt(sessionId, msg.text)
    deps.bindings.upsert({
      alias: binding.alias,
      source: binding.source,
      contactRef: binding.contactRef,
      sessionId,
      mode: binding.mode,
      provider: binding.provider,
    })
    return { action: sessionId === binding.sessionId ? "routed" : "restarted-routed", sessionId }
  }

  if (deps.isSessionAlive(binding.sessionId)) {
    return routeInto(binding.sessionId)
  }

  const restartedSessionId = await deps.restartSession(binding.sessionId)
  return routeInto(restartedSessionId)
}
