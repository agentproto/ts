/**
 * MCP tools for event-driven orchestration:
 *   - poll_events   — cheap cursor-based snapshot of session events
 *   - wait_for_any  — multiplexed long-poll (1 call for N sessions)
 *
 * These complement the existing per-session waitForTurnEnd inside
 * get_agent_session_output. The new tools handle multi-session fan-in
 * and external-client retrigger without burning polling tokens.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus, SessionEventType } from "./session-event-bus.js"
import type { EventRing } from "./event-ring.js"
import type { RoutineRunner } from "./routine-runner.js"
import type { CompletionPolicySupervisor, AttachPolicyInput } from "./supervisor.js"
import { withToolSubset } from "./tool-subset.js"
import { jsonTolerant } from "./json-tolerant.js"

/**
 * Zod schema for the `gate` field of `attach_policy`.
 * Exported so tests can validate the schema directly.
 *
 * Union of two variants:
 *   • shell  — `{ command, args?, cwd?, timeoutMs? }`
 *   • judge  — `{ judge: { adapter, model?, prompt, timeoutMs? } }` (WP7)
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
])

export interface RegisterOrchestrationToolsOptions {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  eventRing: EventRing
  routineRunner?: RoutineRunner
  supervisor?: CompletionPolicySupervisor
  /** Optional allowlist — when set, only tools whose name is in the
   *  set are registered (the scoped orchestrator sub-gateway, WP2).
   *  Omitted → register everything, today's behaviour. */
  toolSubset?: ReadonlySet<string>
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
  const { registry, sessionEvents, eventRing } = opts

  // ── poll_events ──────────────────────────────────────────────────
  server.tool(
    "poll_events",
    "Lightweight cursor-based snapshot of session lifecycle events " +
      "(turn-end, awaiting-input, exited). Returns only what changed since " +
      "the last call — cheap, no transcript. Use `wait_for_any` to block " +
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
        .array(z.enum(["turn-end", "awaiting-input", "exited", "command-done", "policy:passed", "policy:failed", "policy:commit-ready", "policy:committed"]))
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

  // ── Routine tools (optional — only registered when routineRunner is provided) ─
  const { routineRunner } = opts
  if (routineRunner) {
    server.tool(
      "start_routine",
      "Start a routine — a named sequence of steps that spawn agent sessions " +
        "and fan-in on their turn-end events. Returns a runId immediately; " +
        "the routine executes in the background. Poll with `get_routine_status`.",
      {
        routineId: z.string().describe("Arbitrary label for this routine type (e.g. 'daily-brief')."),
        steps: z
          .array(
            z.object({
              label: z.string(),
              adapter: z.string().optional().describe("Agent adapter slug to spawn."),
              prompt: z.string().optional().describe("Prompt to send after spawning."),
              waitFor: z
                .array(z.string())
                .optional()
                .describe("Session ids that must fire turn-end before this step runs."),
              policy: z
                .discriminatedUnion("awaiting", [
                  z.object({
                    awaiting: z.literal("auto-allow"),
                    prompt: z.string(),
                  }),
                  z.object({
                    awaiting: z.literal("escalate"),
                    webhookUrl: z.string().url().optional(),
                    timeoutMs: z.number().int().positive().optional(),
                  }),
                  z.object({ awaiting: z.literal("fail") }),
                ])
                .optional()
                .describe("What to do when a session asks for input mid-step."),
            }),
          )
          .min(1)
          .max(50)
          .describe("Ordered list of steps. Steps with `waitFor` block until those sessions finish."),
        workspaceSlug: z
          .string()
          .optional()
          .describe("Workspace slug passed to each spawned session."),
        cwd: z.string().optional().describe("Working directory for spawned sessions."),
        notifyUrl: z
          .string()
          .url()
          .optional()
          .describe("Webhook URL to call on run completion or escalation."),
      },
      async input => {
        const run = await routineRunner.start(input)
        return {
          content: [{ type: "text", text: JSON.stringify({ runId: run.runId, status: run.status }, null, 2) }],
        }
      },
    )

    server.tool(
      "get_routine_status",
      "Poll the status of a background routine run started with `start_routine`.",
      {
        runId: z.string().describe("Run id returned by `start_routine`."),
      },
      async input => {
        const run = routineRunner.status(input.runId)
        if (!run) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "run not found", runId: input.runId }) }],
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(run, null, 2) }] }
      },
    )

    server.tool(
      "cancel_routine",
      "Cancel a running routine. Steps already in flight will finish, but no " +
        "new steps will be started.",
      {
        runId: z.string().describe("Run id to cancel."),
      },
      async input => {
        routineRunner.cancel(input.runId)
        const run = routineRunner.status(input.runId)
        return { content: [{ type: "text", text: JSON.stringify({ runId: input.runId, status: run?.status ?? "not_found" }) }] }
      },
    )

    server.tool(
      "resolve_routine_escalation",
      "Provide an external answer to a routine step that escalated because a " +
        "session asked for human input (policy=escalate).",
      {
        runId: z.string().describe("Run id."),
        stepIndex: z.number().int().min(0).describe("Step index to resolve (0-based)."),
        response: z.string().describe("The answer to inject into the awaiting session."),
      },
      async input => {
        routineRunner.resolve(input.runId, input.stepIndex, input.response)
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }
      },
    )

    server.tool(
      "list_routines",
      "List all routine runs (running, done, failed, cancelled).",
      {},
      async () => {
        const runs = routineRunner.list()
        return { content: [{ type: "text", text: JSON.stringify(runs, null, 2) }] }
      },
    )
  }

  // ── Supervisor tools (optional — only registered when supervisor is provided) ─
  const { supervisor } = opts
  if (supervisor) {
    // Base shape of a completion policy (shared by attach_policy and, via
    // z.lazy, the recursive `next` DAG chain — WP6).
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
                "ack_policy(approve:true). When false, commits directly. " +
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
      "attach_policy",
      "Attach a completion policy to a running session (or a fan-in group). When " +
        "the watched session emits turn-end — or, for a group, once EVERY member " +
        "has finished its turn — an optional shell gate runs (exit 0 = pass). The " +
        "result is emitted as `policy:passed` or `policy:failed` on the event bus " +
        "(readable via poll_events). A policy may declare `next` to chain another " +
        "policy when it completes (WP6 DAG). Returns the policyId immediately.",
      {
        ...policyShapeBase,
        ...nextField,
      },
      async input => {
        if (!input.sessionId && !(input.sessionIds && input.sessionIds.length > 0)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "attach_policy requires sessionId or a non-empty sessionIds" }),
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
      "get_policy_status",
      "Get the current status of a completion policy attached with `attach_policy`.",
      {
        policyId: z.string().describe("Policy id returned by `attach_policy`."),
      },
      async input => {
        const state = supervisor.getStatus(input.policyId)
        if (!state) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "policy not found", policyId: input.policyId }) }],
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] }
      },
    )

    server.tool(
      "cancel_policy",
      "Cancel a watching or gating completion policy. No-op on done/blocked policies.",
      {
        policyId: z.string().describe("Policy id to cancel."),
      },
      async input => {
        supervisor.cancel(input.policyId)
        const state = supervisor.getStatus(input.policyId)
        return {
          content: [{ type: "text", text: JSON.stringify({ policyId: input.policyId, status: state?.status ?? "not_found" }) }],
        }
      },
    )

    server.tool(
      "ack_policy",
      "Acknowledge a `then:\"commit\"` policy parked in `awaiting-ack` (WP5). " +
        "`approve:true` runs the prepared host commit (git add <paths> + git " +
        "commit; never -A/push/--force) → emits policy:committed (+sha) → done. " +
        "`approve:false` cancels it (no commit). No-op on any other state.",
      {
        policyId: z.string().describe("Policy id returned by `attach_policy`."),
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

    server.tool(
      "list_policies",
      "List all completion policies (watching, gating, done, blocked, cancelled).",
      {},
      async () => {
        const policies = supervisor.list()
        return { content: [{ type: "text", text: JSON.stringify(policies, null, 2) }] }
      },
    )
  }

  // ── wait_for_any ─────────────────────────────────────────────────
  server.tool(
    "wait_for_any",
    "Multiplexed long-poll: block until ANY of the listed sessions fires a " +
      "lifecycle event. Returns immediately when a session is already in the " +
      "target state. Eliminates polling in multi-session fan-in orchestration — " +
      "one call replaces N concurrent waitForTurnEnd calls.",
    {
      sessionIds: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe("Session ids (or names) to watch. Returns on the first hit."),
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
    },
    async input => {
      const timeout = input.timeoutMs ?? 25_000
      const targetEvent = input.event ?? "any"

      // Resolve id-or-name → canonical id
      const resolvedIds = input.sessionIds.map(q => {
        const desc = registry.findByIdOrName(q)
        return desc?.id ?? q
      })

      // Synchronous check: return immediately if a session is already done
      for (const sid of resolvedIds) {
        const desc = registry.get(sid)
        if (!desc) continue
        if (
          desc.awaitingInput &&
          (targetEvent === "any" || targetEvent === "turn-end" || targetEvent === "awaiting-input")
        ) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sessionId: sid,
                  event: "awaiting-input",
                  awaitingInput: true,
                  status: desc.status,
                }),
              },
            ],
          }
        }
        const terminal = desc.status === "exited" || desc.status === "killed" || desc.status === "error"
        if (terminal && (targetEvent === "any" || targetEvent === "exited")) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sessionId: sid,
                  event: "exited",
                  awaitingInput: false,
                  status: desc.status,
                }),
              },
            ],
          }
        }
      }

      // Long-poll: subscribe to bus, resolve on first matching event
      return new Promise(resolve => {
        const unsubs: Array<() => void> = []
        let settled = false

        const finish = (result: unknown): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          for (const u of unsubs) u()
          resolve({
            content: [{ type: "text", text: JSON.stringify(result) }],
          })
        }

        // Which event types to watch
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
              if (!idSet.has(ev.sessionId)) return
              const desc = registry.get(ev.sessionId)
              finish({
                sessionId: ev.sessionId,
                event: ev.type.replace("session:", ""),
                awaitingInput: desc?.awaitingInput ?? false,
                status: desc?.status ?? "unknown",
              })
            }),
          )
        }

        const timer = setTimeout(() => {
          finish({ timedOut: true, sessionIds: resolvedIds })
        }, timeout)
      })
    },
  )
}
