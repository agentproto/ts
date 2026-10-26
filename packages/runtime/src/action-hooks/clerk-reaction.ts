/**
 * Durable dispatch of the AIP-68 clerk pass (opt-in per workspace).
 *
 * The clerk controller remains the gate and the debounce. This module only
 * changes what happens when its timer fires: for a workspace slug listed in
 * `defaults.reactions.clerk.workspaces` it emits `agentproto:clerk-due` and
 * the durable reaction runs the legacy pass runner, with a receipt. Every
 * other workspace, including a missing slug and a failed config read, keeps
 * the legacy dispatch unchanged and emits nothing.
 *
 * The pass target is not idempotent: a pass interrupted by a crash is not
 * replayed. Ownership is read once per firing, so a hot config flip can never
 * run both paths for the same firing.
 */

import { basename } from "node:path"

import type { ClerkHookConfig, ClerkPassInput } from "@agentproto/clerk"

import type { SessionClerkDueEvent, SessionEvent } from "../session-event-bus.js"
import type { SessionDescriptor } from "../sessions.js"
import { loadConfig } from "../config.js"
import type { ActionHandler } from "./reaction-bindings.js"
import type { ReactionBinding, ReactionTargetOutcome } from "./reaction-runner.js"
import { sessionFactsOf } from "./reaction-wiring.js"

export const CLERK_REACTION_BINDING_ID = "builtin:clerk-pass"

export const CLERK_REACTION_ACTION_ID = "session:clerk-pass"

const CLERK_REACTION_CONFIG_REVISION = "clerk-pass-v1"

const DEFAULT_MAX_ATTEMPTS = 3

export interface ClerkReactionOptions {
  sessions: { get(id: string): SessionDescriptor | undefined }
  /** The same three level resolution the controller uses; undefined means not configured. */
  resolveConfig: (session: SessionDescriptor) => ClerkHookConfig | undefined
  /** The LEGACY pass runner, called by the target for a reaction-owned firing. */
  runPass: (input: ClerkPassInput) => Promise<unknown> | unknown
  ownedWorkspaces: () => Promise<readonly string[]> | readonly string[]
  emit: (event: SessionClerkDueEvent) => void
  nowIso?: () => string
  maxAttempts?: number
  log?: (line: string) => void
}

export interface ClerkReaction {
  binding: ReactionBinding
  /** The ActionHandler to register in the daemon action registry under CLERK_REACTION_ACTION_ID. */
  handler: ActionHandler
  /** The runPass to hand to the clerk controller. */
  dispatch: (input: ClerkPassInput) => Promise<void>
}

/** Read the opt-in list from `config.json`, per call like the other defaults resolvers. */
export async function readClerkReactionOwnedWorkspaces(): Promise<readonly string[]> {
  try {
    const config = await loadConfig()
    return config.defaults?.reactions?.clerk?.workspaces ?? []
  } catch {
    return []
  }
}

export function createClerkReaction(opts: ClerkReactionOptions): ClerkReaction {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const nowIso = opts.nowIso ?? (() => new Date().toISOString())
  const log = opts.log ?? ((line: string): void => console.warn(line))
  const inFlight = new Set<string>()

  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  const isOwnedSlug = async (slug: string | undefined): Promise<boolean> => {
    if (slug === undefined) return false
    try {
      const owned = await opts.ownedWorkspaces()
      return owned.includes(slug)
    } catch (err) {
      log(`[clerk-reaction] reading owned workspaces failed: ${messageOf(err)}`)
      return false
    }
  }

  const dispatch = async (input: ClerkPassInput): Promise<void> => {
    const session = opts.sessions.get(input.sessionId) ?? input.session
    const owned = await isOwnedSlug(session.workspaceSlug)
    if (!owned) {
      await opts.runPass(input)
      return
    }
    const iso = nowIso()
    try {
      opts.emit({
        type: "agentproto:clerk-due",
        sessionId: input.sessionId,
        occurrenceId: `due:${iso}`,
        ts: iso,
      })
    } catch (err) {
      log(`[clerk-reaction] emitting clerk-due for ${input.sessionId} failed: ${messageOf(err)}`)
    }
  }

  const runShared = async (sessionId: string): Promise<ReactionTargetOutcome> => {
    const session = opts.sessions.get(sessionId)
    if (!session) return { ok: true, outcomeRef: "skipped:config" }
    const config = opts.resolveConfig(session)
    if (!config || !config.enabled) return { ok: true, outcomeRef: "skipped:config" }
    if (inFlight.has(sessionId)) return { ok: true, outcomeRef: "skipped:single_flight" }
    inFlight.add(sessionId)
    try {
      const outcomeRef = config.run.routine
        ? `routine:${config.run.routine}`
        : config.run.command
          ? `command:${basename(config.run.command)}`
          : "skipped:config"
      await opts.runPass({ sessionId, session, config })
      return { ok: true, outcomeRef }
    } finally {
      inFlight.delete(sessionId)
    }
  }

  const binding: ReactionBinding = {
    bindingId: CLERK_REACTION_BINDING_ID,
    event: "agentproto:clerk-due",
    actionId: CLERK_REACTION_ACTION_ID,
    configRevision: CLERK_REACTION_CONFIG_REVISION,
    maxAttempts,
    reactionDepth: 0,

    occurrenceIdOf(event: SessionEvent): string | undefined {
      if (event.type !== "agentproto:clerk-due") return undefined
      return (event as SessionClerkDueEvent).occurrenceId
    },

    causation(event: SessionEvent): { reactionDepth: number; causedByEventId?: string } | undefined {
      const sessionId = (event as { sessionId?: unknown }).sessionId
      if (typeof sessionId !== "string") return undefined
      const session = opts.sessions.get(sessionId)
      if (!session) return undefined
      const facts = sessionFactsOf(session)
      const depth = facts.reactionDepth
      return {
        reactionDepth: typeof depth === "number" && Number.isFinite(depth) ? depth : 0,
        ...(typeof facts.causedByEventId === "string"
          ? { causedByEventId: facts.causedByEventId }
          : {}),
      }
    },

    async isTriggerValid(receipt): Promise<boolean> {
      const session = opts.sessions.get(receipt.sessionId)
      if (!session) return false
      const config = opts.resolveConfig(session)
      if (!config || !config.enabled) return false
      return await isOwnedSlug(session.workspaceSlug)
    },

    target: {
      actionId: CLERK_REACTION_ACTION_ID,
      idempotent: false,
      run(input): Promise<ReactionTargetOutcome> {
        return runShared(input.sessionId)
      },
    },
  }

  const handler: ActionHandler = {
    actionId: CLERK_REACTION_ACTION_ID,
    idempotent: false,
    run(input) {
      return runShared(input.sessionId)
    },
  }

  return { binding, handler, dispatch }
}
