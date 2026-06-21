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
import type { CompletionPolicySupervisor } from "./supervisor.js"

export interface RegisterOrchestrationToolsOptions {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  eventRing: EventRing
  routineRunner?: RoutineRunner
  supervisor?: CompletionPolicySupervisor
}

export function registerOrchestrationTools(
  server: McpServer,
  opts: RegisterOrchestrationToolsOptions,
): void {
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
        .array(z.enum(["turn-end", "awaiting-input", "exited", "command-done", "policy:passed", "policy:failed"]))
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
    server.tool(
      "attach_policy",
      "Attach a completion policy to a running session (or a fan-in group). When " +
        "the watched session emits turn-end — or, for a group, once EVERY member " +
        "has finished its turn — an optional shell gate runs (exit 0 = pass). The " +
        "result is emitted as `policy:passed` or `policy:failed` on the event bus " +
        "(readable via poll_events). Returns the policyId immediately.",
      {
        sessionId: z
          .string()
          .optional()
          .describe(
            "Session id to watch (single-session form). Provide this OR " +
              "`sessionIds`. Equivalent to `sessionIds: [sessionId]`.",
          ),
        sessionIds: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            "Fan-in group: the gate runs once, only after EVERY listed session " +
              "has finished its turn (turn-end or exit). Supersedes `sessionId`.",
          ),
        gate: z
          .object({
            command: z.string().min(1).describe("Gate command basename (must be allowlisted)."),
            args: z.array(z.string()).optional().describe("Argv passed verbatim."),
            cwd: z
              .string()
              .optional()
              .describe("Working directory for the gate. Defaults to the session's cwd."),
            timeoutMs: z.number().int().positive().optional().describe("Gate timeout in ms. Default 60 000."),
          })
          .optional()
          .describe("Shell gate. Absent → always passes immediately after turn-end."),
        then: z
          .literal("emit")
          .describe("Action to take after the gate. Only 'emit' is supported in WP1/WP2."),
        onFail: z
          .object({
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
          })
          .optional()
          .describe(
            "What to do when the gate fails (WP2). Absent → immediately blocked. " +
              "Present → re-prompt the session up to maxRetries times then block. " +
              "The session must still be running to receive a nudge.",
          ),
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
        const state = supervisor.attach({
          sessionId: input.sessionId,
          sessionIds: input.sessionIds,
          gate: input.gate,
          then: input.then,
          onFail: input.onFail,
        })
        return {
          content: [{ type: "text", text: JSON.stringify({ policyId: state.policyId, status: state.status }, null, 2) }],
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
