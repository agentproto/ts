/**
 * MCP tools over the Task ledger (`task-ledger.ts`):
 *   task_create / task_list / task_claim / task_update
 *
 * Registered from `registerOrchestrationTools` and listed in
 * `DEFAULT_ORCHESTRATOR_TOOLS` — tasks are exactly what spawned children
 * SHOULD touch. Like the policy tools, the four names are registered
 * UNCONDITIONALLY (a tool declared in a scope's subset but not registered
 * on the server hangs the MCP handshake — empirically verified); when no
 * ledger is wired the handlers answer a structured error instead.
 *
 * Caller identity drives ACL + the default board: a scoped child arrives
 * with `callerScope.ownerSessionId` (the same identity the policy tools
 * scope on) → a `{kind:"session"}` caller whose default board is its
 * lineage's `tree:<root>`; the root `/mcp` endpoint has no scope → the
 * operator, whose default board is `ws:<workspaceSlug>`. An unbound scope
 * (token minted, owner not yet bound) can act as nobody — same refusal as
 * `policy_attach`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { gateInputSchema } from "./orchestration-tools.js"
import { jsonTolerant } from "./json-tolerant.js"
import { withToolSubset } from "./tool-subset.js"
import { TASK_STATUSES } from "./task-ledger.js"
import type {
  TaskCaller,
  TaskLedger,
  TaskWriteResult,
} from "./task-ledger.js"

export interface RegisterTaskToolsOptions {
  /** The ledger. Absent → the tools register but answer a structured
   *  "task ledger not available" error (handshake-safe). */
  ledger?: TaskLedger
  /** The calling orchestrator's scope, when the tools are being mounted on
   *  the scoped sub-gateway. Same shape the policy tools take. */
  callerScope?: { ownerSessionId?: string }
  /** Optional allowlist — same semantics as the other register passes. */
  toolSubset?: ReadonlySet<string>
}

/** JSON-in-a-text-block reply, the house shape for these tool families. */
function jsonContent(payload: unknown): {
  content: Array<{ type: "text"; text: string }>
} {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }
}

/** Render a ledger write result onto the tool reply. A rev-CAS conflict is
 *  a FIRST-CLASS reply (`{conflict:true, current}`) — the caller rebases
 *  off `current`, it isn't a tool error. */
function writeResultContent(result: TaskWriteResult): {
  content: Array<{ type: "text"; text: string }>
} {
  if (result.ok) {
    return jsonContent({
      task: result.task,
      ...(result.verifying ? { verifying: true } : {}),
    })
  }
  if (result.conflict) {
    return jsonContent({ conflict: true, current: result.current })
  }
  return jsonContent({ error: result.error })
}

