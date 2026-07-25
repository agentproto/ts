/**
 * MCP tools for event-driven orchestration:
 *   - session_events_poll — cheap cursor-based snapshot of session events
 *   - session_monitor     — multiplexed long-poll (1 call for N sessions)
 *
 * These complement the existing per-session waitForTurnEnd inside
 * agent_output. The new tools handle multi-session fan-in
 * and external-client retrigger without burning polling tokens.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SessionsRegistry } from "./sessions.js"
import type {
  SessionEventBus,
  SessionEventType,
  SessionAwaitingQuestion,
} from "./session-event-bus.js"
import type { EventRing } from "./event-ring.js"
import type { WorkflowRunner } from "./workflow-runner.js"
import type { CompletionPolicySupervisor, AttachPolicyInput } from "./supervisor.js"
import { withToolSubset } from "./tool-subset.js"
import { jsonTolerant } from "./json-tolerant.js"
import { collectSubtree } from "./session-tools.js"
import { policyWatchesSession } from "./supervisor.js"
import type { PolicyRunState } from "./supervisor.js"
import type { InboundWatcher } from "./inbound-watcher.js"
import type { McpProxyRegistry } from "./mcp-proxy.js"
import type { TransmitterBindingStore } from "./transmitter-bindings.js"
import type { InboundEndpointStore } from "./inbound-endpoints.js"
import { type InboundProvider, INBOUND_PROVIDERS } from "./inbound-adapters.js"
import { randomBytes } from "node:crypto"
import type { CronScheduler } from "./cron-scheduler.js"
import type { RoutineRegistrar } from "./routine-registrar.js"
import type { ActivityProjector } from "./activities.js"
import { registerTaskTools } from "./task-tools.js"
import type { TaskLedger } from "./task-ledger.js"
import {
  activityCounts,
  ACTIVITY_KINDS,
  ACTIVITY_SOURCES,
  ACTIVITY_STATES,
  type ActivityListFilter,
} from "./activity-projection.js"

/**
 * Zod schema for the `gate` field of `policy_attach`.
 * Exported so tests can validate the schema directly.
 *
 * Union of three variants:
 *   • shell  — `{ command, args?, cwd?, timeoutMs? }`
 *   • judge  — `{ judge: { adapter, model?, prompt, timeoutMs? } }` (WP7)
 *   • cost   — `{ costBudget: { maxCostUsd, window, scope }, sessionId? }` (phase 4)
 */
export const gateInputSchema = z.union([
  z.object({
    command: z.string().min(1).describe("Gate command basename (must be allowlisted)."),
    args: z.array(z.string()).optional().describe("Argv passed verbatim."),
    cwd: z.string().optional().describe("Working directory for the gate. Defaults to the session's cwd."),
    timeoutMs: z.number().int().positive().optional().describe("Gate timeout in ms. Default 60 000."),
  }),
  z.object({
    judge: z.object({
      adapter: z.string().min(1).describe("Agent adapter slug to spawn (e.g. \"claude-code\")."),
      model: z.string().optional().describe("Optional model identifier forwarded to the adapter."),
      prompt: z.string().min(1).describe("Rubric / instructions for the judge. The supervisor appends a VERDICT instruction."),
      timeoutMs: z.number().int().positive().optional().describe("Max wall-clock for the judge before kill + FAIL. Default 120 000."),
    }),
  }),
  z.object({
    costBudget: z.object({
      maxCostUsd: z.number().positive().describe("Windowed spend ceiling in USD — trips when priced windowed spend exceeds it."),
      window: z.string().min(1).describe("Rolling window spec (`parseWindow`: \"5h\"/\"7d\"/\"P7D\")."),
      scope: z.enum(["session", "profile"]).describe("Spend surface: the watched session, or every session on its auth profile."),
    }).describe(
      "Windowed cost-budget cap (phase 4). PASSES when the rolling windowed spend " +
        "is within the cap, FAILS (emits policy:failed) when over. Never kills the session.",
    ),
    sessionId: z.string().optional().describe("Session whose spend surface is summed. Defaults to the watched session."),
  }),
])

// ── Shared long-poll service functions ─────────────────────────────
//
// `monitorSessionWait` and `monitorPolicyWait` are the single source of
// truth for the blocking-wait semantics exposed by BOTH the MCP tool
// surface (`session_monitor`, `policy_status` fast-path) AND the REST
// HTTP surface (`GET /sessions/:id/wait`, `GET /policies/:id/wait`).
// Each MCP/REST handler is a thin adapter over these — no duplicated
// long-poll logic between the two transports.

/**
 * Event kind a session wait can target. Mirrors the `session_monitor`
 * `event` parameter. `turn-end` also matches `awaiting-input` (both
 * signal end-of-turn), matching the MCP tool's semantics.
 */
export type SessionWaitEvent = "turn-end" | "awaiting-input" | "exited" | "any"

/**
 * Result of a single-session wait. On a hit, carries the session id, the
 * matched event (ring-bus form, without the `session:` prefix), the
 * session's current status, and whether it's awaiting input. On a
 * timeout, `timedOut: true` and the watched id list.
 */
export interface SessionWaitResult {
  timedOut?: boolean
  sessionId?: string
  event?: string
  source?: "ring" | "state" | "bus"
  awaitingInput?: boolean
  status?: string
  turnsCompleted?: number
  sessionIds?: string[]
  since?: number
  /** Structured awaiting-input question (harness-parity). Surface on
   *  turn-end / awaiting-input matches so callers (MCP session_monitor +
   *  REST /sessions/:id/wait) can read the question without a separate
   *  transcript fetch. Mirrors desc.awaitingQuestion / ev.question. */
  question?: SessionAwaitingQuestion
  /** DERIVED interrupted-turn marker (§4): present and `true` when the watched
   *  session died with a turn in flight under a daemon restart and hasn't yet
   *  completed a fresh turn (`SessionDescriptor.interrupted`). Lets a
   *  supervisor tell a session that came back idle from one that came back with
   *  dropped work that was NOT re-run — the in-place resume never auto-retries.
   *  Absent (not `false`) when the session was not interrupted. */
  interrupted?: boolean
}

/**
 * `session_monitor`'s MCP response shape: `SessionWaitResult` plus an
 * optional `hint`, populated only on `timedOut: true` — the moment a
 * caller is polling this tool in a loop — pointing shell-capable callers
 * at the uncapped `agentproto sessions wait` CLI instead. Local to the MCP
 * tool handler; `monitorSessionWait`'s return type (shared with the REST
 * `GET /sessions/:id/wait` route) is unchanged.
 */
interface SessionMonitorResult extends SessionWaitResult {
  hint?: string
}

/**
 * Block until one of the listed sessions fires a matching lifecycle event
 * (turn-end / awaiting-input / exited / any), or until `timeoutMs` elapses.
 *
 * This is the single-session-capable core that the MCP `session_monitor`
 * tool and the REST `GET /sessions/:id/wait` route both call. The MCP tool
 * passes N ids (multiplexed fan-in); the REST route passes exactly one.
 * The semantics are identical: race-free cursor replay → synchronous
 * already-in-target-state check → bus long-poll → timeout.
 *
 * `since` is an EventRing cursor: when provided, already-emitted matching
 * events for the watched sessions that occurred after that cursor are
 * returned immediately (race-free replay) before subscribing to the bus.
 */
