/**
 * AgentprotoSignalProvider (WP-6) — a Mastra `SignalProvider` that watches
 * agentproto daemon sessions via {@link DaemonClient} and pushes their
 * lifecycle as notification signals into the native agent's thread.
 *
 * Two event sources per poll cycle (supervisor decision — no MCP JSON-RPC
 * client is built for this; the events route + a status diff is the design):
 *
 *   1. `GET /sessions/:id/events` (`client.pollEvents`) for the watched
 *      kinds in {@link WATCHED_EVENT_KINDS} — `turn-end`, `error`, and the
 *      permission pair (`agent-prompt` = the ask, `permission-resolved` =
 *      the answer). Cursor-based via `since`/`nextSeq`.
 *   2. A status DIFF over `client.listSessions()` — the events route is the
 *      per-session transcript and carries NO `exited` records (registry
 *      state changes are not transcript writes; see `pollEvents`'s doc
 *      comment). So each cycle lists sessions ONCE (`includeArchived: true`,
 *      so a watched session that gets archived after death still reports its
 *      terminal status) and compares every subscription's `status` against
 *      the last seen one in subscription metadata; a transition into
 *      `exited`/`killed`/`error` becomes an `exited` notification.
 *
 * Cursor + last-status live in the subscription's `metadata` — in-process
 * state only, NOT persisted across an adapter restart. A restart therefore
 * replays events from the start of the watched session's transcript; that
 * replay is harmless because every notification carries a deterministic
 * `dedupeKey` (`agentproto-daemon:<sessionId>:<eventSeq>`, `:exited` for the
 * status-diff exit) and the notifications storage coalesces on it
 * (`createNotification` → `findCoalescable`) instead of inserting duplicates.
 *
 * Poll errors never kill the loop: each subscription is polled inside its
 * own try/catch, and repeated identical failures warn once (per distinct
 * message), not once per 5s cycle.
 */

import { createTool } from "@mastra/core/tools"
import { SignalProvider } from "@mastra/core/signals"
import type { SignalProviderTarget, SignalSubscription } from "@mastra/core/signals"
import { z } from "zod"
import { DaemonClient, type DaemonClientOptions } from "./daemon-client.js"

/** Transcript-event kinds a watch subscribes to (see the daemon's
 *  `transcript-writer.ts` for the full kind set): turn boundaries, errors,
 *  and the permission ask/answer pair. */
export const WATCHED_EVENT_KINDS = [
  "turn-end",
  "error",
  "agent-prompt",
  "permission-resolved",
] as const

/** Daemon `SessionStatus` values that mean the session is gone
 *  (`packages/runtime/src/sessions.ts`'s `SessionStatus`, read as reference). */
export const EXIT_STATUSES = new Set(["exited", "killed", "error"])

/** Upper bound on distinct warn-once messages kept for dedupe — a leaked-set
 *  guard, not a behavior knob (hitting it just re-allows old warnings). */
const MAX_WARNED_MESSAGES = 200

export interface AgentprotoSignalProviderOptions {
  /** Reuse a pre-built client (the factory shares one across daemon tools and
   *  this provider) — one is built from `clientOptions` otherwise. */
  client?: DaemonClient
  /** Forwarded to `new DaemonClient(...)` when no `client` is supplied. */
  clientOptions?: DaemonClientOptions
  /** Poll cadence in ms. Default 5_000. */
  pollInterval?: number
}

export class AgentprotoSignalProvider extends SignalProvider<"agentproto-daemon"> {
  readonly id = "agentproto-daemon" as const
  readonly pollInterval: number

  readonly #client: DaemonClient
  readonly #warned = new Set<string>()

  constructor(opts: AgentprotoSignalProviderOptions = {}) {
    super()
    this.#client = opts.client ?? new DaemonClient(opts.clientOptions)
    this.pollInterval = opts.pollInterval ?? 5_000
  }

  /**
   * Subscribe a thread to a daemon session's lifecycle. The public wrapper
   * around the base class's protected `subscribe` — `sessionId` is the daemon
   * session id (subscription `externalResourceId`). Optional `metadata.label`
   * feeds the notification summary.
   */
  watch(
    target: SignalProviderTarget,
    sessionId: string,
    metadata?: Record<string, unknown>,
  ): SignalSubscription {
    return this.subscribe(target, sessionId, metadata)
  }