export function registerTaskTools(
  rawServer: McpServer,
  opts: RegisterTaskToolsOptions,
): void {
  const server = opts.toolSubset
    ? withToolSubset(rawServer, opts.toolSubset)
    : rawServer
  const { ledger, callerScope } = opts

  /**
   * Resolve the calling identity. Root context (no scope) is the operator;
   * a bound scope is that session; an unbound scope is nobody — the caller
   * gets a clear refusal rather than silently acting as the operator.
   */
  const resolveCaller = (): TaskCaller | { error: string } => {
    if (!callerScope) return { kind: "operator" }
    if (!callerScope.ownerSessionId) {
      return { error: "scope is not yet bound to a session; cannot touch tasks" }
    }
    return { kind: "session", sessionId: callerScope.ownerSessionId }
  }

  const notAvailable = jsonContent({ error: "task ledger not available" })

  // ── task_create ───────────────────────────────────────────────────
  server.tool(
    "task_create",
    "Create a task on the caller's board — declared intent, not a run. " +
      "Default board: a daemon session's lineage board (`tree:<root>`, shared " +
      "with its supervisor and siblings); the operator's workspace board " +
      "(`ws:<slug>`). Pass `boardId` to override (e.g. one shared board for " +
      "children spawned from a client). Leave `owner` absent for a claimable " +
      "task; pass \"self\" to keep it for yourself. Declare `verify` to make " +
      "done GATED: a done report then runs the gate (shell exit 0 / judge " +
      "PASS) before the task closes.",
    {
      title: z.string().min(1).describe("One-line imperative title."),
      description: z.string().optional().describe("Longer context for whoever claims it."),
      boardId: z
        .string()
        .optional()
        .describe("Explicit board. Omit → the caller's default board."),
      owner: z
        .string()
        .optional()
        .describe(
          "Pre-assign: a sessionId, \"human\", \"operator\", or \"self\" " +
            "(the calling session). Omit → claimable by anyone on the board.",
        ),
      blockedBy: jsonTolerant(z.array(z.string()))
        .optional()
        .describe("Task ids this depends on. INFORMATIONAL in v1 — nothing schedules off it."),
      verify: jsonTolerant(gateInputSchema)
        .optional()
        .describe(
          "Opt-in done-gate (same shape as policy_attach's `gate`): shell " +
            "command (exit 0 = pass) or judge agent. With it, `status:\"done\"` " +
            "only lands after the gate passes.",
        ),
      meta: jsonTolerant(z.record(z.string(), z.string()))
        .optional()
        .describe("Free-form provenance (prUrl, worktreePath, actionId, …)."),
    },
    async input => {
      if (!ledger) return notAvailable
      const caller = resolveCaller()
      if ("error" in caller) return jsonContent({ error: caller.error })
      const owner =
        input.owner === "self"
          ? caller.kind === "session"
            ? caller.sessionId
            : "operator"
          : input.owner
      const result = ledger.create(
        {
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
          ...(owner !== undefined ? { owner } : {}),
          ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
          ...(input.verify !== undefined ? { verify: input.verify } : {}),
          ...(input.meta !== undefined ? { meta: input.meta } : {}),
        },
        caller,
      )
      return writeResultContent(result)
    },
  )

  // ── task_list ─────────────────────────────────────────────────────
  server.tool(
    "task_list",
    "List tasks on a board. Defaults to the caller's own board (a session's " +
      "lineage `tree:<root>`; the operator's `ws:<slug>`) and to OPEN tasks — " +
      "pass `includeClosed` (or a closed `status` filter) for " +
      "done/failed/cancelled. Every record carries its `rev` (needed by " +
      "task_claim/task_update) and, on done, a `verification` stamp saying " +
      "HOW it was closed (self-report vs gate vs human) — read it verbatim.",
    {
      boardId: z
        .string()
        .optional()
        .describe("Board to list. Omit → the caller's default board."),
      status: z.enum(TASK_STATUSES).optional().describe("Filter to one status."),
      includeClosed: z
        .boolean()
        .optional()
        .describe("Include done/failed/cancelled. Default false."),
    },
    async input => {
      if (!ledger) return notAvailable
      const caller = resolveCaller()
      if ("error" in caller) return jsonContent({ error: caller.error })
      const tasks = ledger.list(
        {
          ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.includeClosed !== undefined
            ? { includeClosed: input.includeClosed }
            : {}),
        },
        caller,
      )
      return jsonContent({
        boardId: ledger.resolveBoardId(caller, input.boardId),
        tasks,
      })
    },
  )

  // ── task_claim ────────────────────────────────────────────────────
  server.tool(
    "task_claim",
    "Claim a claimable task — the CAS verb. Succeeds only if the task is " +
      "pending, has NO owner, and `rev` matches; you become the owner and the " +
      "task flips to in_progress. A lost race answers `{conflict:true, " +
      "current}` — re-read `current` and pick another task (or retry with its " +
      "rev) instead of assuming the claim landed. Claim BEFORE working; " +
      "update when done.",
    {
      taskId: z.string().describe("Task id from task_list / task_create."),
      rev: z
        .number()
        .int()
        .min(0)
        .describe("The rev you last read. A mismatch means someone moved first."),
    },
    async input => {
      if (!ledger) return notAvailable
      const caller = resolveCaller()
      if ("error" in caller) return jsonContent({ error: caller.error })
      return writeResultContent(
        ledger.claim({ taskId: input.taskId, rev: input.rev }, caller),
      )
    },
  )

  // ── task_update ───────────────────────────────────────────────────
  server.tool(
    "task_update",
    "Update a task (rev-CAS: pass the rev you last read; a mismatch answers " +
      "`{conflict:true, current}`). The OWNER sets status " +
      "(in_progress/done/failed) and releases itself (`owner:null`); the " +
      "CREATOR/operator additionally edit fields, reassign `owner`, cancel, " +
      "and reopen a done task (`status:\"pending\"`). `status:\"done\"` on a " +
      "task with a declared `verify` does NOT close it immediately — the " +
      "reply says `verifying:true` and the gate decides after your turn ends " +
      "(green → done, red → stays in_progress with `lastVerifyError`; watch " +
      "`task:changed`). `evidence:{policyId}` closes it off an " +
      "already-passed policy without re-running anything.",
    {
      taskId: z.string().describe("Task id from task_list / task_create."),
      rev: z.number().int().min(0).describe("The rev you last read."),
      status: z
        .enum(TASK_STATUSES)
        .optional()
        .describe(
          "Target status. pending ⇄ in_progress → done|failed; " +
            "pending|in_progress → cancelled; done → pending is the explicit " +
            "reopen (creator/operator).",
        ),
      title: z.string().optional().describe("New title (creator/operator)."),
      description: z.string().optional().describe("New description (creator/operator)."),
      blockedBy: jsonTolerant(z.array(z.string()))
        .optional()
        .describe("Replace the informational dependency list (creator/operator)."),
      owner: z
        .union([z.string(), z.null()])
        .optional()
        .describe(
          "Reassign (a sessionId / \"human\" / \"operator\" — creator/operator) " +
            "or release with null (the owner itself, or creator/operator).",
        ),
      evidence: jsonTolerant(z.object({ policyId: z.string().min(1) }))
        .optional()
        .describe(
          "With status:\"done\": an already-PASSED completion policy standing " +
            "in for the gate — stamped verbatim, nothing re-runs.",
        ),
      note: z
        .string()
        .optional()
        .describe("Free-text note, stamped into meta.note (last-write-wins)."),
    },
    async input => {
      if (!ledger) return notAvailable
      const caller = resolveCaller()
      if ("error" in caller) return jsonContent({ error: caller.error })
      return writeResultContent(
        ledger.update(
          {
            taskId: input.taskId,
            rev: input.rev,
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
            ...(input.owner !== undefined ? { owner: input.owner } : {}),
            ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
          },
          caller,
        ),
      )
    },
  )
}