export async function monitorSessionWait(opts: {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  eventRing: EventRing
  sessionIds: string[]
  event?: SessionWaitEvent
  timeoutMs?: number
  since?: number
}): Promise<SessionWaitResult> {
  const {
    registry,
    sessionEvents,
    eventRing,
    sessionIds,
    timeoutMs = 25_000,
  } = opts
  const targetEvent: SessionWaitEvent = opts.event ?? "any"

  // Resolve id-or-name → canonical id (mirrors the MCP tool exactly).
  const resolvedIds = sessionIds.map(q => {
    const desc = registry.findByIdOrName(q)
    return desc?.id ?? q
  })

  // Race-free replay: if a cursor is provided, check the event ring for
  // already-emitted matching events before descriptor checks.
  if (opts.since !== undefined) {
    const ringResult = eventRing.since(opts.since, {
      sessionIds: resolvedIds,
    })
    const matchTypes: Set<string> =
      targetEvent === "any"
        ? new Set(["session:turn-end", "session:awaiting-input", "session:exited"])
        : targetEvent === "turn-end"
          ? new Set(["session:turn-end", "session:awaiting-input"])
          : targetEvent === "awaiting-input"
            ? new Set(["session:awaiting-input"])
            : new Set(["session:exited"])
    for (const ev of ringResult.events) {
      if (!matchTypes.has(ev.type)) continue
      // `ev.type` is one of the session:* literals filtered by `matchTypes`
      // above, but `Set.has` isn't a type guard — TS still sees the full
      // `SessionEvent` union (which now also includes sessionId-less
      // `cron:*` members, see session-event-bus.ts), so `sessionId` needs
      // a defensive cast here.
      const evWithSid = ev as { sessionId?: string; type: string }
      const question =
        ev.type === "session:turn-end" || ev.type === "session:awaiting-input"
          ? ev.question
          : undefined
      const replayDesc = evWithSid.sessionId
        ? registry.get(evWithSid.sessionId)
        : undefined
      return {
        sessionId: evWithSid.sessionId,
        event: ev.type.replace("session:", ""),
        source: "ring",
        since: opts.since,
        ...(question ? { question } : {}),
        ...(replayDesc?.interrupted ? { interrupted: true } : {}),
      }
    }
  }

  // Synchronous check: return immediately if a session is already in the
  // target state (same rules as the MCP tool — a fast session can finish
  // its turn before this wait subscribes).
  for (const sid of resolvedIds) {
    const desc = registry.get(sid)
    if (!desc) continue
    if (
      desc.awaitingInput &&
      (targetEvent === "any" || targetEvent === "turn-end" || targetEvent === "awaiting-input")
    ) {
      return {
        sessionId: sid,
        event: "awaiting-input",
        source: "state",
        awaitingInput: true,
        status: desc.status,
        ...(desc.awaitingQuestion ? { question: desc.awaitingQuestion } : {}),
        ...(desc.interrupted ? { interrupted: true } : {}),
      }
    }
    // Already-finished turn: turnsCompleted > 0 && !busy && running.
    if (
      (desc.turnsCompleted ?? 0) > 0 &&
      !desc.busy &&
      desc.status === "running" &&
      (targetEvent === "any" || targetEvent === "turn-end")
    ) {
      return {
        sessionId: sid,
        event: "turn-end",
        source: "state",
        awaitingInput: false,
        status: desc.status,
        turnsCompleted: desc.turnsCompleted,
        ...(desc.interrupted ? { interrupted: true } : {}),
      }
    }
    const terminal =
      desc.status === "exited" || desc.status === "killed" || desc.status === "error"
    if (terminal && (targetEvent === "any" || targetEvent === "exited")) {
      return {
        sessionId: sid,
        event: "exited",
        source: "state",
        awaitingInput: false,
        status: desc.status,
        ...(desc.interrupted ? { interrupted: true } : {}),
      }
    }
  }

  // Long-poll: subscribe to the bus, resolve on the first matching event.
  return new Promise<SessionWaitResult>(resolve => {
    const unsubs: Array<() => void> = []
    let settled = false

    const finish = (result: SessionWaitResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const u of unsubs) u()
      resolve(result)
    }

    const relevantTypes: SessionEventType[] =
      targetEvent === "any"
        ? ["session:turn-end", "session:awaiting-input", "session:exited"]
        : targetEvent === "turn-end"
          ? ["session:turn-end", "session:awaiting-input"]
          : targetEvent === "awaiting-input"
            ? ["session:awaiting-input"]
            : ["session:exited"]

    const idSet = new Set(resolvedIds)

    for (const evType of relevantTypes) {
      unsubs.push(
        sessionEvents.on(evType, ev => {
          // Same defensive cast as the ring-replay branch above — `evType`
          // is only known to be one of the session:* literals at the
          // call-site, not narrowed by `on`'s signature, so `ev` is still
          // typed as the full (now cron:*-inclusive) SessionEvent union.
          const sessionId = (ev as { sessionId?: string }).sessionId
          if (!sessionId || !idSet.has(sessionId)) return
          const desc = registry.get(sessionId)
          finish({
            sessionId,
            event: ev.type.replace("session:", ""),
            source: "bus",
            awaitingInput: desc?.awaitingInput ?? false,
            status: desc?.status ?? "unknown",
            ...(desc?.awaitingQuestion ? { question: desc.awaitingQuestion } : {}),
            ...(desc?.interrupted ? { interrupted: true } : {}),
          })
        }),
      )
    }

    const timer = setTimeout(() => {
      finish({ timedOut: true, sessionIds: resolvedIds })
    }, timeoutMs)
  })
}

/**
 * Block until the named policy's status transitions out of the active
 * `watching` / `queued` / `gating` / `nudging` states — i.e. reaches
 * `done`, `blocked`, `awaiting-ack`, or `cancelled` — then return the
 * full PolicyRunState. Returns `{ timedOut: true }` on timeout.
 *
 * Hooks into the supervisor's `onSettle` callback (the single reliable
 * signal — some terminal transitions like `cancel()` / `ack(false)` /
 * single-session-exit emit no SessionEventBus event). The MCP
 * `policy_status` tool and the REST `GET /policies/:id/wait` route both
 * delegate here, so the wait semantics are shared across transports.
 */
export async function monitorPolicyWait(opts: {
  supervisor: CompletionPolicySupervisor
  policyId: string
  timeoutMs?: number
}): Promise<{ timedOut: true } | { timedOut: false; state: PolicyRunState }> {
  const { supervisor, policyId, timeoutMs = 25_000 } = opts

  // Fast path: already settled (done / blocked / cancelled / awaiting-ack).
  const initial = supervisor.getStatus(policyId)
  if (!initial) {
    return { timedOut: false, state: undefined as unknown as PolicyRunState }
  }
  const isSettledStatus = (s: string): boolean =>
    s === "done" || s === "blocked" || s === "cancelled" || s === "awaiting-ack"
  if (isSettledStatus(initial.status)) {
    return { timedOut: false, state: initial }
  }

  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      unsub()
      resolve({ timedOut: true })
    }, timeoutMs)

    const unsub = supervisor.onSettle(id => {
      if (id !== policyId) return
      const state = supervisor.getStatus(policyId)
      if (!state || !isSettledStatus(state.status)) return
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsub()
      resolve({ timedOut: false, state })
    })
  })
}

export interface RegisterOrchestrationToolsOptions {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  eventRing: EventRing
  workflowRunner?: WorkflowRunner
  supervisor?: CompletionPolicySupervisor
  /** When wired, exposes start/stop/list_inbound_watcher tools. */
  inboundWatcher?: InboundWatcher
  /**
   * When wired, exposes cron_create / cron_list / cron_delete / cron_run
   * tools. NOT added to DEFAULT_ORCHESTRATOR_TOOLS — this installs
   * persistent host-level recurring jobs (bigger privilege than session/
   * policy tools). Opt-in via explicit orchestrator.tools allowlist only.
   */
  cronScheduler?: CronScheduler
  /**
   * When wired, exposes `routine_trigger` and `routine_reconcile` — fires
   * an AIP-41 `.routines/<id>/ROUTINE.md` routine's target immediately,
   * bypassing its schedule (mirrors `cron_run`), and re-scans
   * `.routines/*` to register/update/remove live cron jobs on demand
   * (mirrors `reconcile()`'s boot-time pass — installs host cron jobs, so
   * like `cronScheduler` above, NOT added to `DEFAULT_ORCHESTRATOR_TOOLS`).
   */
  routineRegistrar?: RoutineRegistrar
  /**
   * When wired, exposes the `activities_list` tool — the unified Activity
   * read-model over policies / turns / routine & workflow steps / opened
   * PRs (`activities.ts`). Same projector instance `GET /activities` reads.
   */
  activityProjector?: ActivityProjector
  /**
   * When wired, backs the `task_create` / `task_list` / `task_claim` /
   * `task_update` tools (`task-tools.ts`) — the multi-party Task ledger.
   * The four names live in DEFAULT_ORCHESTRATOR_TOOLS, so like the policy
   * tools they are registered unconditionally and answer a structured
   * error when the ledger is absent (a subset-declared-but-unregistered
   * tool hangs the MCP handshake). Same ledger instance the `/tasks`
   * routes mutate.
   */
  taskLedger?: TaskLedger
  /** Optional allowlist — when set, only tools whose name is in the
   *  set are registered (the scoped orchestrator sub-gateway, WP2).
   *  Omitted → register everything, today's behaviour. */
  toolSubset?: ReadonlySet<string>
  /**
   * When set, this is the calling orchestrator's scope (WP6 supervisor
   * composition). Enables subtree-scoped policy operations:
   *   - policy_attach may only target sessions in the caller's subtree
   *   - then:"commit" is refused (host commit is an operator gesture)
   *   - policy_status / policy_list / policy_cancel only see
   *     policies whose watched sessions are all within the caller's subtree
   * Absent → operator/root context, no additional restrictions.
   */
  callerScope?: { ownerSessionId?: string }
  /**
   * When wired alongside `bindingStore`, exposes the `transmit_message`
   * tool — sends a message out via an imported agentpush alias and
   * (optionally) binds the contact to a session for inbound routing.
   */
  mcpProxy?: McpProxyRegistry
  /** Paired with `mcpProxy` above — see `transmit_message`. */
  bindingStore?: TransmitterBindingStore
  /**
   * When wired alongside `bindingStore`, exposes the `inbound_endpoint_create`
   * / `list` / `delete` tools. Each endpoint maps `POST /inbound/<slug>` to a
   * provider dialect (agentpush, telegram, whatsapp, slack, generic) plus a
   * secret for webhook signature verification.
   */
  endpointStore?: InboundEndpointStore
}