  /** Undo a {@link watch}. Returns false when no such subscription existed. */
  unwatch(target: SignalProviderTarget, sessionId: string): boolean {
    return this.unsubscribe(target, sessionId)
  }

  /**
   * One poll cycle over all subscriptions. The base class only calls this
   * when at least one subscription exists, so an idle provider (nothing
   * watched) never touches the daemon — that's the "dormant when no daemon
   * is discoverable" behavior: discovery isn't even attempted until a watch
   * exists, and a failing first poll warns once instead of throwing.
   */
  async poll(subscriptions: SignalSubscription[]): Promise<void> {
    if (subscriptions.length === 0) return

    // One listSessions per cycle backs the exit status-diff for EVERY
    // subscription. A failure here (daemon gone, network) skips exit
    // detection this cycle but still lets per-subscription event polls run
    // (they'll fail and warn on their own if the daemon is truly gone).
    let sessionsById: Map<string, Record<string, unknown>> | undefined
    try {
      const { sessions } = await this.#client.listSessions({ includeArchived: true })
      sessionsById = new Map(
        sessions.filter((s) => typeof s.id === "string").map((s) => [s.id as string, s]),
      )
    } catch (err) {
      this.#warnOnce(`listSessions failed (exit detection skipped): ${errorMessage(err)}`)
    }

    for (const sub of subscriptions) {
      try {
        await this.#pollSubscription(sub, sessionsById)
      } catch (err) {
        this.#warnOnce(`session ${sub.externalResourceId}: ${errorMessage(err)}`)
      }
    }
  }

  async #pollSubscription(
    sub: SignalSubscription,
    sessionsById: Map<string, Record<string, unknown>> | undefined,
  ): Promise<void> {
    const sessionId = sub.externalResourceId
    const target: SignalProviderTarget = {
      threadId: sub.threadId,
      resourceId: sub.resourceId,
      ...(sub.metadata.ifIdle ? { ifIdle: sub.metadata.ifIdle as SignalProviderTarget["ifIdle"] } : {}),
    }

    const cursor = typeof sub.metadata.cursor === "number" ? sub.metadata.cursor : undefined
    const result = await this.#client.pollEvents(sessionId, {
      ...(cursor !== undefined ? { since: cursor } : {}),
      types: [...WATCHED_EVENT_KINDS],
    })
    for (const [i, event] of result.events.entries()) {
      const kind = typeof event.kind === "string" ? event.kind : "unknown"
      const seq = typeof event.seq === "number" ? String(event.seq) : `i${i}`
      await this.notify(
        {
          source: this.id,
          kind,
          priority: kind === "error" ? "high" : "medium",
          summary: this.#summary(sessionId, sub, sessionsById, kind),
          payload: event,
          dedupeKey: `${this.id}:${sessionId}:${seq}`,
        },
        target,
      )
    }
    // Advance past everything the route returned, INCLUDING kinds the
    // client-side `types` filter dropped — `nextSeq` is the raw route
    // cursor, so filtered-out records are never re-fetched.
    sub.metadata.cursor = result.nextSeq

    // Status-diff exit detection (see module doc: the events route carries
    // no `exited` records). Watching an already-dead session notifies its
    // exit on the first cycle — deliberate: "this session is already gone"
    // is exactly what a fresh watcher needs to hear.
    const record = sessionsById?.get(sessionId)
    if (!record) return
    const status = typeof record.status === "string" ? record.status : undefined
    if (!status) return
    const lastStatus = typeof sub.metadata.lastStatus === "string" ? sub.metadata.lastStatus : undefined
    sub.metadata.lastStatus = status
    const alreadyNotified = lastStatus !== undefined && EXIT_STATUSES.has(lastStatus)
    if (!EXIT_STATUSES.has(status) || alreadyNotified) return

    const exitedWithError =
      status === "error" || (typeof record.exitCode === "number" && record.exitCode !== 0)
    await this.notify(
      {
        source: this.id,
        kind: "exited",
        priority: exitedWithError ? "high" : "medium",
        summary: `${this.#summary(sessionId, sub, sessionsById, "exited")} (status ${status})`,
        payload: record,
        dedupeKey: `${this.id}:${sessionId}:exited`,
      },
      target,
    )
  }

  /** `Session <id> (<label>): <kind>` — label from watch metadata, falling
   *  back to the daemon's session record. */
  #summary(
    sessionId: string,
    sub: SignalSubscription,
    sessionsById: Map<string, Record<string, unknown>> | undefined,
    kind: string,
  ): string {
    const recordLabel = sessionsById?.get(sessionId)?.label
    const label =
      typeof sub.metadata.label === "string"
        ? sub.metadata.label
        : typeof recordLabel === "string"
          ? recordLabel
          : undefined
    return `Session ${sessionId}${label ? ` (${label})` : ""}: ${kind}`
  }

  #warnOnce(message: string): void {
    if (this.#warned.has(message)) return
    if (this.#warned.size >= MAX_WARNED_MESSAGES) this.#warned.clear()
    this.#warned.add(message)
    console.warn(`[@agentproto/adapter-mastra-agent] ${this.id}: ${message}`)
  }

  /**
   * Agent-callable subscription management. The target thread resolves from
   * the tool's own execution context (`context.agent.threadId`/`resourceId`,
   * populated by the agent tool-call step) — explicit `threadId`/`resourceId`
   * inputs override it for the rare host driving these outside a run.
   *
   * Subscriptions made here set `ifIdle: { behavior: "persist" }`: this
   * adapter fronts an ACP client that only streams during a prompt turn, so
   * WAKING an idle thread would run a hidden background turn nobody sees.
   * Persisting instead lands the notification in the thread history + inbox,
   * where the next real turn picks it up.
   */
  getTools(): Record<string, ReturnType<typeof createTool>> {
    const watch_session = createTool({
      id: "watch_session",
      description:
        "Watch a daemon session: subscribe this conversation to its lifecycle (turn ends, errors, " +
        "permission asks, exit). Events arrive as notifications — check the notification inbox or " +
        "the conversation for them. Use session ids from `agent_start` / `session_list`.",
      inputSchema: z.object({
        sessionId: z.string().describe("Daemon session id to watch."),
        label: z.string().optional().describe("Human-readable label used in notification summaries."),
        threadId: z.string().optional().describe("Explicit target thread id. Defaults to the current thread."),
        resourceId: z.string().optional().describe("Explicit target resource id. Defaults to the current resource."),
      }),
      outputSchema: z.object({ subscribed: z.boolean(), sessionId: z.string(), threadId: z.string() }),
      execute: async (input, context) => {
        const threadId = input.threadId ?? context.agent?.threadId
        const resourceId = input.resourceId ?? context.agent?.resourceId
        if (!threadId || !resourceId) {
          throw new Error(
            "watch_session: no target thread — this call ran outside an agent thread, so pass " +
              "threadId and resourceId explicitly.",
          )
        }
        this.watch({ threadId, resourceId, ifIdle: { behavior: "persist" } }, input.sessionId, {
          ...(input.label ? { label: input.label } : {}),
          ifIdle: { behavior: "persist" },
        })
        return { subscribed: true, sessionId: input.sessionId, threadId }
      },
    })

    const unwatch_session = createTool({
      id: "unwatch_session",
      description:
        "Stop watching a daemon session previously subscribed with `watch_session`.",
      inputSchema: z.object({
        sessionId: z.string().describe("Daemon session id to stop watching."),
        threadId: z.string().optional().describe("Explicit target thread id. Defaults to the current thread."),
        resourceId: z.string().optional().describe("Explicit target resource id. Defaults to the current resource."),
      }),
      outputSchema: z.object({ unsubscribed: z.boolean(), sessionId: z.string() }),
      execute: async (input, context) => {
        const threadId = input.threadId ?? context.agent?.threadId
        const resourceId = input.resourceId ?? context.agent?.resourceId
        if (!threadId || !resourceId) {
          throw new Error(
            "unwatch_session: no target thread — this call ran outside an agent thread, so pass " +
              "threadId and resourceId explicitly.",
          )
        }
        const unsubscribed = this.unwatch({ threadId, resourceId }, input.sessionId)
        return { unsubscribed, sessionId: input.sessionId }
      },
    })

    return { watch_session, unwatch_session }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