export function registerOrchestrationTools(
  rawServer: McpServer,
  opts: RegisterOrchestrationToolsOptions,
): void {
  // When a subset is requested, every `server.tool(...)` below is
  // filtered through this one guard (ADR §4.2). No subset → raw server.
  const server = opts.toolSubset
    ? withToolSubset(rawServer, opts.toolSubset)
    : rawServer
  const { registry, sessionEvents, eventRing, callerScope, inboundWatcher, mcpProxy, bindingStore, endpointStore } = opts

  /**
   * WP6: check whether ALL watched sessions of a policy fall within the
   * subtree rooted at `ownerId`. Rebuilds the subtree from the live
   * registry on each call so newly-spawned children are visible without
   * any explicit invalidation. The subtree is tiny and the build is O(n)
   * over all sessions — cheap relative to any surrounding I/O.
   */
  const isPolicyInSubtree = (policy: PolicyRunState, ownerId: string): boolean => {
    // includeArchived: true — an archived ancestor must not sever the
    // parent→child graph collectSubtree's BFS walks (see session_list's
    // docblock in session-tools.ts).
    const subtree = collectSubtree(ownerId, registry.list({ includeArchived: true }))
    const ids = policy.sessionIds.length > 0 ? policy.sessionIds : [policy.sessionId]
    return ids.every(id => subtree.has(id))
  }

  // ── session_events_poll ───────────────────────────────────────────
  server.tool(
    "session_events_poll",
    "Lightweight cursor-based snapshot of session lifecycle events " +
      "(turn-end, awaiting-input, exited). Returns only what changed since " +
      "the last call — cheap, no transcript. Use `session_monitor` to block " +
      "efficiently; use this for a quick status sweep between other work.",
    {
      since: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Opaque cursor from a prior call's `nextCursor`. Omit (or pass 0) " +
            "to start from the current tail — returns events emitted after this call.",
        ),
      sessionIds: z
        .array(z.string())
        .optional()
        .describe("Filter to these session ids. Omit → all sessions."),
      types: z
        .array(z.enum(["turn-end", "awaiting-input", "permission-request", "permission-resolved", "exited", "session:spawned", "command-done", "policy:passed", "policy:failed", "policy:commit-ready", "policy:committed", "cron:fired", "cron:succeeded", "cron:failed", "activity:changed", "task:changed"]))
        .optional()
        .describe("Filter to these event types. Omit → all types."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max events to return. Default 50."),
    },
    async input => {
      const cursor = input.since ?? eventRing.since(0).nextCursor
      const { events, nextCursor } = eventRing.since(cursor, {
        sessionIds: input.sessionIds,
        types: input.types as SessionEventType[] | undefined,
        limit: input.limit,
      })
      return {
        content: [
          { type: "text", text: JSON.stringify({ events, nextCursor }, null, 2) },
        ],
      }
    },
  )

  // ── Permission inbox tools ─────────────────────────────────────────
  //
  // Cross-session inbox for permission-hold sessions: each ACP permission
  // request is surfaced + parked (see the pending-permissions registry in
  // sessions.ts) rather than auto-answered, so a human/orchestrator can
  // approve/deny it from one place. Mirrors `policy_ack`'s approve/deny shape.

  /** True when a session is inside the caller's subtree (WP6 scoping). Root/
   *  operator callers (no scope) see every session. */
  const isSessionInScope = (sessionId: string): boolean => {
    if (!callerScope) return true
    if (!callerScope.ownerSessionId) return false
    // includeArchived: true — see isPolicyInSubtree's comment above.
    return collectSubtree(
      callerScope.ownerSessionId,
      registry.list({ includeArchived: true }),
    ).has(sessionId)
  }

  const enrichPermission = (
    p: ReturnType<SessionsRegistry["listPendingPermissions"]>[number],
  ): Record<string, unknown> => {
    const desc = registry.get(p.sessionId)
    const ageMs = Date.now() - new Date(p.requestedAt).getTime()
    return {
      ...p,
      ...(desc?.adapterSlug ? { adapter: desc.adapterSlug } : {}),
      ...(desc?.label ? { sessionLabel: desc.label } : {}),
      ...(desc?.command ? { sessionTitle: desc.command } : {}),
      ageMs: ageMs >= 0 ? ageMs : 0,
    }
  }

  server.tool(
    "permissions_list",
    "List permission requests currently HELD across all permission-hold " +
      "sessions (spawned with `permissionHold`). Each entry: id, sessionId, " +
      "session adapter/title, the tool being requested, its raw input when " +
      "the driver supplied one (e.g. a Bash tool's command string, " +
      "harness-shaped — don't assume a stable schema), the offered options, " +
      "and age. Resolve one with `permissions_respond`. Optionally filter by " +
      "`sessionId`. Empty list = nothing is waiting on a decision.",
    {
      sessionId: z
        .string()
        .optional()
        .describe("Filter to one session's pending permissions. Omit → all sessions."),
    },
    async input => {
      const pending = registry
        .listPendingPermissions(input.sessionId ? { sessionId: input.sessionId } : undefined)
        .filter(p => isSessionInScope(p.sessionId))
        .map(enrichPermission)
      return {
        content: [{ type: "text", text: JSON.stringify({ permissions: pending }, null, 2) }],
      }
    },
  )

  server.tool(
    "permissions_respond",
    "Resolve a permission request parked by a permission-hold session " +
      "(see `permissions_list`). `decision:\"approve\"` selects an allow " +
      "option (allow-always when `scope:\"always\"` is offered, else " +
      "allow-once); `decision:\"deny\"` selects a reject option (or cancels " +
      "the request when none is offered). An explicit `optionId` overrides " +
      "the decision→option mapping. Errors clearly on an unknown/already-" +
      "resolved id. The agent's turn unblocks with the chosen outcome.",
    {
      id: z.string().describe("Pending permission id from `permissions_list`."),
      decision: z
        .enum(["approve", "deny"])
        .describe("approve → an allow option; deny → a reject option / cancel."),
      optionId: z
        .string()
        .optional()
        .describe("Explicit offered optionId — wins over `decision` mapping."),
      scope: z
        .enum(["once", "always"])
        .optional()
        .describe("For approve: prefer allow-always when the request offers it."),
    },
    async input => {
      // WP6 scoping: a scoped child may only resolve permissions for sessions
      // in its own subtree. Report "not found" for anything out of scope (no
      // information leak about a sibling's pending requests).
      const pending = registry.listPendingPermissions().find(p => p.id === input.id)
      if (!pending || !isSessionInScope(pending.sessionId)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "not_found", message: `no pending permission "${input.id}"` }),
            },
          ],
          isError: true,
        }
      }
      const result = await registry.respondPermission(input.id, {
        decision: input.decision,
        ...(input.optionId ? { optionId: input.optionId } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
      })
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error, message: result.message }) }],
          isError: true,
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                id: input.id,
                sessionId: result.permission.sessionId,
                decision: result.decision,
                ...(result.optionId ? { optionId: result.optionId } : {}),
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // ── Workflow tools (optional — only registered when workflowRunner is provided) ─
  // A workflow is an ordered list of STAGES,
  // each stage a group of steps that run in parallel with an explicit
  // barrier before the next stage starts.
  const { workflowRunner } = opts
  if (workflowRunner) {
    const workflowStepSchema = z.object({
      label: z.string(),
      adapter: z.string().optional().describe("Agent adapter slug to spawn a NEW session for this step."),
      prompt: z.string().optional().describe("Prompt to send after spawning/reusing a session."),
      sessionRef: z
        .string()
        .optional()
        .describe(
          "Reuse the session spawned by an earlier step (any prior stage), by that step's `label`. " +
            "Ignored if `adapter` is set. Lets a later-stage step act on an earlier stage's output " +
            "(e.g. a 'verify' step reusing a 'produce' step's session).",
        ),
      cacheable: z.boolean().optional().describe("Cache this step's output under the run's cacheKey (opt-in; for idempotent/pure steps only)."),
      sandbox: z
        .union([
          z
            .string()
            .min(1)
            .describe("Sandbox provider slug from `list_sandbox_providers` (e.g. 'local', 'e2b')."),
          z
            .object({ provider: z.string().min(1) })
            .passthrough()
            .describe("Inline AIP-36 SandboxSpec ({ provider, config?, env?, … })."),
        ])
        .optional()
        .describe(
          "Run this step's session inside a sandbox instead of on the host — " +
            "same semantics as `agent_start.sandbox`. Only meaningful with `adapter`.",
        ),
      policy: z
        .discriminatedUnion("awaiting", [
          z.object({ awaiting: z.literal("auto-allow"), prompt: z.string() }),
          z.object({
            awaiting: z.literal("escalate"),
            webhookUrl: z.string().url().optional(),
            timeoutMs: z.number().int().positive().optional(),
          }),
          z.object({ awaiting: z.literal("fail") }),
        ])
        .optional()
        .describe("What to do when this step's session asks for input mid-stage."),
    })

    server.tool(
      "workflow_start",
      "Start a workflow — an ordered list of STAGES, each stage a group of steps " +
        "that spawn/reuse agent sessions and run CONCURRENTLY. An explicit barrier " +
        "gates entry into the next stage: stage N+1 does not start until every step " +
        "of stage N has finished (or failed). Returns a runId immediately; the " +
        "workflow executes in the background. Poll with `workflow_status`.",
      {
        workflowId: z.string().describe("Arbitrary label for this workflow type (e.g. 'review-then-fix')."),
        stages: z
          .array(
            z.object({
              label: z.string().optional().describe("Optional label for this stage."),
              steps: z.array(workflowStepSchema).min(1).describe("Steps in this stage — all run in parallel."),
            }),
          )
          .min(1)
          .max(20)
          .describe("Ordered list of stages. Each stage's steps run concurrently; stages run sequentially."),
        workspaceSlug: z.string().optional().describe("Workspace slug passed to each spawned session."),
        cwd: z.string().optional().describe("Working directory for spawned sessions."),
        notifyUrl: z.string().url().optional().describe("Webhook URL to call on run completion or escalation."),
        cacheKey: z.string().optional().describe("Enable journal caching for this run. On a re-invocation with the same cacheKey, cacheable steps whose inputs are unchanged replay their cached output instead of re-spawning."),
      },
      async input => {
        const run = await workflowRunner.start(input)
        return {
          content: [{ type: "text", text: JSON.stringify({ runId: run.runId, status: run.status }, null, 2) }],
        }
      },
    )

    server.tool(
      "workflow_run_file",
      "Load an AIP-15 WORKFLOW.md (+ optional entry.mjs) via the workflow-loader " +
        "and run it in the background through the same runner as `workflow_start`. " +
        "Poll with `workflow_status`.",
      {
        path: z.string().describe("Absolute or workspace-relative path to a WORKFLOW.md file."),
        input: z.record(z.string(), z.unknown()).optional().describe("Workflow invocation input — bound to `$input` in the compiled workflow."),
        cwd: z.string().optional().describe("Working directory for spawned sessions."),
        workspaceSlug: z.string().optional().describe("Workspace slug passed to each spawned session."),
        cacheKey: z.string().optional().describe("Enable journal caching for this run. Cacheable steps replay unchanged outputs on re-invocation with the same key."),
      },
      async input => {
        try {
          const run = await workflowRunner.startFromFile(input)
          return {
            content: [{ type: "text", text: JSON.stringify({ runId: run.runId, status: run.status }, null, 2) }],
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              },
            ],
            isError: true,
          }
        }
      },
    )

    server.tool(
      "workflow_status",
      "Poll the status of a background workflow run started with `workflow_start`. " +
        "Each stage reports its steps' status/sessionId so later work can inspect " +
        "what an earlier stage produced (e.g. via `agent_output` on that sessionId).",
      {
        runId: z.string().describe("Run id returned by `workflow_start`."),
      },
      async input => {
        const run = workflowRunner.status(input.runId)
        if (!run) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "run not found", runId: input.runId }) }],
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(run, null, 2) }] }
      },
    )

    server.tool(
      "workflow_cancel",
      "Cancel a running workflow. Steps already in flight will finish, but no " +
        "new stages will be started.",
      {
        runId: z.string().describe("Run id to cancel."),
      },
      async input => {
        workflowRunner.cancel(input.runId)
        const run = workflowRunner.status(input.runId)
        return { content: [{ type: "text", text: JSON.stringify({ runId: input.runId, status: run?.status ?? "not_found" }) }] }
      },
    )

    server.tool(
      "workflow_escalation_resolve",
      "Provide an external answer to a workflow step that escalated because a " +
        "session asked for human input (policy=escalate).",
      {
        runId: z.string().describe("Run id."),
        stageIndex: z.number().int().min(0).describe("Stage index containing the escalated step (0-based)."),
        stepIndex: z.number().int().min(0).describe("Step index within the stage to resolve (0-based)."),
        response: z.string().describe("The answer to inject into the awaiting session."),
      },
      async input => {
        workflowRunner.resolve(input.runId, input.stageIndex, input.stepIndex, input.response)
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }
      },
    )

    server.tool(
      "workflow_list",
      "List all workflow runs (running, done, failed, cancelled).",
      {},
      async () => {
        const runs = workflowRunner.list()
        return { content: [{ type: "text", text: JSON.stringify(runs, null, 2) }] }
      },
    )
  }

  // ── Supervisor tools ─────────────────────────────────────────────────────────
  // policy_attach / policy_status / policy_list / policy_cancel are
  // registered UNCONDITIONALLY because they appear in DEFAULT_ORCHESTRATOR_TOOLS
  // and therefore in every scoped subset. A tool declared in the subset but not
  // registered on the server causes the MCP handshake to hang indefinitely
  // (empirically verified). When no supervisor is wired the handlers return a
  // structured error instead of a live result — clean fail, no hang.
  const { supervisor } = opts

  // Base shape of a completion policy (shared by policy_attach and, via
  // z.lazy, the recursive `next` DAG chain — WP6).
  {
    const policyShapeBase = {
      sessionId: z
        .string()
        .optional()
        .describe(
          "Session id to watch (single-session form). Provide this OR " +
            "`sessionIds`. Equivalent to `sessionIds: [sessionId]`.",
        ),
      sessionIds: jsonTolerant(
        z.array(z.string()).min(1),
      )
        .optional()
        .describe(
          "Fan-in group: the gate runs once, only after EVERY listed session " +
            "has finished its turn (turn-end or exit). Supersedes `sessionId`.",
        ),
      gate: jsonTolerant(gateInputSchema)
        .optional()
        .describe(
          "Gate: shell (exit 0 = pass) or judge-agent (WP7 — `{ judge: { adapter, prompt } }`). " +
            "Absent → always passes immediately after turn-end.",
        ),
      then: z
        .enum(["emit", "commit"])
        .describe(
          "Action on a GREEN gate. 'emit' → emits policy:passed. 'commit' → " +
            "stages the explicit `commit.paths` and commits on the host " +
            "(requires `commit`; git must be allowlisted).",
        ),
      commit: jsonTolerant(
        z.object({
          paths: z
            .array(z.string().min(1))
            .min(1)
            .describe(
              "Explicit literal paths to stage (workspace-relative). Staged " +
                "via `git add -- <paths>` — never `-A`, never a glob.",
            ),
          message: z.string().min(1).describe("Commit message (passed as argv, no shell)."),
          requireHumanAck: z
            .boolean()
            .optional()
            .describe(
              "Default TRUE. When true, the green gate parks in awaiting-ack " +
                "and emits policy:commit-ready; the commit runs only on " +
                "policy_ack(approve:true). When false, commits directly. " +
                "Never pushes, never --force.",
            ),
        }),
      )
        .optional()
        .describe("Required when then === 'commit' (WP5)."),
      onFail: jsonTolerant(
        z.object({
          nudge: z
            .string()
            .optional()
            .describe(
              "Message sent to the session when the gate fails. " +
                "Use {code} as a placeholder for the exit code. " +
                "Default: built-in message in French.",
            ),
          maxRetries: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe(
              "Maximum consecutive gate failures before blocking. Default: 2.",
            ),
        }),
      )
        .optional()
        .describe(
          "What to do when the gate fails (WP2). Absent → immediately blocked. " +
            "Present → re-prompt the session up to maxRetries times then block. " +
            "The session must still be running to receive a nudge.",
        ),
    }

    // WP6: a policy may declare `next` — a full (recursive) completion policy
    // attached automatically when this policy reaches `done`. Chains over
    // already-running sessions named in the child's own spec.
    const policyInputSchema: z.ZodTypeAny = z.lazy(() =>
      z.object({
        ...policyShapeBase,
        next: jsonTolerant(policyInputSchema).optional(),
      }),
    )
    const nextField = {
      next: jsonTolerant(policyInputSchema)
        .optional()
        .describe(
          "DAG chaining (WP6): a full completion policy (recursive) attached " +
            "automatically when THIS policy reaches done. It watches the " +
            "session(s) named in its own spec. Chains policies over existing " +
            "sessions — does not spawn new sessions.",
        ),
    }

    server.tool(
      "policy_attach",
      "Attach a completion policy to a running session (or a fan-in group). When " +
        "the watched session emits turn-end — or, for a group, once EVERY member " +
        "has finished its turn — an optional shell gate runs (exit 0 = pass). The " +
        "result is emitted as `policy:passed` or `policy:failed` on the event bus " +
        "(readable via session_events_poll). A policy may declare `next` to chain another " +
        "policy when it completes (WP6 DAG). Returns the policyId immediately.",
      {
        ...policyShapeBase,
        ...nextField,
      },
      async input => {
        if (!supervisor) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "supervisor not available" }) }] }
        }
        if (!input.sessionId && !(input.sessionIds && input.sessionIds.length > 0)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "policy_attach requires sessionId or a non-empty sessionIds" }),
              },
            ],
          }
        }
        if (input.then === "commit" && !input.commit) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: 'then:"commit" requires a commit spec' }),
              },
            ],
          }
        }
        // WP6 scoping: a child orchestrator may only attach policies on
        // sessions within its own subtree, and may not request a commit
        // action (host commits are an operator/human gesture).
        if (callerScope) {
          if (input.then === "commit") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: 'then:"commit" is not permitted from a child orchestrator scope; use then:"emit" and let the operator or human ack the commit',
                  }),
                },
              ],
            }
          }
          if (!callerScope.ownerSessionId) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ error: "scope is not yet bound to a session; cannot attach policy" }),
                },
              ],
            }
          }
          const targetIds =
            input.sessionIds && input.sessionIds.length > 0
              ? input.sessionIds
              : input.sessionId
                ? [input.sessionId]
                : []
          // includeArchived: true — see isPolicyInSubtree's comment above.
          const subtree = collectSubtree(
            callerScope.ownerSessionId,
            registry.list({ includeArchived: true }),
          )
          const outside = targetIds.filter(id => !subtree.has(id))
          if (outside.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: `policy_attach denied: sessions not in caller subtree: ${outside.join(", ")}`,
                    forbidden: outside,
                  }),
                },
              ],
            }
          }
        }
        try {
          const state = supervisor.attach({
            sessionId: input.sessionId,
            sessionIds: input.sessionIds,
            gate: input.gate,
            then: input.then,
            commit: input.commit,
            onFail: input.onFail,
            next: input.next as AttachPolicyInput["next"],
          })
          return {
            content: [{ type: "text", text: JSON.stringify({ policyId: state.policyId, status: state.status }, null, 2) }],
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              },
            ],
          }
        }
      },
    )

    server.tool(
      "policy_status",
      "Get the current status of a completion policy attached with `policy_attach`. " +
        "Includes `awaitingQuestions` for any watched session currently blocked on " +
        "input, so a caller can distinguish \"still legitimately running\" from " +
        "\"stuck, needs a human/orchestrator answer\" without a separate call.",
      {
        policyId: z.string().describe("Policy id returned by `policy_attach`."),
      },
      async input => {
        if (!supervisor) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "supervisor not available" }) }] }
        }
        const state = supervisor.getStatus(input.policyId)
        if (!state) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "policy not found", policyId: input.policyId }) }],
          }
        }
        // WP6 scoping: only reveal policies whose watched sessions are all
        // within the caller's subtree. Return "not found" for out-of-scope
        // policies (no information leak about existence).
        if (callerScope) {
          if (!callerScope.ownerSessionId || !isPolicyInSubtree(state, callerScope.ownerSessionId)) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: "policy not found", policyId: input.policyId }) }],
            }
          }
        }
        // Read-only enrichment: cross-reference the watched sessions' live
        // awaitingQuestion (set by sessions.ts, structured or heuristic) —
        // does not touch the policy state machine itself.
        const awaitingQuestions = state.sessionIds
          .map(id => ({ sessionId: id, desc: registry.get(id) }))
          .filter((s): s is { sessionId: string; desc: NonNullable<ReturnType<typeof registry.get>> } => !!s.desc?.awaitingInput)
          .map(s => ({ sessionId: s.sessionId, question: s.desc.awaitingQuestion }))
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                awaitingQuestions.length > 0 ? { ...state, awaitingQuestions } : state,
                null,
                2,
              ),
            },
          ],
        }
      },
    )

    server.tool(
      "policy_cancel",
      "Cancel a watching or gating completion policy. No-op on done/blocked policies.",
      {
        policyId: z.string().describe("Policy id to cancel."),
      },
      async input => {
        if (!supervisor) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "supervisor not available" }) }] }
        }
        // WP6 scoping: a child may only cancel policies on its own subtree.
        if (callerScope) {
          const state = supervisor.getStatus(input.policyId)
          if (!state || !callerScope.ownerSessionId || !isPolicyInSubtree(state, callerScope.ownerSessionId)) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: "policy_cancel denied: policy not found or outside caller subtree", policyId: input.policyId }) }],
            }
          }
        }
        supervisor.cancel(input.policyId)
        const state = supervisor.getStatus(input.policyId)
        return {
          content: [{ type: "text", text: JSON.stringify({ policyId: input.policyId, status: state?.status ?? "not_found" }) }],
        }
      },
    )

    // policy_ack is intentionally absent from DEFAULT_ORCHESTRATOR_TOOLS (host
    // commits are an operator gesture, not a child-orchestrator one — WP6).
    // Register it only when a supervisor is present, consistent with the
    // declared ≡ registered invariant.
    if (supervisor) {
    server.tool(
      "policy_ack",
      "Acknowledge a `then:\"commit\"` policy parked in `awaiting-ack` (WP5). " +
        "`approve:true` runs the prepared host commit (git add <paths> + git " +
        "commit; never -A/push/--force) → emits policy:committed (+sha) → done. " +
        "`approve:false` cancels it (no commit). No-op on any other state.",
      {
        policyId: z.string().describe("Policy id returned by `policy_attach`."),
        approve: z
          .boolean()
          .describe("true → run the commit; false → cancel without committing."),
      },
      async input => {
        const state = await supervisor.ack(input.policyId, input.approve)
        if (!state) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "policy not found", policyId: input.policyId }) }],
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  policyId: state.policyId,
                  status: state.status,
                  ...(state.commitSha ? { sha: state.commitSha } : {}),
                  ...(state.error ? { error: state.error } : {}),
                },
                null,
                2,
              ),
            },
          ],
        }
      },
    )
    } // end if (supervisor) for policy_ack

    server.tool(
      "policy_list",
      "List completion policies (watching, gating, done, blocked, cancelled). " +
        "Pass `sessionId` to answer the reverse question — which policies are " +
        "attached to this session — instead of scanning the whole list.",
      {
        sessionId: z
          .string()
          .optional()
          .describe(
            "Only list policies watching this session — matches its single " +
              "`sessionId` or any member of its fan-in `sessionIds` group. " +
              "Omit to list everything in scope.",
          ),
      },
      async input => {
        if (!supervisor) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "supervisor not available" }) }] }
        }
        let policies = supervisor.list()
        // WP6 scoping: a child orchestrator only sees policies whose watched
        // sessions are all within its own subtree. An unbound scope (no
        // ownerSessionId yet) sees nothing — safe default.
        if (callerScope) {
          if (!callerScope.ownerSessionId) {
            policies = []
          } else {
            const ownerId = callerScope.ownerSessionId
            policies = policies.filter(p => isPolicyInSubtree(p, ownerId))
          }
        }
        // Narrowing only, and applied AFTER the subtree scoping above — the
        // filter never widens what a scoped caller can see.
        if (input.sessionId !== undefined) {
          const wanted = input.sessionId
          policies = policies.filter(p => policyWatchesSession(p, wanted))
        }
        return { content: [{ type: "text", text: JSON.stringify(policies, null, 2) }] }
      },
    )
  }

  // ── Task ledger tools (task_create / task_list / task_claim / task_update) ─
  // Registered UNCONDITIONALLY — the four names are in
  // DEFAULT_ORCHESTRATOR_TOOLS, so like the policy tools above they must
  // exist on every scoped subset or the MCP handshake hangs; without a
  // ledger they answer a structured error. `server` is already
  // subset-wrapped here, so the scope's allowlist applies; the caller's
  // scope identity drives ACL + the default board inside task-tools.ts.
  registerTaskTools(server, {
    ...(opts.taskLedger ? { ledger: opts.taskLedger } : {}),
    ...(callerScope ? { callerScope } : {}),
  })

  // ── activities_list (optional — only when an activity projector is wired) ─
  //
  // The unified Activity read-model (activity-projection.ts / activities.ts):
  // one flat list of `active` vs `pending` (vs terminal) records across
  // completion policies, in-flight turns, routine/workflow steps, and opened
  // PRs. Recomputed from the owners on every call — a projection, never a
  // registry. Mirrors `GET /activities` (same projector, same filter, same
  // shape).
  const { activityProjector } = opts
  if (activityProjector) {
    server.tool(
      "activities_list",
      "List activities — the unified read-model of what is ACTIVE (the daemon " +
        "is consuming compute now) vs PENDING (blocked on an external signal: " +
        "another session's turn, a human ack, a forge, a cap slot) across " +
        "completion policies, session turns, routine/workflow steps, and " +
        "opened PRs. Each pending record carries `waitingOn` naming the " +
        "blocker. Default non-terminal; pass `includeTerminal` (or a terminal " +
        "`state` filter) for done/failed/cancelled records. Subscribe to " +
        "`activity:changed` via `session_events_poll` for live transitions.",
      {
        sessionId: z
          .string()
          .optional()
          .describe(
            "Only activities on this session — matches a record's `sessionId` " +
              "or any member of its fan-in `sessionIds`. Omit for all sessions.",
          ),
        state: z
          .enum(ACTIVITY_STATES)
          .optional()
          .describe("Filter to one state. A terminal state implies `includeTerminal`."),
        kind: z.enum(ACTIVITY_KINDS).optional().describe("Filter to one activity kind."),
        source: z
          .enum(ACTIVITY_SOURCES)
          .optional()
          .describe("Filter to one owning subsystem."),
        includeTerminal: z
          .boolean()
          .optional()
          .describe("Include done/failed/cancelled records. Default false."),
      },
      async input => {
        const filter: ActivityListFilter = {
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          ...(input.state !== undefined ? { state: input.state } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.includeTerminal !== undefined
            ? { includeTerminal: input.includeTerminal }
            : {}),
        }
        const activities = activityProjector.list(filter)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { activities, counts: activityCounts(activities) },
                null,
                2,
              ),
            },
          ],
        }
      },
    )
  }

  // ── session_monitor ──────────────────────────────────────────────
  server.tool(
    "session_monitor",
    "Multiplexed long-poll: block until ANY of the listed sessions fires a " +
      "lifecycle event. Returns immediately when a session is already in the " +
      "target state. Eliminates polling in multi-session fan-in orchestration — " +
      "one call replaces N concurrent waitForTurnEnd calls. " +
      "If you have shell access, prefer `agentproto sessions wait <id> " +
      "[--until <event>]` instead of polling this tool in a loop — it's a " +
      "scriptable blocking wait with no 49s cap. (No shell? Keep using this tool.)",
    {
      // Accept the natural shapes an agent already has on hand: a single id
      // (the `id` agent_start returns, or `sessionId` from the drive tools),
      // or the fan-in array. `sessionIds` additionally tolerates a bare
      // string (not just an array) so a one-session monitor doesn't force
      // array-wrapping. All three coalesce into the watched-id list below.
      sessionIds: jsonTolerant(z.union([z.string(), z.array(z.string())]))
        .optional()
        .describe(
          "Session ids (or names) to watch — an array for fan-in, or a single " +
            "id. Returns on the first hit. Provide this OR `sessionId`/`id`.",
        ),
      sessionId: z
        .string()
        .optional()
        .describe("Single session id/name — singular alias for `sessionIds`."),
      id: z
        .string()
        .optional()
        .describe("Alias for `sessionId` — the `id` returned by agent_start."),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(49_000)
        .optional()
        .describe("Max wait in ms. Default 25 000. Stays under MCP request timeout."),
      event: z
        .enum(["turn-end", "awaiting-input", "exited", "any"])
        .optional()
        .describe(
          "Event type to wait for. Default 'any'. 'turn-end' also matches " +
            "'awaiting-input' (both signal end-of-turn).",
        ),
      since: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Event-ring cursor (from a prior session_events_poll nextCursor). When set, an already-emitted matching event for a watched session is returned immediately — race-free — before long-polling."
        ),
    },
    async input => {
      const timeout = input.timeoutMs ?? 25_000
      const targetEvent = input.event ?? "any"

      // Coalesce the accepted arg shapes into the watched-id list.
      const fromSessionIds =
        input.sessionIds === undefined
          ? []
          : Array.isArray(input.sessionIds)
            ? input.sessionIds
            : [input.sessionIds]
      const singular = input.sessionId ?? input.id
      const sessionIds = [...fromSessionIds, ...(singular ? [singular] : [])]
      if (sessionIds.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "session_monitor: no sessions to watch — pass `sessionIds` (array or single id) or `sessionId`/`id`.",
              }),
            },
          ],
          isError: true,
        }
      }
      if (sessionIds.length > 20) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `session_monitor: too many sessions (${sessionIds.length}); max 20 per call.`,
              }),
            },
          ],
          isError: true,
        }
      }

      const result = await monitorSessionWait({
        registry,
        sessionEvents,
        eventRing,
        sessionIds,
        event: targetEvent,
        timeoutMs: timeout,
        ...(input.since !== undefined ? { since: input.since } : {}),
      })

      // The MCP tool's contract: a ring-replay hit echoes back the cursor
      // (so callers can chain); the state/bus hit returns the event shape.
      // monitorSessionWait returns the same fields — forward verbatim,
      // including the `question` field (harness-parity) when present.
      const payload: SessionMonitorResult = { ...result }
      if (result.source === "ring" && input.since !== undefined) {
        payload.since = input.since
      }
      // A timeout is exactly the moment a polling loop is grinding away —
      // nudge shell-capable callers toward the uncapped CLI wait right when
      // it'd help. Bash-less MCP clients just ignore the extra field.
      if (result.timedOut) {
        payload.hint =
          "If you have shell access, prefer `agentproto sessions wait <id> " +
          "[--until <event>]` instead of polling this tool in a loop — it's " +
          "a scriptable blocking wait with no 49s cap."
      }
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }
    },
  )

  // ── inbound_watcher_start ────────────────────────────────────────
  if (inboundWatcher) {
    server.tool(
      "inbound_watcher_start",
      "Start a background poller that watches an agentpush source for new inbound " +
        "messages and spawns one agent per contact_ref. The agent receives the " +
        "inbound events inline via the prompt template. Returns a watcherId you " +
        "can pass to inbound_watcher_stop or inbound_watcher_list.",
      {
        alias: z
          .string()
          .min(1)
          .describe(
            "Imported MCP alias for the agentpush server (e.g. 'agentpush'). " +
              "Import it first with mcp_import.",
          ),
        source: z
          .string()
          .min(1)
          .describe(
            "Contact ref / channel to poll — forwarded as `source` to poll_inbound " +
              "(e.g. a phone number '+33612345678' or a webhook channel name).",
          ),
        adapter: z
          .string()
          .min(1)
          .describe(
            "Agent adapter slug to spawn when new messages arrive (e.g. 'claude-code').",
          ),
        promptTemplate: z
          .string()
          .min(1)
          .describe(
            "Prompt sent to the spawned agent. Placeholders: " +
              "{{source}} (watched source), {{contact_ref}} (sender), " +
              "{{messages_json}} (JSON array of new events), {{count}} (message count).",
          ),
        pollIntervalMs: z
          .number()
          .int()
          .min(1_000)
          .max(60_000)
          .optional()
          .describe("Poll interval in ms. Default 5 000."),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory for spawned agents. Defaults to the daemon's cwd.",
          ),
        label: z
          .string()
          .optional()
          .describe("Optional label suffix on spawned session names."),
        mcpServersForChild: jsonTolerant(
          z.array(
            z.object({
              name: z.string(),
              transport: z.enum(["stdio", "http", "sse"]),
              ref: z.string().optional(),
            }),
          ),
        )
          .optional()
          .describe(
            "MCP servers to mount in each spawned agent. Pass the agentpush entry " +
              "here (e.g. [{name:'agentpush',transport:'http',ref:'http://localhost:8080/mcp'}]) " +
              "so the agent can call dispatch_request to reply.",
          ),
        mode: z
          .enum(["spawn", "route", "route-or-spawn"])
          .optional()
          .describe(
            "Routing mode for new inbound messages. \"spawn\" (default) always " +
              "spawns a fresh agent. \"route\" delivers into an already-bound " +
              "session (resurrecting it if dead) and skips unbound contacts. " +
              "\"route-or-spawn\" routes bound contacts and spawns unbound ones.",
          ),
      },
      async input => {
        const desc = inboundWatcher.start(input)
        return { content: [{ type: "text", text: JSON.stringify(desc, null, 2) }] }
      },
    )

    server.tool(
      "inbound_watcher_stop",
      "Stop a running inbound watcher. The watcher's cursor position is preserved " +
        "in memory (and flushed to disk on daemon shutdown) so a new watcher " +
        "started later can pick up where it left off.",
      {
        watcherId: z
          .string()
          .min(1)
          .describe("Watcher id returned by inbound_watcher_start."),
      },
      async input => {
        const ok = inboundWatcher.stop(input.watcherId)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                ok
                  ? { ok: true, watcherId: input.watcherId, status: "stopped" }
                  : {
                      ok: false,
                      error: `watcher "${input.watcherId}" not found`,
                    },
                null,
                2,
              ),
            },
          ],
          ...(ok ? {} : { isError: true }),
        }
      },
    )

    server.tool(
      "inbound_watcher_list",
      "List all inbound watchers (running and stopped) with their cursor position, " +
        "last poll time, last fire time, and total spawned session count.",
      {},
      async () => {
        const watchers = inboundWatcher.list()
        return { content: [{ type: "text", text: JSON.stringify(watchers, null, 2) }] }
      },
    )
  }

  // ── transmit_message ────────────────────────────────────────────
  // Only registered when BOTH mcpProxy and bindingStore are wired (mirrors
  // the inboundWatcher guard above).
  if (mcpProxy && bindingStore) {
    server.tool(
      "transmit_message",
      "Send a message out through an imported agentpush MCP alias (via its " +
        "dispatch_request tool) and, by default, bind the contact to a session " +
        "so future inbound replies from them route into it (mode " +
        "\"route-or-spawn\") instead of spawning a fresh agent.",
      {
        alias: z
          .string()
          .min(1)
          .describe("Imported MCP alias for the agentpush server (e.g. 'agentpush')."),
        source: z
          .string()
          .min(1)
          .describe("Channel/phone the message is sent from — same `source` shape as poll_inbound."),
        contact_ref: z
          .string()
          .min(1)
          .describe("Recipient contact_ref (agentpush sender id)."),
        text: z.string().min(1).describe("Message text to send."),
        sessionId: z
          .string()
          .min(1)
          .describe("Session to bind as the reply target for this contact. Required for bind."),
        bind: z
          .boolean()
          .optional()
          .describe(
            "Upsert a contactRef→sessionId binding (mode \"route-or-spawn\") after a " +
              "successful send. Default true.",
          ),
      },
      async input => {
        const out = await mcpProxy.callTool(input.alias, "dispatch_request", {
          source: input.source,
          contact_ref: input.contact_ref,
          text: input.text,
        })

        if (!out.ok) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ sent: false, bound: false, error: out.error }) },
            ],
            isError: true,
          }
        }

        const bound = input.bind !== false
        if (bound) {
          bindingStore.upsert({
            alias: input.alias,
            source: input.source,
            contactRef: input.contact_ref,
            sessionId: input.sessionId,
            mode: "route-or-spawn",
          })
        }

        return { content: [{ type: "text", text: JSON.stringify({ sent: true, bound }) }] }
      },
    )
  }

  // ── inbound_endpoint_* ──────────────────────────────────────────
  // Registered when endpointStore is wired (mirrors transmit_message guard).
  if (endpointStore) {
    const inboundProviderSchema = z.enum(["agentpush", "telegram", "whatsapp", "slack", "generic", "native"])
    const inboundModeSchema = z.enum(["spawn", "route", "route-or-spawn"]).optional()

    server.tool(
      "inbound_endpoint_create",
      "Create or update a provider-agnostic inbound push endpoint. POSTs to " +
        "`/inbound/<slug>` are normalized from the provider's webhook dialect and " +
        "signature-verified (when a secret is configured).",
      {
        slug: z.string().min(1).describe("URL path segment: POST /inbound/<slug>."),
        provider: inboundProviderSchema.describe("Inbound webhook dialect/provider."),
        alias: z.string().min(1).describe("Imported MCP alias — MUST match what transmit_message wrote."),
        source: z.string().optional().describe("Force the binding source; default = provider channel."),
        mode: inboundModeSchema.describe('Routing mode; default "route-or-spawn".'),
        secret: z.string().optional().describe("Webhook signing secret. Omit to auto-generate one."),
        enabled: z.boolean().optional().describe("Whether the endpoint is active; default true."),
      },
      async input => {
        const existing = endpointStore.get(input.slug)
        const generatedSecret =
          input.secret === undefined && !existing?.secret
            ? randomBytes(32).toString("hex")
            : undefined

        const endpoint = endpointStore.upsert({
          slug: input.slug,
          provider: input.provider,
          alias: input.alias,
          source: input.source,
          secret: input.secret ?? generatedSecret ?? existing?.secret,
          mode: input.mode,
          enabled: input.enabled,
          createdTs: existing?.createdTs,
        })

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                slug: endpoint.slug,
                provider: endpoint.provider,
                alias: endpoint.alias,
                source: endpoint.source,
                mode: endpoint.mode,
                enabled: endpoint.enabled,
                has_secret: !!endpoint.secret,
                ...(generatedSecret ? { secret: generatedSecret } : {}),
              }),
            },
          ],
        }
      },
    )

    server.tool(
      "inbound_endpoint_list",
      "List all provider-agnostic inbound push endpoints. Secrets are never emitted.",
      {},
      async () => {
        const list = endpointStore.list().map(e => ({
          slug: e.slug,
          provider: e.provider,
          alias: e.alias,
          source: e.source,
          mode: e.mode,
          enabled: e.enabled,
          createdTs: e.createdTs,
          lastSeenTs: e.lastSeenTs,
          has_secret: !!e.secret,
        }))
        return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] }
      },
    )

    server.tool(
      "inbound_endpoint_delete",
      "Delete a provider-agnostic inbound push endpoint by slug.",
      {
        slug: z.string().min(1).describe("URL path segment of the endpoint to delete."),
      },
      async input => {
        const existed = endpointStore.remove(input.slug)
        return {
          content: [{ type: "text", text: JSON.stringify({ deleted: existed }) }],
        }
      },
    )
  }

  // ── Cron scheduler tools (optional — only registered when cronScheduler is provided) ──
  // NOT in DEFAULT_ORCHESTRATOR_TOOLS: installing host-level recurring jobs is a
  // materially bigger privilege than session/policy tools. Opt-in only via explicit
  // orchestrator.tools allowlist.
  const { cronScheduler } = opts
  if (cronScheduler) {
    const cronActionSchema = z.union([
      z.object({
        kind: z.literal("command"),
        command: z.string().min(1).describe("Executable basename (must be allowlisted in .agentproto/allowed-commands.json)."),
        args: z.array(z.string()).optional().describe("Argv array passed verbatim."),
        cwd: z.string().optional().describe("Working directory. Defaults to workspace root."),
        timeoutMs: z.number().int().positive().optional().describe("Hard kill timeout in ms. Default 60 000."),
      }),
      z.object({
        kind: z.literal("agent"),
        adapter: z.string().min(1).describe("Agent adapter slug (e.g. 'claude-code', 'hermes')."),
        prompt: z.string().min(1).describe("Prompt to send to the spawned agent."),
        cwd: z.string().optional().describe("Working directory for the spawned session."),
        model: z.string().optional().describe("Optional model identifier forwarded to the adapter."),
        mode: z.string().optional().describe("AIP-45 mode id forwarded to the adapter, e.g. 'bypass-permissions', 'plan'."),
        permissionHold: z.boolean().optional().describe("Start the spawned session in permission-hold (inbox) mode."),
        options: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional().describe("Manifest-declared option id → value map forwarded to the adapter."),
      }),
      z.object({
        kind: z.literal("prompt-session"),
        sessionId: z.string().min(1).describe(
          "Id of an existing, already-running session (from agent_start or agent_sessions_list) to re-prompt.",
        ),
        prompt: z.string().min(1).describe("Prompt to send to the existing session."),
      }),
    ])

    server.tool(
      "cron_create",
      "Schedule a recurring or one-shot cron job on the daemon. " +
        "Accepts a 5-field cron expression (minute hour day-of-month month day-of-week, local time) " +
        "and a command, agent-spawn, or session-reprompt action. " +
        "Returns the created job id and nextRunAt. " +
        "WARNING: this installs a persistent host-level job that survives daemon restarts.",
      {
        schedule: z.string().min(1).describe(
          "5-field cron expression in local time. e.g. '0 9 * * 1-5' (weekdays at 9am). " +
          "Fields: minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-7,0=Sun).",
        ),
        recurring: z.boolean().optional().describe(
          "When false, fires once then deactivates. Default true.",
        ),
        label: z.string().optional().describe("Human-readable label for the job."),
        action: cronActionSchema.describe(
          "What to do when the job fires. 'command' runs an allowlisted shell command; " +
          "'agent' spawns a brand-new agent session; 'prompt-session' re-prompts an " +
          "existing, already-running session in place (for durable check-in jobs).",
        ),
      },
      async input => {
        try {
          const job = cronScheduler.create({
            label: input.label,
            schedule: input.schedule,
            recurring: input.recurring ?? true,
            action: input.action,
          })
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId: job.id,
                  schedule: job.schedule,
                  recurring: job.recurring,
                  nextRunAt: job.nextRunAt,
                  active: job.active,
                }),
              },
            ],
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              },
            ],
            isError: true,
          }
        }
      },
    )

    server.tool(
      "cron_list",
      "List all cron jobs (active and inactive) with their schedule, last result, and next fire time.",
      {},
      async () => {
        const jobs = cronScheduler.list()
        return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }] }
      },
    )

    server.tool(
      "cron_delete",
      "Permanently remove a cron job. Throws if the job is not found.",
      {
        jobId: z.string().min(1).describe("Job id returned by cron_create or cron_list."),
      },
      async input => {
        try {
          cronScheduler.delete(input.jobId)
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, jobId: input.jobId }) }] }
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              },
            ],
            isError: true,
          }
        }
      },
    )

    server.tool(
      "cron_run",
      "Manually fire a cron job immediately, bypassing its schedule. " +
        "Useful for testing and debugging. Returns the job's lastResult.",
      {
        jobId: z.string().min(1).describe("Job id returned by cron_create or cron_list."),
      },
      async input => {
        try {
          const result = await cronScheduler.run(input.jobId)
          return { content: [{ type: "text", text: JSON.stringify({ jobId: input.jobId, result }) }] }
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              },
            ],
            isError: true,
          }
        }
      },
    )
  }

  // ── AIP-41 routine trigger (optional — only registered when routineRegistrar is provided) ──
  // Mirrors `cron_run`: fires a `.routines/<id>/ROUTINE.md` routine's target
  // immediately, bypassing both its schedule and its `enabled` flag, without
  // requiring `reconcile()` to have registered a cron job for it first.
  const { routineRegistrar } = opts
  if (routineRegistrar) {
    server.tool(
      "routine_list",
      "List all AIP-41 routine DEFINITIONS known from `.routines/*` (id, " +
        "schedule, target, enabled). See `workflow_list` / `activities_list` " +
        "for run history.",
      {},
      async () => {
        const routines = routineRegistrar.list()
        return { content: [{ type: "text", text: JSON.stringify(routines, null, 2) }] }
      },
    )

    server.tool(
      "routine_trigger",
      "Fire an AIP-41 routine's target immediately, bypassing its schedule — " +
        "for testing/debugging a `.routines/<id>/ROUTINE.md` manifest without " +
        "waiting for its cron schedule. Works even when the routine is " +
        "`enabled: false` or hasn't been registered as a live cron job yet.",
      {
        routineId: z.string().min(1).describe("The routine's `id` field (matches `.routines/<id>/ROUTINE.md`)."),
      },
      async input => {
        try {
          const result = await routineRegistrar.trigger(input.routineId)
          return { content: [{ type: "text", text: JSON.stringify({ routineId: input.routineId, ...result }) }] }
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              },
            ],
            isError: true,
          }
        }
      },
    )

    // AIP-41 routine reconcile — re-runs the same scan `index.ts` does once
    // at boot, so a `.routines/<id>/ROUTINE.md` dropped (or edited, or
    // removed) after the daemon started gets its cron job registered,
    // updated, or torn down WITHOUT a restart. Installs/removes host cron
    // jobs — same privilege class as `cron_create`/`cron_delete` — so, like
    // `routine_trigger`, this is deliberately NOT in DEFAULT_ORCHESTRATOR_TOOLS.
    server.tool(
      "routine_reconcile",
      "Re-scan `.routines/*/ROUTINE.md` and register/update/remove live cron " +
        "jobs to match — the same pass `index.ts` runs once at boot, callable " +
        "on demand so a newly-dropped or edited routine schedules without a " +
        "daemon restart. Safe to call repeatedly (idempotent when nothing " +
        "changed).",
      {},
      async () => {
        try {
          const result = routineRegistrar.reconcile()
          return { content: [{ type: "text", text: JSON.stringify(result) }] }
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              },
            ],
            isError: true,
          }
        }
      },
    )
  }
}
